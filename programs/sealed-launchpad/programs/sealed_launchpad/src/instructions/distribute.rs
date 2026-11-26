use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::ErrorCode;
use crate::events::{FeesDistributed, FlywheelActivated};
use crate::math;
use crate::state::*;

#[derive(Accounts)]
pub struct DistributeFees<'info> {
    pub cranker: Signer<'info>,
    #[account(seeds = [SEED_PROTOCOL], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [SEED_LAUNCH, launch.token_mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, LaunchAccount>>,
    #[account(mut, seeds = [SEED_CREDIT_POOL, launch.quote_mint.as_ref()], bump = credit_pool.bump)]
    pub credit_pool: Box<Account<'info, CreditPool>>,
    #[account(mut, address = credit_pool.vault)]
    pub credit_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [SEED_FEE_COLLECTOR, launch.key().as_ref()], bump)]
    pub fee_collector: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [SEED_REWARDS_VAULT, launch.key().as_ref()], bump)]
    pub rewards_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = platform_ops_quote.owner == protocol.platform_ops @ ErrorCode::InvalidAccount,
        constraint = platform_ops_quote.mint == launch.quote_mint @ ErrorCode::InvalidAccount,
    )]
    pub platform_ops_quote: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = treasury_quote.owner == protocol.treasury @ ErrorCode::InvalidAccount,
        constraint = treasury_quote.mint == launch.quote_mint @ ErrorCode::InvalidAccount,
    )]
    pub treasury_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

fn send<'info>(
    tp: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    to: AccountInfo<'info>,
    auth: &AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new_with_signer(tp.clone(), Transfer { from: from.clone(), to, authority: auth.clone() }, &[seeds]),
        amount,
    )
}

pub fn distribute_fees_handler(ctx: Context<DistributeFees>) -> Result<()> {
    let status = ctx.accounts.launch.status;
    require!(status == LaunchStatus::Live || status == LaunchStatus::Flywheel, ErrorCode::NotLive);
    let fees = ctx.accounts.fee_collector.amount;
    require!(fees > 0, ErrorCode::ZeroAmount);

    let split = math::split_fees(fees, ctx.accounts.launch.credit_outstanding);
    let total_staked = ctx.accounts.launch.total_staked;
    let (to_rewards, to_treasury) = if total_staked > 0 {
        (split.holders, split.treasury)
    } else {
        (0, split.treasury.checked_add(split.holders).ok_or(ErrorCode::MathOverflow)?)
    };
    let to_platform = split.platform_ops.checked_add(split.platform_buyback_burn).ok_or(ErrorCode::MathOverflow)?;

    let token_mint_key = ctx.accounts.launch.token_mint;
    let launch_bump = [ctx.accounts.launch.bump];
    let launch_seeds: &[&[u8]] = &[SEED_LAUNCH, token_mint_key.as_ref(), &launch_bump];
    let tp = ctx.accounts.token_program.to_account_info();
    let from = ctx.accounts.fee_collector.to_account_info();
    let auth = ctx.accounts.launch.to_account_info();
    send(&tp, &from, ctx.accounts.credit_vault.to_account_info(), &auth, launch_seeds, split.credit_repay)?;
    send(&tp, &from, ctx.accounts.platform_ops_quote.to_account_info(), &auth, launch_seeds, to_platform)?;
    send(&tp, &from, ctx.accounts.rewards_vault.to_account_info(), &auth, launch_seeds, to_rewards)?;
    send(&tp, &from, ctx.accounts.treasury_quote.to_account_info(), &auth, launch_seeds, to_treasury)?;

    if split.credit_repay > 0 {
        let cp = &mut ctx.accounts.credit_pool;
        cp.outstanding = cp.outstanding.saturating_sub(split.credit_repay);
        cp.total_repaid = cp.total_repaid.checked_add(split.credit_repay).ok_or(ErrorCode::MathOverflow)?;
    }
    let l = &mut ctx.accounts.launch;
    l.credit_outstanding = split.credit_outstanding_after;
    if to_rewards > 0 {
        let inc = to_rewards as u128 * REWARD_SCALE / total_staked as u128;
        l.reward_per_share = l.reward_per_share.checked_add(inc).ok_or(ErrorCode::MathOverflow)?;
    }
    emit!(FeesDistributed {
        launch: l.key(),
        credit_repay: split.credit_repay,
        platform_ops: split.platform_ops,
        holders: split.holders,
        platform_buyback_burn: split.platform_buyback_burn,
        treasury: split.treasury,
        credit_outstanding_after: split.credit_outstanding_after,
    });
    if l.credit_outstanding == 0 && l.status == LaunchStatus::Live {
        l.status = LaunchStatus::Flywheel;
        emit!(FlywheelActivated { launch: l.key() });
    }
    Ok(())
}
