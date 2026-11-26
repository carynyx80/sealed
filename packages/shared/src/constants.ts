/**
 * Protocol-wide constants. These MUST match `programs/sealed-launchpad/programs/sealed_launchpad/src/constants.rs`.
 * All "bps" values are basis points (10_000 = 100%).
 */

/** Placeholder program id; replaced by `anchor keys sync` output at deploy time (see scripts/deploy-devnet.sh). */
const env: Record<string, string | undefined> = typeof process !== "undefined" && process.env ? process.env : {};
export const PROGRAM_ID: string =
  (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_PROGRAM_ID : undefined) ?? env.PROGRAM_ID ?? "71geDPZMKfjJnKE4an15QyyH5TyFG1w7XEL5tUkp5Tpy";

export const BPS_DENOMINATOR = 10_000;

/** Launched tokens always use 6 decimals. Prices are quote-atoms per 1 whole token (10^6 token atoms). */
export const TOKEN_DECIMALS = 6;
export const TOKEN_UNIT = 1_000_000n;

export const DEFAULT_TOTAL_SUPPLY_WHOLE = 1_000_000_000n;

/** Hard on-chain cap: creator allocation ≤ 2% of supply. */
export const MAX_CREATOR_ALLOCATION_BPS = 200;

/** Share of supply sold in the sealed auction / seeded into the pool (remainder after creator). Creator chooses within these. */
export const MIN_AUCTION_SUPPLY_BPS = 2_000;
export const MAX_AUCTION_SUPPLY_BPS = 6_000;

/** Auction durations (seconds). Devnet/localnet allows down to 120s; mainnet enforces 15–30 min. */
export const MIN_COMMIT_DURATION_SEC_MAINNET = 15 * 60;
export const MAX_COMMIT_DURATION_SEC = 30 * 60;
export const MIN_COMMIT_DURATION_SEC_DEVNET = 2 * 60;
export const DEFAULT_REVEAL_DURATION_SEC = 2 * 60;

/** Bid prices are discrete ticks: price(i) = floorPrice + i * tickSize, i ∈ [0, NUM_PRICE_TICKS). */
export const NUM_PRICE_TICKS = 64;

/** Committed-but-never-revealed bids forfeit this share of their deposit to treasury. */
export const NO_REVEAL_SLASH_BPS = 100;

/** Fee-credit line as a share of raised liquidity, per tier. */
export const CREDIT_TIERS = {
  standard: 1_000,
  plus: 1_250,
  premier: 1_500,
} as const;
export type CreditTier = keyof typeof CREDIT_TIERS;
export const MIN_CREDIT_BPS = 1_000;
export const MAX_CREDIT_BPS = 1_500;

/** Pool trading fee charged on every swap through the graduation pool (1%). */
export const POOL_FEE_BPS = 100;

/** Phase 1 — credit repayment split of trading fees. */
export const REPAY_SPLIT = {
  creditRepayBps: 8_000,
  platformBurnOpsBps: 2_000,
} as const;

/** Phase 2 — permanent flywheel split of trading fees (after credit is 100% repaid). */
export const FLYWHEEL_SPLIT = {
  holderPayoutBps: 5_000,
  platformBuybackBurnBps: 3_500,
  treasuryBps: 1_500,
} as const;

/** Buyback drip cadence bounds. */
export const MIN_DRIP_INTERVAL_SEC = 120;
export const MAX_DRIP_INTERVAL_SEC = 300;
export const DEFAULT_DRIP_INTERVAL_SEC = 180;
/** The vault is spent across this many equal drips (the final drip sweeps the remainder). */
export const DEFAULT_DRIP_COUNT = 48;

/** PDA seeds — byte-identical to the Rust program. */
export const SEEDS = {
  protocol: "protocol",
  creditPool: "credit_pool", // + quote_mint
  launch: "launch", // + token_mint
  bid: "bid", // + launch + bidder
  escrow: "escrow", // + launch  (quote token account holding bid deposits)
  vault: "buyback_vault", // + launch (quote token account; non-withdrawable)
  feeCollector: "fee_collector", // + launch (quote token account)
  pool: "pool", // + launch (internal CPMM state)
  poolQuote: "pool_quote", // + launch
  poolToken: "pool_token", // + launch
  antiSnipe: "anti_snipe", // + launch + wallet
  position: "position", // + launch + owner (holder staking position)
  rewardsVault: "rewards_vault", // + launch (quote token account for holder payouts)
  mintAuthority: "mint_authority", // + launch
} as const;
