use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::ErrorCode;
use crate::state::*;

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [SEED_PROTOCOL],
        bump
    )]
    pub protocol: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_protocol_handler(
    ctx: Context<InitializeProtocol>,
    treasury: Pubkey,
    platform_ops: Pubkey,
    keeper: Pubkey,
    is_mainnet: bool,
    max_credit_per_launch: u64,
) -> Result<()> {
    let p = &mut ctx.accounts.protocol;
    p.admin = ctx.accounts.admin.key();
    p.treasury = treasury;
    p.platform_ops = platform_ops;
    p.keeper = keeper;
    p.is_mainnet = is_mainnet;
    p.max_credit_per_launch = max_credit_per_launch;
    p.launch_count = 0;
    p.snipers_blocked = 0;
    p.bump = ctx.bumps.protocol;
    Ok(())
}

#[derive(Accounts)]
pub struct FundCreditPool<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(seeds = [SEED_PROTOCOL], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = funder,
        space = 8 + CreditPool::INIT_SPACE,
        seeds = [SEED_CREDIT_POOL, quote_mint.key().as_ref()],
        bump
    )]
    pub credit_pool: Box<Account<'info, CreditPool>>,
    #[account(
        init_if_needed,
        payer = funder,
        seeds = [SEED_CREDIT_VAULT, quote_mint.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = credit_pool,
    )]
    pub credit_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = funder)]
    pub funder_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn fund_credit_pool_handler(ctx: Context<FundCreditPool>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::ZeroAmount);
    let pool = &mut ctx.accounts.credit_pool;
    if pool.quote_mint == Pubkey::default() {
        pool.quote_mint = ctx.accounts.quote_mint.key();
        pool.vault = ctx.accounts.credit_vault.key();
        pool.bump = ctx.bumps.credit_pool;
    }
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.funder_quote.to_account_info(),
                to: ctx.accounts.credit_vault.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        ),
        amount,
    )?;
    pool.total_deposited = pool.total_deposited.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
    Ok(())
}
