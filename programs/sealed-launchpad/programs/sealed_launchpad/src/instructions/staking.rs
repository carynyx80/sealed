use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::ErrorCode;
use crate::instructions::auction::is_sniper;
use crate::math;
use crate::state::*;

fn settle(pos: &mut HolderPosition, rps: u128) -> Result<()> {
    let pending = math::pending_rewards(pos.staked, rps, pos.reward_debt);
    pos.unclaimed = pos.unclaimed.checked_add(pending).ok_or(ErrorCode::MathOverflow)?;
    Ok(())
}

// ---------------------------------------------------------------- stake

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [SEED_LAUNCH, launch.token_mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, LaunchAccount>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + HolderPosition::INIT_SPACE,
        seeds = [SEED_POSITION, launch.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, HolderPosition>>,
    #[account(mut, seeds = [SEED_STAKE_VAULT, launch.key().as_ref()], bump)]
    pub stake_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = launch.token_mint, token::authority = owner)]
    pub owner_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: AntiSnipeEntry PDA for (launch, owner). If it exists the wallet can never stake.
    #[account(seeds = [SEED_ANTI_SNIPE, launch.key().as_ref(), owner.key().as_ref()], bump)]
    pub anti_snipe: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn stake_handler(ctx: Context<Stake>, amount: u64) -> Result<()> {
    require!(!is_sniper(&ctx.accounts.anti_snipe.to_account_info()), ErrorCode::SniperIneligible);
    require!(amount > 0, ErrorCode::ZeroAmount);
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.owner_token.to_account_info(),
                to: ctx.accounts.stake_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;
    let launch_key = ctx.accounts.launch.key();
    let l = &mut ctx.accounts.launch;
    let pos = &mut ctx.accounts.position;
    if pos.owner == Pubkey::default() {
        pos.launch = launch_key;
        pos.owner = ctx.accounts.owner.key();
        pos.bump = ctx.bumps.position;
    }
    settle(pos, l.reward_per_share)?;
    pos.staked = pos.staked.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
    pos.reward_debt = math::reward_debt(pos.staked, l.reward_per_share);
    l.total_staked = l.total_staked.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
    Ok(())
}

// ---------------------------------------------------------------- unstake

#[derive(Accounts)]
pub struct Unstake<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [SEED_LAUNCH, launch.token_mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, LaunchAccount>>,
    #[account(
        mut,
        seeds = [SEED_POSITION, launch.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = owner,
        has_one = launch,
    )]
    pub position: Box<Account<'info, HolderPosition>>,
    #[account(mut, seeds = [SEED_STAKE_VAULT, launch.key().as_ref()], bump)]
    pub stake_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = launch.token_mint, token::authority = owner)]
    pub owner_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn unstake_handler(ctx: Context<Unstake>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::ZeroAmount);
    require!(ctx.accounts.position.staked >= amount, ErrorCode::InsufficientStake);
    let token_mint_key = ctx.accounts.launch.token_mint;
    let launch_bump = [ctx.accounts.launch.bump];
    let launch_seeds: &[&[u8]] = &[SEED_LAUNCH, token_mint_key.as_ref(), &launch_bump];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.stake_vault.to_account_info(),
                to: ctx.accounts.owner_token.to_account_info(),
                authority: ctx.accounts.launch.to_account_info(),
            },
            &[launch_seeds],
        ),
        amount,
    )?;
    let l = &mut ctx.accounts.launch;
    let pos = &mut ctx.accounts.position;
    settle(pos, l.reward_per_share)?;
    pos.staked -= amount;
    pos.reward_debt = math::reward_debt(pos.staked, l.reward_per_share);
    l.total_staked = l.total_staked.checked_sub(amount).ok_or(ErrorCode::MathOverflow)?;
    Ok(())
}

// ---------------------------------------------------------------- claim_rewards

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [SEED_LAUNCH, launch.token_mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, LaunchAccount>>,
    #[account(
        mut,
        seeds = [SEED_POSITION, launch.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = owner,
        has_one = launch,
    )]
    pub position: Box<Account<'info, HolderPosition>>,
    #[account(mut, seeds = [SEED_REWARDS_VAULT, launch.key().as_ref()], bump)]
    pub rewards_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = launch.quote_mint, token::authority = owner)]
    pub owner_quote: Box<Account<'info, TokenAccount>>,
    /// CHECK: AntiSnipeEntry PDA for (launch, owner). Snipers accrue nothing.
    #[account(seeds = [SEED_ANTI_SNIPE, launch.key().as_ref(), owner.key().as_ref()], bump)]
    pub anti_snipe: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn claim_rewards_handler(ctx: Context<ClaimRewards>) -> Result<()> {
    require!(!is_sniper(&ctx.accounts.anti_snipe.to_account_info()), ErrorCode::SniperIneligible);
    let rps = ctx.accounts.launch.reward_per_share;
    let amount = {
        let pos = &mut ctx.accounts.position;
        settle(pos, rps)?;
        pos.reward_debt = math::reward_debt(pos.staked, rps);
        let amt = core::cmp::min(pos.unclaimed, ctx.accounts.rewards_vault.amount);
        pos.unclaimed -= amt;
        pos.claimed = pos.claimed.checked_add(amt).ok_or(ErrorCode::MathOverflow)?;
        amt
    };
    require!(amount > 0, ErrorCode::ZeroAmount);
    let token_mint_key = ctx.accounts.launch.token_mint;
    let launch_bump = [ctx.accounts.launch.bump];
    let launch_seeds: &[&[u8]] = &[SEED_LAUNCH, token_mint_key.as_ref(), &launch_bump];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.rewards_vault.to_account_info(),
                to: ctx.accounts.owner_quote.to_account_info(),
                authority: ctx.accounts.launch.to_account_info(),
            },
            &[launch_seeds],
        ),
        amount,
    )?;
    Ok(())
}
