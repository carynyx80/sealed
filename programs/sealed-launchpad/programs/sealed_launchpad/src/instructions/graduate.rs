use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::ErrorCode;
use crate::events::{FlywheelActivated, Graduated};
use crate::math;
use crate::state::*;

#[derive(Accounts)]
pub struct GraduateAndOpenCredit<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [SEED_PROTOCOL], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [SEED_LAUNCH, launch.token_mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, LaunchAccount>>,
    #[account(mut, address = launch.token_mint)]
    pub token_mint: Box<Account<'info, Mint>>,
    /// CHECK: mint authority PDA (signs mint_to).
    #[account(seeds = [SEED_MINT_AUTHORITY, launch.key().as_ref()], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    #[account(address = launch.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [SEED_ESCROW, launch.key().as_ref()], bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = cranker,
        space = 8 + Pool::INIT_SPACE,
        seeds = [SEED_POOL, launch.key().as_ref()],
        bump
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init,
        payer = cranker,
        seeds = [SEED_POOL_QUOTE, launch.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = launch,
    )]
    pub pool_quote: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = cranker,
        seeds = [SEED_POOL_TOKEN, launch.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = launch,
    )]
    pub pool_token: Box<Account<'info, TokenAccount>>,
    /// Non-withdrawable buyback vault: authority = launch PDA; only execute_buyback_drip moves funds out.
    #[account(
        init,
        payer = cranker,
        seeds = [SEED_VAULT, launch.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = launch,
    )]
    pub buyback_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = cranker,
        seeds = [SEED_FEE_COLLECTOR, launch.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = launch,
    )]
    pub fee_collector: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [SEED_CREDIT_POOL, launch.quote_mint.as_ref()], bump = credit_pool.bump)]
    pub credit_pool: Box<Account<'info, CreditPool>>,
    #[account(mut, address = credit_pool.vault)]
    pub credit_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn graduate_handler(ctx: Context<GraduateAndOpenCredit>) -> Result<()> {
    let clock = Clock::get()?;
    let launch_key = ctx.accounts.launch.key();
    match ctx.accounts.launch.status {
        LaunchStatus::Cleared => {}
        LaunchStatus::Live | LaunchStatus::Flywheel => return err!(ErrorCode::AlreadyGraduated),
        _ => return err!(ErrorCode::AuctionNotCleared),
    }

    let (seed_quote, seed_tokens, credit) = {
        let l = &ctx.accounts.launch;
        // Per-bid settlement rounds DOWN, so Σspent may undershoot total_raised by < 1 atom per revealed bid.
        // Keep that buffer in escrow so every refund stays fully covered.
        let seed_quote = l.total_raised.saturating_sub(l.revealed_count as u64);
        let unsold = l.tokens_for_sale.saturating_sub(l.tokens_sold);
        let seed_tokens = l.pool_token_allocation.checked_add(unsold).ok_or(ErrorCode::MathOverflow)?;
        let credit = math::compute_credit_line(
            l.total_raised,
            l.credit_bps,
            ctx.accounts.credit_vault.amount,
            ctx.accounts.protocol.max_credit_per_launch,
        )
        .ok_or(ErrorCode::InvalidCreditBps)?;
        (seed_quote, seed_tokens, credit)
    };
    require!(seed_quote > 0 && seed_tokens > 0, ErrorCode::InvalidParams);

    let token_mint_key = ctx.accounts.launch.token_mint;
    let launch_bump = [ctx.accounts.launch.bump];
    let launch_seeds: &[&[u8]] = &[SEED_LAUNCH, token_mint_key.as_ref(), &launch_bump];
    let tp = ctx.accounts.token_program.to_account_info();

    // 1. Raised quote → pool quote reserve.
    token::transfer(
        CpiContext::new_with_signer(
            tp.clone(),
            Transfer {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.pool_quote.to_account_info(),
                authority: ctx.accounts.launch.to_account_info(),
            },
            &[launch_seeds],
        ),
        seed_quote,
    )?;

    // 2. Pool token allocation (+ unsold auction supply) → pool token reserve.
    let ma_bump = [ctx.bumps.mint_authority];
    let ma_seeds: &[&[u8]] = &[SEED_MINT_AUTHORITY, launch_key.as_ref(), &ma_bump];
    token::mint_to(
        CpiContext::new_with_signer(
            tp.clone(),
            MintTo {
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.pool_token.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            &[ma_seeds],
        ),
        seed_tokens,
    )?;

    // 3. Fee-credit advance: CreditPool vault → buyback vault.
    if credit > 0 {
        let qm = ctx.accounts.launch.quote_mint;
        let cp_bump = [ctx.accounts.credit_pool.bump];
        let cp_seeds: &[&[u8]] = &[SEED_CREDIT_POOL, qm.as_ref(), &cp_bump];
        token::transfer(
            CpiContext::new_with_signer(
                tp.clone(),
                Transfer {
                    from: ctx.accounts.credit_vault.to_account_info(),
                    to: ctx.accounts.buyback_vault.to_account_info(),
                    authority: ctx.accounts.credit_pool.to_account_info(),
                },
                &[cp_seeds],
            ),
            credit,
        )?;
        let cp = &mut ctx.accounts.credit_pool;
        cp.outstanding = cp.outstanding.checked_add(credit).ok_or(ErrorCode::MathOverflow)?;
        cp.total_advanced = cp.total_advanced.checked_add(credit).ok_or(ErrorCode::MathOverflow)?;
    }

    let pool = &mut ctx.accounts.pool;
    pool.launch = launch_key;
    pool.quote_reserve = seed_quote;
    pool.token_reserve = seed_tokens;
    pool.bump = ctx.bumps.pool;

    let l = &mut ctx.accounts.launch;
    l.pool_quote_seeded = seed_quote;
    l.graduation_slot = clock.slot;
    l.graduated_ts = clock.unix_timestamp;
    l.credit_line = credit;
    l.credit_outstanding = credit;
    l.vault_initial = credit;
    l.next_drip_ts = clock.unix_timestamp.checked_add(l.drip_interval_sec).ok_or(ErrorCode::MathOverflow)?;
    l.status = if credit > 0 { LaunchStatus::Live } else { LaunchStatus::Flywheel };
    emit!(Graduated { launch: launch_key, slot: clock.slot, credit_line: credit });
    if credit == 0 {
        emit!(FlywheelActivated { launch: launch_key });
    }
    Ok(())
}
