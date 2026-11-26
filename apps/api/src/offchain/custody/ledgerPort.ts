/**
 * The slice of the offchain ledger (apps/api/src/offchain/ledger.ts, see LEDGER.md) the custody layer uses.
 * Structural so it can be satisfied by the real ledger instance (`ctx.offchain.ledger`) or a test double.
 */
export interface PostResult {
  txId: string;
  replayed: boolean;
}
export type LedgerMeta = Record<string, string | number | boolean | null>;

export interface CustodyLedger {
  /** company_custody → user_available (deposit). Idempotent on key. */
  credit(wallet: string, asset: string, atoms: bigint, idempotencyKey: string, meta?: LedgerMeta): Promise<PostResult>;
  /** user_available → user_locked (withdrawal request). Throws INSUFFICIENT_FUNDS. */
  debitForWithdrawal(wallet: string, asset: string, atoms: bigint, idempotencyKey: string, meta?: LedgerMeta): Promise<PostResult>;
  /** user_locked → user_available (rejected / failed withdrawal). */
  unlock(wallet: string, asset: string, atoms: bigint, idempotencyKey: string, meta?: LedgerMeta): Promise<PostResult>;
  /** user_locked → company_custody (payout confirmed on-chain). */
  settleWithdrawal(wallet: string, asset: string, atoms: bigint, idempotencyKey: string, meta?: LedgerMeta): Promise<PostResult>;
  /** company_custody → system:<kind> (admin seeding, e.g. credit_pool). */
  creditSystem(kind: string, asset: string, atoms: bigint, idempotencyKey: string, meta?: LedgerMeta): Promise<PostResult>;
  /** Everything owed for `asset` (users + system pools). */
  liabilities(asset: string): Promise<bigint>;
  balances(wallet: string): Promise<{ asset: string; available: bigint; locked: bigint; staked?: bigint }[]>;
}

/** Error code helper (LedgerError has `.code`). */
export function ledgerErrorCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}
