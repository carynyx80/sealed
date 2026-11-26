//! Sealed-Block Launchpad with Fee-Credit Buyback Vault.
//!
//! Interface contract: packages/shared/src/program.ts. Math ports: math.rs.
//! There is deliberately NO instruction that moves funds out of `buyback_vault` other than
//! `execute_buyback_drip` (vault → internal pool quote reserve, bought tokens burned).
#![allow(unexpected_cfgs)]
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("71geDPZMKfjJnKE4an15QyyH5TyFG1w7XEL5tUkp5Tpy");

#[program]
pub mod sealed_launchpad {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        treasury: Pubkey,
        platform_ops: Pubkey,
        keeper: Pubkey,
        is_mainnet: bool,
        max_credit_per_launch: u64,
    ) -> Result<()> {
        instructions::protocol::initialize_protocol_handler(ctx, treasury, platform_ops, keeper, is_mainnet, max_credit_per_launch)
    }

    pub fn fund_credit_pool(ctx: Context<FundCreditPool>, amount: u64) -> Result<()> {
        instructions::protocol::fund_credit_pool_handler(ctx, amount)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_launch(
        ctx: Context<CreateLaunch>,
        name: String,
        ticker: String,
        uri: String,
        total_supply: u64,
        creator_allocation_bps: u16,
        auction_supply_bps: u16,
        credit_bps: u16,
        commit_duration_sec: i64,
        reveal_duration_sec: i64,
        floor_price: u64,
        tick_size: u64,
        target_raise: u64,
        clearing_cap: u64,
        drip_interval_sec: i64,
        drip_count: u16,
    ) -> Result<()> {
        instructions::create_launch::create_launch_handler(
            ctx,
            name,
            ticker,
            uri,
            total_supply,
            creator_allocation_bps,
            auction_supply_bps,
            credit_bps,
            commit_duration_sec,
            reveal_duration_sec,
            floor_price,
            tick_size,
            target_raise,
            clearing_cap,
            drip_interval_sec,
            drip_count,
        )
    }

    pub fn commit_bid(ctx: Context<CommitBid>, commitment: [u8; 32], deposit: u64) -> Result<()> {
        instructions::auction::commit_bid_handler(ctx, commitment, deposit)
    }

    pub fn reveal_bid(ctx: Context<RevealBid>, max_price: u64, bid_amount: u64, salt: [u8; 32]) -> Result<()> {
        instructions::auction::reveal_bid_handler(ctx, max_price, bid_amount, salt)
    }

    pub fn clear_auction(ctx: Context<ClearAuction>) -> Result<()> {
        instructions::auction::clear_auction_handler(ctx)
    }

    pub fn claim_or_refund(ctx: Context<ClaimOrRefund>, stake: bool) -> Result<()> {
        instructions::auction::claim_or_refund_handler(ctx, stake)
    }

    pub fn graduate_and_open_credit(ctx: Context<GraduateAndOpenCredit>) -> Result<()> {
        instructions::graduate::graduate_handler(ctx)
    }

    pub fn swap(ctx: Context<Swap>, amount_in: u64, min_amount_out: u64, is_buy: bool) -> Result<()> {
        instructions::trading::swap_handler(ctx, amount_in, min_amount_out, is_buy)
    }

    pub fn execute_buyback_drip(ctx: Context<ExecuteBuybackDrip>) -> Result<()> {
        instructions::trading::execute_buyback_drip_handler(ctx)
    }

    pub fn distribute_fees(ctx: Context<DistributeFees>) -> Result<()> {
        instructions::distribute::distribute_fees_handler(ctx)
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        instructions::staking::stake_handler(ctx, amount)
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        instructions::staking::unstake_handler(ctx, amount)
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        instructions::staking::claim_rewards_handler(ctx)
    }
}
