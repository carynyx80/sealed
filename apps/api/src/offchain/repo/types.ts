/**
 * Persistence port for the offchain ledger + execution engine. Two implementations share ALL business logic
 * (ledger.ts / engine/*): MemoryRepo (tests, devnet demo) and PrismaRepo (Postgres, serializable + row locks).
 * Every money field is a BigInt in atoms.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface AccountKey {
  owner: string; // wallet, or "system"
  asset: string; // AssetId
  kind: string;
}
export interface AccountRow extends AccountKey {
  id: string;
  key: string; // `${owner}|${asset}|${kind}` (unique)
  balance: bigint;
}

export interface TxRow {
  id: string;
  idempotencyKey: string;
  kind: string;
  launchId: string | null;
  meta: { [k: string]: Json };
  createdTs: number; // unix seconds
}
export interface EntryRow {
  txId: string;
  accountId: string;
  asset: string;
  amount: bigint; // signed: + credit to account, − debit
}

export type OffchainStatus = "commit" | "reveal" | "clearing" | "live" | "flywheel" | "failed";

export interface LaunchRow {
  id: string;
  mint: string;
  name: string;
  ticker: string;
  description: string;
  imageUri: string;
  creator: string;
  quoteAsset: string;
  creditTier: string;
  creditBps: number;
  network: string;
  status: OffchainStatus;
  createdTs: number;
  creatorAllocationBps: number;
  totalSupply: bigint; // token atoms
  creatorAllocation: bigint;
  tokensForSale: bigint;
  poolTokenAllocation: bigint;
  floorPrice: bigint; // quote atoms per whole token
  tickSize: bigint;
  numTicks: number;
  targetRaise: bigint;
  clearingCap: bigint;
  commitStartTs: number;
  commitEndTs: number;
  revealEndTs: number;
  bidCount: number;
  revealedCount: number;
  totalEscrowed: bigint;
  clearingPrice: bigint | null;
  totalRaised: bigint | null;
  tokensSold: bigint | null;
  winners: number;
  graduatedAtMs: number | null;
  creditLine: bigint;
  creditOutstanding: bigint;
  vaultInitial: bigint;
  dripCount: number;
  dripsExecuted: number;
  dripIntervalSec: number;
  nextDripTs: number; // 0 = none
  rewardPerShare: bigint; // scaled by REWARD_SCALE
  eligibleStaked: bigint;
  feeDistributions: number;
  feesCollected: bigint;
  creditRepaid: bigint;
  holderPayouts: bigint;
  platformBurn: bigint;
  treasuryTotal: bigint;
  vaultQuoteSpent: bigint;
  tokensBurned: bigint;
  volumeQuote: bigint;
}

export interface BidRow {
  id: string;
  launchId: string;
  bidder: string;
  commitment: string; // lowercase hex
  deposit: bigint;
  createdTs: number;
  revealed: boolean;
  maxPrice: bigint | null;
  bidAmount: bigint | null;
  tick: number | null;
  sealedReveal: Json | null; // SealedRevealEnvelope (never decrypted before the reveal window)
  autoReveal: string | null; // null | pending | done | failed:<reason>
  settled: boolean;
  spent: bigint | null;
  tokens: bigint | null;
  refund: bigint | null;
  slash: bigint | null;
  claimed: boolean;
}

export interface PositionRow {
  launchId: string;
  wallet: string;
  staked: bigint;
  rewardDebt: bigint;
  unclaimed: bigint;
  claimed: bigint;
  eligible: boolean;
}

export interface SniperRow {
  launchId: string;
  wallet: string;
  ts: number;
  txId: string;
}

export interface TxFilter {
  launchId?: string;
  kinds?: string[];
  sinceTs?: number;
  limit: number;
}

export interface AccountFilter {
  owner?: string;
  asset?: string;
  kind?: string;
  kindPrefix?: string;
}

export interface InvariantReport {
  ok: boolean;
  unbalancedTxs: string[]; // txId:asset where Σ != 0
  balanceMismatches: string[]; // account keys where stored balance != Σ entries
  negativeBalances: string[]; // non-system accounts below zero
}

/** Operations available inside a transaction (and, read-only, outside via `repo.read`). */
export interface RepoTx {
  // ---- ledger
  findTx(idempotencyKey: string): Promise<TxRow | null>;
  txEntries(txId: string): Promise<EntryRow[]>;
  /** Get-or-create the accounts and lock them (deterministic key order) for the rest of the transaction. */
  lockAccounts(keys: AccountKey[]): Promise<AccountRow[]>;
  insertTx(tx: Omit<TxRow, "id">, entries: Omit<EntryRow, "txId">[]): Promise<TxRow>;
  setBalance(accountId: string, balance: bigint): Promise<void>;
  getAccount(key: AccountKey): Promise<AccountRow | null>;
  listAccounts(filter: AccountFilter): Promise<AccountRow[]>;
  listTxs(filter: TxFilter): Promise<TxRow[]>; // newest first

  // ---- launches
  getLaunch(idOrMint: string, forUpdate?: boolean): Promise<LaunchRow | null>;
  insertLaunch(row: LaunchRow): Promise<void>;
  updateLaunch(id: string, patch: Partial<LaunchRow>): Promise<void>;
  listLaunches(statuses?: OffchainStatus[]): Promise<LaunchRow[]>;

  // ---- bids
  getBid(launchId: string, bidder: string): Promise<BidRow | null>;
  listBids(launchId: string): Promise<BidRow[]>;
  insertBid(row: BidRow): Promise<void>;
  updateBid(id: string, patch: Partial<BidRow>): Promise<void>;

  // ---- holder positions
  getPosition(launchId: string, wallet: string): Promise<PositionRow | null>;
  upsertPosition(row: PositionRow): Promise<void>;
  listPositions(launchId: string): Promise<PositionRow[]>;

  // ---- anti-snipe registry
  isSniper(launchId: string, wallet: string): Promise<boolean>;
  addSniper(row: SniperRow): Promise<void>;
  listSnipers(filter: { launchId?: string; wallet?: string }): Promise<SniperRow[]>;
}

export interface OffchainRepo {
  readonly kind: "memory" | "postgres";
  init(): Promise<void>;
  close(): Promise<void>;
  /** Serializable transaction; retried on serialization failures (Postgres). Rolls back on throw. */
  tx<T>(fn: (t: RepoTx) => Promise<T>): Promise<T>;
  /** Non-transactional reads. Never mutate through this. */
  readonly read: RepoTx;
  checkInvariants(): Promise<InvariantReport>;
}

export const accountKeyString = (k: AccountKey) => `${k.owner}|${k.asset}|${k.kind}`;

/** Accounts allowed to hold a negative balance (asset side / mints). */
export function mayGoNegative(k: AccountKey): boolean {
  return k.owner === "system" && (k.kind === "company_custody" || k.kind.startsWith("token_issuance:"));
}
