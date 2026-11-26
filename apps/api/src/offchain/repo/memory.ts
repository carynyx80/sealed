import { randomUUID } from "node:crypto";
import {
  accountKeyString,
  mayGoNegative,
  type AccountFilter,
  type AccountKey,
  type AccountRow,
  type BidRow,
  type EntryRow,
  type InvariantReport,
  type LaunchRow,
  type OffchainRepo,
  type OffchainStatus,
  type PositionRow,
  type RepoTx,
  type SniperRow,
  type TxFilter,
  type TxRow,
} from "./types.js";

interface State {
  accounts: Map<string, AccountRow>; // by key
  accountsById: Map<string, string>; // id → key
  txs: TxRow[];
  txByKey: Map<string, number>; // idempotencyKey → index in txs
  entries: EntryRow[];
  launches: Map<string, LaunchRow>;
  bids: Map<string, BidRow>; // `${launchId}|${bidder}`
  positions: Map<string, PositionRow>;
  snipers: Map<string, SniperRow>;
}

const emptyState = (): State => ({
  accounts: new Map(),
  accountsById: new Map(),
  txs: [],
  txByKey: new Map(),
  entries: [],
  launches: new Map(),
  bids: new Map(),
  positions: new Map(),
  snipers: new Map(),
});

/** Copy-on-write clone: rows are immutable-by-convention (replaced, never mutated in place). */
function cloneState(s: State): State {
  return {
    accounts: new Map(s.accounts),
    accountsById: new Map(s.accountsById),
    txs: [...s.txs],
    txByKey: new Map(s.txByKey),
    entries: [...s.entries],
    launches: new Map(s.launches),
    bids: new Map(s.bids),
    positions: new Map(s.positions),
    snipers: new Map(s.snipers),
  };
}

const copy = <T extends object>(v: T): T => ({ ...v });

class MemoryView implements RepoTx {
  constructor(private s: () => State, private writable: boolean) {}
  private w(): State {
    if (!this.writable) throw new Error("memory repo: write outside transaction");
    return this.s();
  }

  async findTx(key: string) {
    const i = this.s().txByKey.get(key);
    return i === undefined ? null : copy(this.s().txs[i]!);
  }
  async txEntries(txId: string) {
    return this.s().entries.filter((e) => e.txId === txId).map(copy);
  }
  async lockAccounts(keys: AccountKey[]) {
    const st = this.w();
    return keys.map((k) => {
      const key = accountKeyString(k);
      let a = st.accounts.get(key);
      if (!a) {
        a = { id: randomUUID(), key, owner: k.owner, asset: k.asset, kind: k.kind, balance: 0n };
        st.accounts.set(key, a);
        st.accountsById.set(a.id, key);
      }
      return copy(a);
    });
  }
  async insertTx(tx: Omit<TxRow, "id">, entries: Omit<EntryRow, "txId">[]) {
    const st = this.w();
    if (st.txByKey.has(tx.idempotencyKey)) throw Object.assign(new Error("unique violation: idempotencyKey"), { code: "P2002" });
    const row: TxRow = { ...tx, id: randomUUID(), meta: structuredClone(tx.meta) };
    st.txByKey.set(row.idempotencyKey, st.txs.length);
    st.txs.push(row);
    for (const e of entries) st.entries.push({ ...e, txId: row.id });
    return copy(row);
  }
  async setBalance(accountId: string, balance: bigint) {
    const st = this.w();
    const key = st.accountsById.get(accountId);
    const a = key ? st.accounts.get(key) : undefined;
    if (!a) throw new Error("account not found");
    st.accounts.set(a.key, { ...a, balance });
  }
  async getAccount(k: AccountKey) {
    const a = this.s().accounts.get(accountKeyString(k));
    return a ? copy(a) : null;
  }
  async listAccounts(f: AccountFilter) {
    const out: AccountRow[] = [];
    for (const a of this.s().accounts.values()) {
      if (f.owner !== undefined && a.owner !== f.owner) continue;
      if (f.asset !== undefined && a.asset !== f.asset) continue;
      if (f.kind !== undefined && a.kind !== f.kind) continue;
      if (f.kindPrefix !== undefined && !a.kind.startsWith(f.kindPrefix)) continue;
      out.push(copy(a));
    }
    return out;
  }
  async listTxs(f: TxFilter) {
    const out: TxRow[] = [];
    const txs = this.s().txs;
    for (let i = txs.length - 1; i >= 0 && out.length < f.limit; i--) {
      const t = txs[i]!;
      if (f.launchId !== undefined && t.launchId !== f.launchId) continue;
      if (f.kinds && !f.kinds.includes(t.kind)) continue;
      if (f.sinceTs !== undefined && t.createdTs < f.sinceTs) continue;
      out.push({ ...t, meta: structuredClone(t.meta) });
    }
    return out;
  }

  async getLaunch(idOrMint: string) {
    const st = this.s();
    const l = st.launches.get(idOrMint) ?? [...st.launches.values()].find((x) => x.mint === idOrMint);
    return l ? copy(l) : null;
  }
  async insertLaunch(row: LaunchRow) {
    const st = this.w();
    if (st.launches.has(row.id)) throw new Error("launch exists");
    st.launches.set(row.id, copy(row));
  }
  async updateLaunch(id: string, patch: Partial<LaunchRow>) {
    const st = this.w();
    const l = st.launches.get(id);
    if (!l) throw new Error("launch not found");
    st.launches.set(id, { ...l, ...patch });
  }
  async listLaunches(statuses?: OffchainStatus[]) {
    return [...this.s().launches.values()].filter((l) => !statuses || statuses.includes(l.status)).map(copy);
  }

  async getBid(launchId: string, bidder: string) {
    const b = this.s().bids.get(`${launchId}|${bidder}`);
    return b ? copy(b) : null;
  }
  async listBids(launchId: string) {
    return [...this.s().bids.values()].filter((b) => b.launchId === launchId).map(copy);
  }
  async insertBid(row: BidRow) {
    const st = this.w();
    const k = `${row.launchId}|${row.bidder}`;
    if (st.bids.has(k)) throw Object.assign(new Error("unique violation: bid"), { code: "P2002" });
    st.bids.set(k, copy(row));
  }
  async updateBid(id: string, patch: Partial<BidRow>) {
    const st = this.w();
    for (const [k, b] of st.bids) {
      if (b.id === id) {
        st.bids.set(k, { ...b, ...patch });
        return;
      }
    }
    throw new Error("bid not found");
  }

  async getPosition(launchId: string, wallet: string) {
    const p = this.s().positions.get(`${launchId}|${wallet}`);
    return p ? copy(p) : null;
  }
  async upsertPosition(row: PositionRow) {
    this.w().positions.set(`${row.launchId}|${row.wallet}`, copy(row));
  }
  async listPositions(launchId: string) {
    return [...this.s().positions.values()].filter((p) => p.launchId === launchId).map(copy);
  }

  async isSniper(launchId: string, wallet: string) {
    return this.s().snipers.has(`${launchId}|${wallet}`);
  }
  async addSniper(row: SniperRow) {
    const st = this.w();
    const k = `${row.launchId}|${row.wallet}`;
    if (!st.snipers.has(k)) st.snipers.set(k, copy(row));
  }
  async listSnipers(f: { launchId?: string; wallet?: string }) {
    return [...this.s().snipers.values()].filter((r) => (!f.launchId || r.launchId === f.launchId) && (!f.wallet || r.wallet === f.wallet)).map(copy);
  }
}

/**
 * In-memory repo. Transactions are fully serialized by a mutex and run against a copy-on-write working state
 * that replaces the committed state only on success, so a throw anywhere rolls back everything.
 * Allowed for tests / devnet demo only (server refuses mainnet offchain without DATABASE_URL).
 */
export class MemoryRepo implements OffchainRepo {
  readonly kind = "memory" as const;
  private state: State = emptyState();
  private chain: Promise<unknown> = Promise.resolve();
  readonly read: RepoTx = new MemoryView(() => this.state, false);

  async init() {}
  async close() {}

  tx<T>(fn: (t: RepoTx) => Promise<T>): Promise<T> {
    const run = async () => {
      const work = cloneState(this.state);
      const view = new MemoryView(() => work, true);
      const out = await fn(view);
      this.state = work;
      return out;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async checkInvariants(): Promise<InvariantReport> {
    const st = this.state;
    const perTx = new Map<string, bigint>();
    const perAcct = new Map<string, bigint>();
    for (const e of st.entries) {
      const k = `${e.txId}:${e.asset}`;
      perTx.set(k, (perTx.get(k) ?? 0n) + e.amount);
      perAcct.set(e.accountId, (perAcct.get(e.accountId) ?? 0n) + e.amount);
    }
    const unbalancedTxs = [...perTx].filter(([, v]) => v !== 0n).map(([k]) => k);
    const balanceMismatches: string[] = [];
    const negativeBalances: string[] = [];
    for (const a of st.accounts.values()) {
      if ((perAcct.get(a.id) ?? 0n) !== a.balance) balanceMismatches.push(a.key);
      if (a.balance < 0n && !mayGoNegative(a)) negativeBalances.push(a.key);
    }
    return { ok: !unbalancedTxs.length && !balanceMismatches.length && !negativeBalances.length, unbalancedTxs, balanceMismatches, negativeBalances };
  }
}
