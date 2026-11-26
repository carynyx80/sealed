//! Anchor events for the off-chain indexer (parse from "Program data:" logs).
use anchor_lang::prelude::*;

#[event]
pub struct LaunchCreated {
    pub launch: Pubkey,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub quote_mint: Pubkey,
}

/// Only public escrow aggregates — never individual bid sizes/prices.
#[event]
pub struct BidCommitted {
    pub launch: Pubkey,
    pub bid_count: u32,
    pub total_escrowed: u64,
}

#[event]
pub struct BidRevealed {
    pub launch: Pubkey,
    pub revealed_count: u32,
}

#[event]
pub struct AuctionCleared {
    pub launch: Pubkey,
    pub clearing_price: u64,
    pub total_raised: u64,
    pub tokens_sold: u64,
}

#[event]
pub struct Graduated {
    pub launch: Pubkey,
    pub slot: u64,
    pub credit_line: u64,
}

#[event]
pub struct SwapEvent {
    pub launch: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    pub amount_in: u64,
    pub amount_out: u64,
    pub fee: u64,
    pub slot: u64,
    pub is_sniper: bool,
}

#[event]
pub struct BuybackDrip {
    pub launch: Pubkey,
    pub quote_spent: u64,
    pub tokens_burned: u64,
    pub drip_index: u16,
    pub next_drip_ts: i64,
}

#[event]
pub struct FeesDistributed {
    pub launch: Pubkey,
    pub credit_repay: u64,
    pub platform_ops: u64,
    pub holders: u64,
    pub platform_buyback_burn: u64,
    pub treasury: u64,
    pub credit_outstanding_after: u64,
}

#[event]
pub struct FlywheelActivated {
    pub launch: Pubkey,
}

#[event]
pub struct SniperFlagged {
    pub launch: Pubkey,
    pub wallet: Pubkey,
    pub slot: u64,
}
