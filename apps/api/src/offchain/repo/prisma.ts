import type { Prisma, PrismaClient } from "@prisma/client";
import {
  accountKeyString,
  mayGoNegative,
  type AccountFilter,
  type AccountKey,
  type AccountRow,
  type BidRow,
  type EntryRow,
  type InvariantReport,
  type Json,
  type LaunchRow,
  type OffchainRepo,
  type OffchainStatus,
  type PositionRow,
  type RepoTx,
  type SniperRow,
  type TxFilter,
  type TxRow,
} from "./types.js";

type Client = PrismaClient | Prisma.TransactionClient;
type DecimalLike = { toFixed(dp?: number): string };

const dec = (v: DecimalLike | string | number | bigint): bigint => BigInt(typeof v === "object" ? v.toFixed(0) : String(v));
const decStr = (v: bigint) => v.toString();

type LaunchDb = Awaited<ReturnType<PrismaClient["offchainLaunch"]["findFirst"]>> & object;
type BidDb = Awaited<ReturnType<PrismaClient["offchainBid"]["findFirst"]>> & object;
type PosDb = Awaited<ReturnType<PrismaClient["offchainPosition"]["findFirst"]>> & object;

function launchFromDb(r: LaunchDb): LaunchRow {
  return {
    ...r,
    status: r.status as OffchainStatus,
    graduatedAtMs: r.graduatedAtMs === null ? null : Number(r.graduatedAtMs),
    rewardPerShare: dec(r.rewardPerShare),
  } as unknown as LaunchRow;
}
function launchToDb(p: Partial<LaunchRow>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...p };
  if ("graduatedAtMs" in p) out.graduatedAtMs = p.graduatedAtMs === null || p.graduatedAtMs === undefined ? null : BigInt(p.graduatedAtMs);
  if (p.rewardPerShare !== undefined) out.rewardPerShare = decStr(p.rewardPerShare);
  return out;
}
const bidFromDb = (r: BidDb): BidRow => ({ ...r, sealedReveal: (r.sealedReveal ?? null) as Json | null });
function bidToDb(p: Partial<BidRow>, jsonNull: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...p };
  if ("sealedReveal" in p) out.sealedReveal = p.sealedReveal === null || p.sealedReveal === undefined ? jsonNull : p.sealedReveal;
  return out;
}
const posFromDb = (r: PosDb): PositionRow => ({ ...r, rewardDebt: dec(r.rewardDebt) });

class PrismaView implements RepoTx {
  constructor(private db: Client, private jsonNull: unknown) {}

  async findTx(key: string) {
    const r = await this.db.ledgerTransaction.findUnique({ where: { idempotencyKey: key } });
    return r ? txFromDb(r) : null;
  }
  async txEntries(txId: string) {
    const rows = await this.db.ledgerEntry.findMany({ where: { txId } });
    return rows.map((e) => ({ txId: e.txId, accountId: e.accountId, asset: e.asset, amount: e.amount }));
  }
  async lockAccounts(keys: AccountKey[]) {
    if (!keys.length) return [];
    const data = keys.map((k) => ({ key: accountKeyString(k), owner: k.owner, asset: k.asset, kind: k.kind }));
    await this.db.ledgerAccount.createMany({ data, skipDuplicates: true });
    const ks = data.map((d) => d.key);
    // Row locks, deterministic order (callers pass keys sorted) → no deadlocks between concurrent transfers.
    await this.db.$queryRaw`SELECT id FROM "LedgerAccount" WHERE key = ANY(${ks}::text[]) ORDER BY key FOR UPDATE`;
    const rows = await this.db.ledgerAccount.findMany({ where: { key: { in: ks } } });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return ks.map((k) => {
      const r = byKey.get(k);
      if (!r) throw new Error(`account ${k} missing after upsert`);
      return { id: r.id, key: r.key, owner: r.owner, asset: r.asset, kind: r.kind, balance: r.balance };
    });
  }
  async insertTx(tx: Omit<TxRow, "id">, entries: Omit<EntryRow, "txId">[]) {
    const r = await this.db.ledgerTransaction.create({
      data: {
        idempotencyKey: tx.idempotencyKey,
        kind: tx.kind,
        launchId: tx.launchId,
        meta: tx.meta as Prisma.InputJsonValue,
        createdTs: tx.createdTs,
        entries: { createMany: { data: entries.map((e) => ({ accountId: e.accountId, asset: e.asset, amount: e.amount })) } },
      },
    });
    return txFromDb(r);
  }
  async setBalance(accountId: string, balance: bigint) {
    await this.db.ledgerAccount.update({ where: { id: accountId }, data: { balance } });
  }
  async getAccount(k: AccountKey) {
    const r = await this.db.ledgerAccount.findUnique({ where: { key: accountKeyString(k) } });
    return r ? { id: r.id, key: r.key, owner: r.owner, asset: r.asset, kind: r.kind, balance: r.balance } : null;
  }
  async listAccounts(f: AccountFilter) {
    const rows = await this.db.ledgerAccount.findMany({
      where: { owner: f.owner, asset: f.asset, kind: f.kind ?? (f.kindPrefix ? { startsWith: f.kindPrefix } : undefined) },
    });
    return rows.map((r) => ({ id: r.id, key: r.key, owner: r.owner, asset: r.asset, kind: r.kind, balance: r.balance }));
  }
  async listTxs(f: TxFilter) {
    const rows = await this.db.ledgerTransaction.findMany({
      where: { launchId: f.launchId, kind: f.kinds ? { in: f.kinds } : undefined, createdTs: f.sinceTs !== undefined ? { gte: f.sinceTs } : undefined },
      orderBy: [{ createdTs: "desc" }, { createdAt: "desc" }],
      take: f.limit,
    });
    return rows.map(txFromDb);
  }

  async getLaunch(idOrMint: string, forUpdate = false) {
    if (forUpdate) await this.db.$queryRaw`SELECT id FROM "OffchainLaunch" WHERE id = ${idOrMint} OR mint = ${idOrMint} FOR UPDATE`;
    const r = await this.db.offchainLaunch.findFirst({ where: { OR: [{ id: idOrMint }, { mint: idOrMint }] } });
    return r ? launchFromDb(r) : null;
  }
  async insertLaunch(row: LaunchRow) {
    await this.db.offchainLaunch.create({ data: launchToDb(row) as Prisma.OffchainLaunchCreateInput });
  }
  async updateLaunch(id: string, patch: Partial<LaunchRow>) {
    const { id: _ignore, ...rest } = patch;
    await this.db.offchainLaunch.update({ where: { id }, data: launchToDb(rest) as Prisma.OffchainLaunchUpdateInput });
  }
  async listLaunches(statuses?: OffchainStatus[]) {
    const rows = await this.db.offchainLaunch.findMany({ where: statuses ? { status: { in: statuses } } : undefined, orderBy: { createdTs: "desc" }, take: 1000 });
    return rows.map(launchFromDb);
  }

  async getBid(launchId: string, bidder: string) {
    const r = await this.db.offchainBid.findUnique({ where: { launchId_bidder: { launchId, bidder } } });
    return r ? bidFromDb(r) : null;
  }
  async listBids(launchId: string) {
    return (await this.db.offchainBid.findMany({ where: { launchId } })).map(bidFromDb);
  }
  async insertBid(row: BidRow) {
    await this.db.offchainBid.create({ data: bidToDb(row, this.jsonNull) as Prisma.OffchainBidCreateInput });
  }
  async updateBid(id: string, patch: Partial<BidRow>) {
    const { id: _ignore, ...rest } = patch;
    await this.db.offchainBid.update({ where: { id }, data: bidToDb(rest, this.jsonNull) as Prisma.OffchainBidUpdateInput });
  }

  async getPosition(launchId: string, wallet: string) {
    const r = await this.db.offchainPosition.findUnique({ where: { launchId_wallet: { launchId, wallet } } });
    return r ? posFromDb(r) : null;
  }
  async upsertPosition(row: PositionRow) {
    const data = { ...row, rewardDebt: decStr(row.rewardDebt) };
    await this.db.offchainPosition.upsert({ where: { launchId_wallet: { launchId: row.launchId, wallet: row.wallet } }, create: data, update: data });
  }
  async listPositions(launchId: string) {
    return (await this.db.offchainPosition.findMany({ where: { launchId } })).map(posFromDb);
  }

  async isSniper(launchId: string, wallet: string) {
    return !!(await this.db.offchainAntiSnipe.findUnique({ where: { launchId_wallet: { launchId, wallet } } }));
  }
  async addSniper(row: SniperRow) {
    await this.db.offchainAntiSnipe.upsert({ where: { launchId_wallet: { launchId: row.launchId, wallet: row.wallet } }, create: row, update: {} });
  }
  async listSnipers(f: { launchId?: string; wallet?: string }) {
    return this.db.offchainAntiSnipe.findMany({ where: { launchId: f.launchId, wallet: f.wallet } });
  }
}

function txFromDb(r: { id: string; idempotencyKey: string; kind: string; launchId: string | null; meta: unknown; createdTs: number }): TxRow {
  return { id: r.id, idempotencyKey: r.idempotencyKey, kind: r.kind, launchId: r.launchId, meta: (r.meta ?? {}) as TxRow["meta"], createdTs: r.createdTs };
}

const RETRYABLE = /could not serialize|deadlock detected|40001|40P01|P2034|Unique constraint failed|P2002/i;

/**
 * Postgres repo: every `tx` runs at SERIALIZABLE isolation with explicit `FOR UPDATE` row locks on touched
 * ledger accounts / launch rows, and is retried (bounded) on serialization failures and unique races
 * (a racing duplicate idempotency key resolves to a replay on retry).
 */
export class PrismaRepo implements OffchainRepo {
  readonly kind = "postgres" as const;
  private db!: PrismaClient;
  private jsonNull: unknown = null;
  private _read!: RepoTx;

  constructor(private url: string) {}

  get read(): RepoTx {
    return this._read;
  }

  async init(): Promise<void> {
    type Mod = { PrismaClient: typeof PrismaClient; Prisma: { JsonNull: unknown } };
    const raw = (await import("@prisma/client")) as unknown as Partial<Mod> & { default?: Mod };
    const mod = (raw.PrismaClient ? raw : raw.default!) as Mod;
    this.jsonNull = mod.Prisma.JsonNull;
    this.db = new mod.PrismaClient({ datasources: { db: { url: this.url } } });
    await this.db.$connect();
    // Fails fast if the schema has not been pushed yet (caller decides whether to fall back).
    await this.db.ledgerAccount.count();
    this._read = new PrismaView(this.db, this.jsonNull);
  }

  async close(): Promise<void> {
    await this.db?.$disconnect();
  }

  async tx<T>(fn: (t: RepoTx) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await this.db.$transaction((c) => fn(new PrismaView(c, this.jsonNull)), { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
      } catch (err) {
        lastErr = err;
        const msg = `${(err as { code?: string }).code ?? ""} ${err instanceof Error ? err.message : String(err)}`;
        if (!RETRYABLE.test(msg) || (err as { name?: string }).name === "LedgerError") throw err;
        await new Promise((r) => setTimeout(r, 10 * 2 ** attempt + Math.random() * 10));
      }
    }
    throw lastErr;
  }

  async checkInvariants(): Promise<InvariantReport> {
    const unb = await this.db.$queryRaw<{ txId: string; asset: string }[]>`
      SELECT "txId", asset FROM "LedgerEntry" GROUP BY "txId", asset HAVING SUM(amount) <> 0 LIMIT 100`;
    const mism = await this.db.$queryRaw<{ key: string }[]>`
      SELECT a.key FROM "LedgerAccount" a LEFT JOIN "LedgerEntry" e ON e."accountId" = a.id
      GROUP BY a.id, a.key, a.balance HAVING a.balance <> COALESCE(SUM(e.amount), 0) LIMIT 100`;
    const negRows = await this.db.ledgerAccount.findMany({ where: { balance: { lt: 0n } }, take: 500 });
    const negativeBalances = negRows.filter((a) => !mayGoNegative(a)).map((a) => a.key);
    const unbalancedTxs = unb.map((r) => `${r.txId}:${r.asset}`);
    const balanceMismatches = mism.map((r) => r.key);
    return { ok: !unbalancedTxs.length && !balanceMismatches.length && !negativeBalances.length, unbalancedTxs, balanceMismatches, negativeBalances };
  }
}

export type { AccountRow };
