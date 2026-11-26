import { QUOTE_ASSETS, TOKEN_DECIMALS, isQuoteAssetSymbol, type AssetId } from "@sealed/shared";
import { nowSec } from "../store/types.js";
import { accountKeyString, mayGoNegative, type AccountKey, type InvariantReport, type Json, type OffchainRepo, type RepoTx, type TxRow } from "./repo/types.js";

/**
 * Double-entry ledger (see LEDGER.md). All business logic lives here and is shared by the memory and Postgres repos:
 *   - every transaction is balanced per asset (Σ amounts = 0),
 *   - idempotent on `idempotencyKey` (replay = no-op; different content = IDEMPOTENCY_CONFLICT),
 *   - non-system accounts may never go negative (INSUFFICIENT_FUNDS),
 *   - touched accounts are locked (FOR UPDATE) in deterministic key order inside a serializable tx.
 */

export const SYSTEM = "system";

export type LedgerErrorCode = "INSUFFICIENT_FUNDS" | "UNBALANCED" | "IDEMPOTENCY_CONFLICT" | "INVALID";
export class LedgerError extends Error {
  readonly statusCode: number;
  constructor(readonly code: LedgerErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.name = "LedgerError";
    this.statusCode = code === "INVALID" || code === "UNBALANCED" ? 400 : 409;
  }
}

export interface Leg {
  account: AccountKey;
  /** Signed atoms: + credits the account, − debits it. */
  amount: bigint;
}

export interface PostRequest {
  idempotencyKey: string;
  kind: string;
  launchId?: string | null;
  meta?: { [k: string]: Json };
  legs: Leg[];
  createdTs?: number;
}
export interface PostResult {
  txId: string;
  replayed: boolean;
  tx: TxRow;
}

export interface WalletBalance {
  asset: string;
  available: bigint;
  locked: bigint;
  staked: bigint;
}

// ------------------------------------------------------------------ assets & units

export function assetDecimals(asset: string): number {
  if (asset.startsWith("tok:")) return TOKEN_DECIMALS;
  if (isQuoteAssetSymbol(asset)) return QUOTE_ASSETS[asset].decimals;
  throw new LedgerError("INVALID", `unknown asset ${asset}`);
}

export function isAssetId(asset: string): asset is AssetId {
  return isQuoteAssetSymbol(asset) || /^tok:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(asset);
}

/** UI number → atoms, truncating (never rounding up) beyond `decimals`. Rejects NaN/negative/non-finite. */
export function toAtoms(ui: number, decimals: number): bigint {
  if (!Number.isFinite(ui) || ui < 0) throw new LedgerError("INVALID", "amount must be a finite non-negative number");
  const s = ui.toFixed(Math.min(100, decimals + 6));
  const [i, f = ""] = s.split(".");
  return BigInt(i! + f.slice(0, decimals).padEnd(decimals, "0"));
}

/** Atoms → UI number (display only; never fed back into money math). */
export function fromAtoms(atoms: bigint, decimals: number): number {
  const neg = atoms < 0n;
  const a = neg ? -atoms : atoms;
  const d = 10n ** BigInt(decimals);
  const v = Number(a / d) + Number(a % d) / Number(d);
  return neg ? -v : v;
}

export const tokenAsset = (launchId: string) => `tok:${launchId}`;

// ------------------------------------------------------------------ account constructors

export const acct = {
  custody: (asset: string): AccountKey => ({ owner: SYSTEM, asset, kind: "company_custody" }),
  issuance: (launchId: string): AccountKey => ({ owner: SYSTEM, asset: tokenAsset(launchId), kind: `token_issuance:${launchId}` }),
  available: (wallet: string, asset: string): AccountKey => ({ owner: wallet, asset, kind: "user_available" }),
  locked: (wallet: string, asset: string): AccountKey => ({ owner: wallet, asset, kind: "user_locked" }),
  bidEscrow: (wallet: string, asset: string, launchId: string): AccountKey => ({ owner: wallet, asset, kind: `bid_escrow:${launchId}` }),
  staked: (wallet: string, launchId: string): AccountKey => ({ owner: wallet, asset: tokenAsset(launchId), kind: `staked:${launchId}` }),
  system: (kind: string, asset: string): AccountKey => ({ owner: SYSTEM, asset, kind }),
  launch: (kind: "auction_escrow" | "auction_tokens" | "pool_quote" | "pool_token" | "buyback_vault" | "fee_collector" | "rewards", launchId: string, asset: string): AccountKey => ({
    owner: SYSTEM,
    asset,
    kind: `${kind}:${launchId}`,
  }),
};

/** Two-leg transfer helper. */
export function move(from: AccountKey, to: AccountKey, amount: bigint): Leg[] {
  if (amount === 0n) return [];
  if (amount < 0n) throw new LedgerError("INVALID", "transfer amount must be positive");
  return [
    { account: from, amount: -amount },
    { account: to, amount },
  ];
}

// ------------------------------------------------------------------ core

function fingerprint(legs: { key: string; amount: bigint }[]): string {
  const m = new Map<string, bigint>();
  for (const l of legs) m.set(l.key, (m.get(l.key) ?? 0n) + l.amount);
  return [...m].filter(([, v]) => v !== 0n).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(";");
}

/** Post a balanced transaction inside an existing repo transaction. */
export async function postIn(t: RepoTx, req: PostRequest): Promise<PostResult> {
  if (!req.idempotencyKey || req.idempotencyKey.length > 200) throw new LedgerError("INVALID", "invalid idempotency key");
  for (const l of req.legs) {
    if (typeof l.amount !== "bigint") throw new LedgerError("INVALID", "amounts must be bigint atoms");
    if (!isAssetId(l.account.asset)) throw new LedgerError("INVALID", `unknown asset ${l.account.asset}`);
  }
  const legs = req.legs.filter((l) => l.amount !== 0n).map((l) => ({ ...l, key: accountKeyString(l.account) }));
  const fp = fingerprint(legs);

  const existing = await t.findTx(req.idempotencyKey);
  if (existing) {
    if (existing.kind !== req.kind || existing.meta.__fp !== fp) {
      throw new LedgerError("IDEMPOTENCY_CONFLICT", "idempotency key reused with different content", { key: req.idempotencyKey });
    }
    return { txId: existing.id, replayed: true, tx: existing };
  }

  // Balanced per asset.
  const perAsset = new Map<string, bigint>();
  for (const l of legs) perAsset.set(l.account.asset, (perAsset.get(l.account.asset) ?? 0n) + l.amount);
  for (const [asset, sum] of perAsset) if (sum !== 0n) throw new LedgerError("UNBALANCED", `transaction unbalanced for ${asset}: ${sum}`);

  // Lock every touched account in deterministic order, apply deltas, check non-negativity.
  const uniq = new Map<string, AccountKey>();
  for (const l of legs) uniq.set(l.key, l.account);
  const keys = [...uniq.keys()].sort();
  const rows = await t.lockAccounts(keys.map((k) => uniq.get(k)!));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const next = new Map<string, bigint>();
  for (const l of legs) next.set(l.key, (next.get(l.key) ?? byKey.get(l.key)!.balance) + l.amount);
  for (const [k, bal] of next) {
    const row = byKey.get(k)!;
    if (bal < 0n && !mayGoNegative(row)) {
      throw new LedgerError("INSUFFICIENT_FUNDS", `insufficient balance in ${row.kind} (${row.asset})`, { asset: row.asset, kind: row.kind, needed: (-bal).toString() });
    }
  }

  const tx = await t.insertTx(
    { idempotencyKey: req.idempotencyKey, kind: req.kind, launchId: req.launchId ?? null, meta: { ...(req.meta ?? {}), __fp: fp }, createdTs: req.createdTs ?? nowSec() },
    legs.map((l) => ({ accountId: byKey.get(l.key)!.id, asset: l.account.asset, amount: l.amount })),
  );
  for (const [k, bal] of next) await t.setBalance(byKey.get(k)!.id, bal);
  return { txId: tx.id, replayed: false, tx };
}

export class Ledger {
  constructor(readonly repo: OffchainRepo) {}

  async post(req: PostRequest): Promise<PostResult> {
    return this.repo.tx((t) => postIn(t, req));
  }

  private amt(atoms: bigint) {
    if (typeof atoms !== "bigint" || atoms <= 0n) throw new LedgerError("INVALID", "amount must be a positive bigint");
    return atoms;
  }

  /** Deposit credited: company_custody → user_available. */
  async credit(wallet: string, asset: string, atoms: bigint, idempotencyKey: string, meta: { [k: string]: Json } = {}) {
    return this.post({ idempotencyKey, kind: "deposit", meta: { wallet, ...meta }, legs: move(acct.custody(asset), acct.available(wallet, asset), this.amt(atoms)) });
  }
  /** Reserve funds for a withdrawal: user_available → user_locked. */
  async debitForWithdrawal(wallet: string, asset: string, atoms: bigint, idempotencyKey: string, meta: { [k: string]: Json } = {}) {
    return this.post({ idempotencyKey, kind: "withdrawal_reserve", meta: { wallet, ...meta }, legs: move(acct.available(wallet, asset), acct.locked(wallet, asset), this.amt(atoms)) });
  }
  async lock(wallet: string, asset: string, atoms: bigint, idempotencyKey: string, meta: { [k: string]: Json } = {}) {
    return this.post({ idempotencyKey, kind: "lock", meta: { wallet, ...meta }, legs: move(acct.available(wallet, asset), acct.locked(wallet, asset), this.amt(atoms)) });
  }
  async unlock(wallet: string, asset: string, atoms: bigint, idempotencyKey: string, meta: { [k: string]: Json } = {}) {
    return this.post({ idempotencyKey, kind: "unlock", meta: { wallet, ...meta }, legs: move(acct.locked(wallet, asset), acct.available(wallet, asset), this.amt(atoms)) });
  }
  /** Withdrawal paid out on-chain: user_locked → company_custody. */
  async settleWithdrawal(wallet: string, asset: string, atoms: bigint, idempotencyKey: string, meta: { [k: string]: Json } = {}) {
    return this.post({ idempotencyKey, kind: "withdrawal", meta: { wallet, ...meta }, legs: move(acct.locked(wallet, asset), acct.custody(asset), this.amt(atoms)) });
  }
  /** Admin seeding of a system account (e.g. credit_pool) from real funds in custody. */
  async creditSystem(kind: string, asset: string, atoms: bigint, idempotencyKey: string, meta: { [k: string]: Json } = {}) {
    if (kind === "company_custody" || kind.includes(":")) throw new LedgerError("INVALID", "creditSystem only targets global system accounts (credit_pool, treasury, platform_ops)");
    return this.post({ idempotencyKey, kind: "system_credit", meta: { target: kind, ...meta }, legs: move(acct.custody(asset), acct.system(kind, asset), this.amt(atoms)) });
  }

  async balanceOf(owner: string, asset: string, kind: string): Promise<bigint> {
    return (await this.repo.read.getAccount({ owner, asset, kind }))?.balance ?? 0n;
  }

  async balances(wallet: string): Promise<WalletBalance[]> {
    const rows = await this.repo.read.listAccounts({ owner: wallet });
    const m = new Map<string, WalletBalance>();
    for (const r of rows) {
      const b = m.get(r.asset) ?? { asset: r.asset, available: 0n, locked: 0n, staked: 0n };
      if (r.kind === "user_available") b.available += r.balance;
      else if (r.kind === "user_locked" || r.kind.startsWith("bid_escrow:")) b.locked += r.balance;
      else if (r.kind.startsWith("staked:")) b.staked += r.balance;
      m.set(r.asset, b);
    }
    return [...m.values()];
  }

  /** Everything owed for `asset` = −company_custody (by the Σ=0 invariant). */
  async liabilities(asset: string): Promise<bigint> {
    return -(await this.balanceOf(SYSTEM, asset, "company_custody"));
  }

  verify(): Promise<InvariantReport> {
    return this.repo.checkInvariants();
  }
}

// ------------------------------------------------------------------ module-level default (custody-agent API)

let defaultLedger: Ledger | null = null;
export function setDefaultLedger(l: Ledger | null) {
  defaultLedger = l;
}
export function getLedger(): Ledger {
  if (!defaultLedger) throw new Error("ledger not initialised (offchain runtime not built)");
  return defaultLedger;
}
export const credit = (wallet: string, asset: string, atoms: bigint, idempotencyKey: string, meta?: { [k: string]: Json }) => getLedger().credit(wallet, asset, atoms, idempotencyKey, meta);
export const debitForWithdrawal = (wallet: string, asset: string, atoms: bigint, idempotencyKey: string, meta?: { [k: string]: Json }) =>
  getLedger().debitForWithdrawal(wallet, asset, atoms, idempotencyKey, meta);
export const lock = (wallet: string, asset: string, atoms: bigint, idempotencyKey: string, meta?: { [k: string]: Json }) => getLedger().lock(wallet, asset, atoms, idempotencyKey, meta);
export const unlock = (wallet: string, asset: string, atoms: bigint, idempotencyKey: string, meta?: { [k: string]: Json }) => getLedger().unlock(wallet, asset, atoms, idempotencyKey, meta);
export const settleWithdrawal = (wallet: string, asset: string, atoms: bigint, idempotencyKey: string, meta?: { [k: string]: Json }) =>
  getLedger().settleWithdrawal(wallet, asset, atoms, idempotencyKey, meta);
export const creditSystem = (kind: string, asset: string, atoms: bigint, idempotencyKey: string, meta?: { [k: string]: Json }) => getLedger().creditSystem(kind, asset, atoms, idempotencyKey, meta);
export const balances = (wallet: string) => getLedger().balances(wallet);
export const liabilities = (asset: string) => getLedger().liabilities(asset);
