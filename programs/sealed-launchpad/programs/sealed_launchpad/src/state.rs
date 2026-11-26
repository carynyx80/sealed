use anchor_lang::prelude::*;

use crate::constants::*;

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub platform_ops: Pubkey,
    pub keeper: Pubkey,
    pub is_mainnet: bool,
    pub max_credit_per_launch: u64,
    pub launch_count: u64,
    pub snipers_blocked: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CreditPool {
    pub quote_mint: Pubkey,
    pub total_deposited: u64,
    pub outstanding: u64,
    pub total_advanced: u64,
    pub total_repaid: u64,
    /// Token account PDA ["credit_vault", quote_mint], authority = this CreditPool PDA.
    pub vault: Pubkey,
    pub bump: u8,
}

/// On-chain LaunchStatus (u8). Matches ONCHAIN_STATUS in program.ts.
#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum LaunchStatus {
    Open = 0,
    Cleared = 1,
    Failed = 2,
    Live = 3,
    Flywheel = 4,
}

#[account]
#[derive(InitSpace)]
pub struct LaunchAccount {
    pub creator: Pubkey,
    pub token_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub status: LaunchStatus,
    pub total_supply: u64,
    pub creator_allocation: u64,
    pub tokens_for_sale: u64,
    pub pool_token_allocation: u64,
    pub credit_bps: u16,
    pub commit_start_ts: i64,
    pub commit_end_ts: i64,
    pub reveal_end_ts: i64,
    pub floor_price: u64,
    pub tick_size: u64,
    pub target_raise: u64,
    pub clearing_cap: u64,
    pub bid_count: u32,
    pub revealed_count: u32,
    pub total_escrowed: u64,
    pub histogram: [u64; NUM_PRICE_TICKS],
    pub clearing_price: u64,
    pub marginal_tick: i16,
    pub fill_rule: u8,
    pub fill_num: u64,
    pub fill_den: u64,
    pub total_raised: u64,
    pub tokens_sold: u64,
    pub graduation_slot: u64,
    pub graduated_ts: i64,
    pub credit_line: u64,
    pub credit_outstanding: u64,
    pub drip_interval_sec: i64,
    pub drip_count: u16,
    pub drips_executed: u16,
    pub next_drip_ts: i64,
    pub vault_initial: u64,
    pub tokens_burned: u64,
    pub fees_collected: u64,
    pub reward_per_share: u128,
    pub total_staked: u64,
    pub bump: u8,
    // ---- program-only extras (appended; not in program.ts ACCOUNTS list) ----
    pub auction_supply_bps: u16,
    pub creator_allocation_bps: u16,
    /// Quote atoms actually moved escrow → pool at graduation (total_raised minus per-bid rounding buffer).
    pub pool_quote_seeded: u64,
    #[max_len(MAX_NAME_LEN)]
    pub name: String,
    #[max_len(MAX_TICKER_LEN)]
    pub ticker: String,
    #[max_len(MAX_URI_LEN)]
    pub uri: String,
}

#[account]
#[derive(InitSpace)]
pub struct SealedBid {
    pub launch: Pubkey,
    pub bidder: Pubkey,
    pub commitment: [u8; 32],
    pub deposit: u64,
    pub revealed: bool,
    pub max_price: u64,
    pub bid_amount: u64,
    pub tick: u8,
    pub claimed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub launch: Pubkey,
    pub quote_reserve: u64,
    pub token_reserve: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AntiSnipeEntry {
    pub launch: Pubkey,
    pub wallet: Pubkey,
    pub slot: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct HolderPosition {
    pub launch: Pubkey,
    pub owner: Pubkey,
    pub staked: u64,
    pub reward_debt: u128,
    pub claimed: u64,
    pub bump: u8,
    /// Program-only: rewards settled on stake/unstake but not yet transferred.
    pub unclaimed: u64,
}
