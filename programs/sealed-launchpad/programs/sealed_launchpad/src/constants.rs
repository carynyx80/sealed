//! Protocol constants. MUST mirror packages/shared/src/constants.ts exactly.

pub const BPS_DENOMINATOR: u64 = 10_000;

/// Launched tokens always use 6 decimals. Prices are quote atoms per 1 whole token.
pub const TOKEN_DECIMALS: u8 = 6;
pub const TOKEN_UNIT: u64 = 1_000_000;

pub const DEFAULT_TOTAL_SUPPLY_WHOLE: u64 = 1_000_000_000;

pub const MAX_CREATOR_ALLOCATION_BPS: u16 = 200;
pub const MIN_AUCTION_SUPPLY_BPS: u16 = 2_000;
pub const MAX_AUCTION_SUPPLY_BPS: u16 = 6_000;

pub const MIN_COMMIT_DURATION_SEC_MAINNET: i64 = 15 * 60;
pub const MAX_COMMIT_DURATION_SEC: i64 = 30 * 60;
pub const MIN_COMMIT_DURATION_SEC_DEVNET: i64 = 2 * 60;
pub const DEFAULT_REVEAL_DURATION_SEC: i64 = 2 * 60;
/// Reveal window bounds (not in shared constants; program-only guard rails).
pub const MIN_REVEAL_DURATION_SEC: i64 = 60;
pub const MAX_REVEAL_DURATION_SEC: i64 = 30 * 60;

/// `test-mode` feature: relaxed minimums for non-mainnet protocols only.
pub const TEST_MODE_MIN_COMMIT_SEC: i64 = 2;
pub const TEST_MODE_MIN_REVEAL_SEC: i64 = 2;
pub const TEST_MODE_MIN_DRIP_INTERVAL_SEC: i64 = 1;

pub const NUM_PRICE_TICKS: usize = 64;

pub const NO_REVEAL_SLASH_BPS: u64 = 100;

pub const CREDIT_TIER_STANDARD_BPS: u16 = 1_000;
pub const CREDIT_TIER_PLUS_BPS: u16 = 1_250;
pub const CREDIT_TIER_PREMIER_BPS: u16 = 1_500;
pub const MIN_CREDIT_BPS: u16 = 1_000;
pub const MAX_CREDIT_BPS: u16 = 1_500;

pub const POOL_FEE_BPS: u64 = 100;

pub const REPAY_CREDIT_BPS: u64 = 8_000;
pub const REPAY_PLATFORM_BURN_OPS_BPS: u64 = 2_000;

pub const FLYWHEEL_HOLDER_PAYOUT_BPS: u64 = 5_000;
pub const FLYWHEEL_PLATFORM_BUYBACK_BURN_BPS: u64 = 3_500;
pub const FLYWHEEL_TREASURY_BPS: u64 = 1_500;

pub const MIN_DRIP_INTERVAL_SEC: i64 = 120;
pub const MAX_DRIP_INTERVAL_SEC: i64 = 300;
pub const DEFAULT_DRIP_INTERVAL_SEC: i64 = 180;
pub const DEFAULT_DRIP_COUNT: u16 = 48;

/// reward_per_share scale.
pub const REWARD_SCALE: u128 = 1_000_000_000_000;

pub const MAX_NAME_LEN: usize = 32;
pub const MAX_TICKER_LEN: usize = 10;
pub const MAX_URI_LEN: usize = 200;

// PDA seeds — byte-identical to SEEDS in constants.ts.
pub const SEED_PROTOCOL: &[u8] = b"protocol";
pub const SEED_CREDIT_POOL: &[u8] = b"credit_pool";
pub const SEED_LAUNCH: &[u8] = b"launch";
pub const SEED_BID: &[u8] = b"bid";
pub const SEED_ESCROW: &[u8] = b"escrow";
pub const SEED_VAULT: &[u8] = b"buyback_vault";
pub const SEED_FEE_COLLECTOR: &[u8] = b"fee_collector";
pub const SEED_POOL: &[u8] = b"pool";
pub const SEED_POOL_QUOTE: &[u8] = b"pool_quote";
pub const SEED_POOL_TOKEN: &[u8] = b"pool_token";
pub const SEED_ANTI_SNIPE: &[u8] = b"anti_snipe";
pub const SEED_POSITION: &[u8] = b"position";
pub const SEED_REWARDS_VAULT: &[u8] = b"rewards_vault";
pub const SEED_MINT_AUTHORITY: &[u8] = b"mint_authority";
// Program-only seeds not (yet) in shared SEEDS:
/// + quote_mint — CreditPool's quote token vault (authority = credit_pool PDA).
pub const SEED_CREDIT_VAULT: &[u8] = b"credit_vault";
/// + launch — staked launch tokens (authority = launch PDA).
pub const SEED_STAKE_VAULT: &[u8] = b"stake_vault";
