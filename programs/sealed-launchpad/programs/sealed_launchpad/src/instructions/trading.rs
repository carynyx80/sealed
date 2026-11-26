use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::ErrorCode;
use crate::events::*;
use crate::math;
use crate::state::*;

fn require_live(s: LaunchStatus) -> Result<()> {
    require!(s == LaunchStatus::Live || s == LaunchStatus::Flywheel, ErrorCode::NotLive);
    Ok(())
}

// ---------------------------------------------------------------- swap

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [SEED_PROTOCOL], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [SEED_LAUNCH, launch.token_mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, LaunchAccount>>,
    #[account(address = launch.token_mint)]
    pub token_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [SEED_POOL, launch.key().as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [SEED_POOL_QUOTE, launch.key().as_ref()], bump)]
    pub pool_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [SEED_POOL_TOKEN, launch.key().as_ref()], bump)]
    pub pool_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [SEED_FEE_COLLECTOR, launch.key().as_ref()], bump)]
    pub fee_collector: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = launch.quote_mint, token::authority = user)]
    pub user_quote: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = token_mint,
        associated_token::authority = user,
    )]
    pub user_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: AntiSnipeEntry PDA for (launch, user). Created by this instruction only on a same-slot buy.
    #[account(mut, seeds = [SEED_ANTI_SNIPE, launch.key().as_ref(), user.key().as_ref()], bump)]
    pub anti_snipe: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

fn record_sniper(ctx: &mut Context<Swap>, slot: u64) -> Result<()> {
    let launch_key = ctx.accounts.launch.key();
    let user_key = ctx.accounts.user.key();
    let info = ctx.accounts.anti_snipe.to_account_info();
    if !info.data_is_empty() {
        return Ok(()); // already recorded
    }
    let space = 8 + AntiSnipeEntry::INIT_SPACE;
    let rent = Rent::get()?.minimum_balance(space);
    let bump = [ctx.bumps.anti_snipe];
    let seeds: &[&[u8]] = &[SEED_ANTI_SNIPE, launch_key.as_ref(), user_key.as_ref(), &bump];
    let sp = ctx.accounts.system_program.to_account_info();
    let current = info.lamports();
    if current == 0 {
        system_program::create_account(
            CpiContext::new_with_signer(
                sp,
                system_program::CreateAccount { from: ctx.accounts.user.to_account_info(), to: info.clone() },
                &[seeds],
            ),
            rent,
            space as u64,
            &crate::ID,
        )?;
    } else {
        // Pre-funded PDA: top up, allocate, assign.
        if current < rent {
            system_program::transfer(
                CpiContext::new(
                    sp.clone(),
                    system_program::Transfer { from: ctx.accounts.user.to_account_info(), to: info.clone() },
                ),
                rent - current,
            )?;
        }
        system_program::allocate(
            CpiContext::new_with_signer(sp.clone(), system_program::Allocate { account_to_allocate: info.clone() }, &[seeds]),
            space as u64,
        )?;
        system_program::assign(
            CpiContext::new_with_signer(sp, system_program::Assign { account_to_assign: info.clone() }, &[seeds]),
            &crate::ID,
        )?;
    }
    let entry = AntiSnipeEntry { launch: launch_key, wallet: user_key, slot, bump: ctx.bumps.anti_snipe };
    let mut data = info.try_borrow_mut_data()?;
    let mut w: &mut [u8] = &mut data;
    entry.try_serialize(&mut w)?;
    drop(data);
    let p = &mut ctx.accounts.protocol;
    p.snipers_blocked = p.snipers_blocked.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
    emit!(SniperFlagged { launch: launch_key, wallet: user_key, slot });
    Ok(())
}

pub fn swap_handler(mut ctx: Context<Swap>, amount_in: u64, min_amount_out: u64, is_buy: bool) -> Result<()> {
    require_live(ctx.accounts.launch.status)?;
    require!(amount_in > 0, ErrorCode::ZeroAmount);
    let clock = Clock::get()?;

    let token_mint_key = ctx.accounts.launch.token_mint;
    let launch_bump = [ctx.accounts.launch.bump];
    let launch_seeds: &[&[u8]] = &[SEED_LAUNCH, token_mint_key.as_ref(), &launch_bump];
    let tp = ctx.accounts.token_program.to_account_info();
    let qr = ctx.accounts.pool.quote_reserve;
    let tr = ctx.accounts.pool.token_reserve;

    let fee;
    let amount_out;
    if is_buy {
        fee = math::pool_fee(amount_in);
        let net = amount_in - fee;
        let out = math::cpmm_out(net, qr, tr);
        require!(out > 0 && out >= min_amount_out && out < tr, ErrorCode::SlippageExceeded);
        let a = &ctx.accounts;
        token::transfer(
            CpiContext::new(
                tp.clone(),
                Transfer { from: a.user_quote.to_account_info(), to: a.pool_quote.to_account_info(), authority: a.user.to_account_info() },
            ),
            net,
        )?;
        if fee > 0 {
            token::transfer(
                CpiContext::new(
                    tp.clone(),
                    Transfer { from: a.user_quote.to_account_info(), to: a.fee_collector.to_account_info(), authority: a.user.to_account_info() },
                ),
                fee,
            )?;
        }
        token::transfer(
            CpiContext::new_with_signer(
                tp.clone(),
                Transfer { from: a.pool_token.to_account_info(), to: a.user_token.to_account_info(), authority: a.launch.to_account_info() },
                &[launch_seeds],
            ),
            out,
        )?;
        let pool = &mut ctx.accounts.pool;
        pool.quote_reserve = qr.checked_add(net).ok_or(ErrorCode::MathOverflow)?;
        pool.token_reserve = tr - out;
        amount_out = out;
    } else {
        let gross = math::cpmm_out(amount_in, tr, qr);
        fee = math::pool_fee(gross);
        let net = gross - fee;
        require!(net > 0 && net >= min_amount_out && gross < qr, ErrorCode::SlippageExceeded);
        let a = &ctx.accounts;
        token::transfer(
            CpiContext::new(
                tp.clone(),
                Transfer { from: a.user_token.to_account_info(), to: a.pool_token.to_account_info(), authority: a.user.to_account_info() },
            ),
            amount_in,
        )?;
        token::transfer(
            CpiContext::new_with_signer(
                tp.clone(),
                Transfer { from: a.pool_quote.to_account_info(), to: a.user_quote.to_account_info(), authority: a.launch.to_account_info() },
                &[launch_seeds],
            ),
            net,
        )?;
        if fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    tp.clone(),
                    Transfer { from: a.pool_quote.to_account_info(), to: a.fee_collector.to_account_info(), authority: a.launch.to_account_info() },
                    &[launch_seeds],
                ),
                fee,
            )?;
        }
        let pool = &mut ctx.accounts.pool;
        pool.token_reserve = tr.checked_add(amount_in).ok_or(ErrorCode::MathOverflow)?;
        pool.quote_reserve = qr - gross;
        amount_out = net;
    }

    {
        let l = &mut ctx.accounts.launch;
        l.fees_collected = l.fees_collected.checked_add(fee).ok_or(ErrorCode::MathOverflow)?;
    }

    let is_sniper = is_buy && clock.slot == ctx.accounts.launch.graduation_slot;
    if is_sniper {
        record_sniper(&mut ctx, clock.slot)?;
    }
    emit!(SwapEvent {
        launch: ctx.accounts.launch.key(),
        trader: ctx.accounts.user.key(),
        is_buy,
        amount_in,
        amount_out,
        fee,
        slot: clock.slot,
        is_sniper,
    });
    Ok(())
}

// ---------------------------------------------------------------- execute_buyback_drip

#[derive(Accounts)]
pub struct ExecuteBuybackDrip<'info> {
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [SEED_LAUNCH, launch.token_mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, LaunchAccount>>,
    #[account(mut, address = launch.token_mint)]
    pub token_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [SEED_POOL, launch.key().as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [SEED_POOL_QUOTE, launch.key().as_ref()], bump)]
    pub pool_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [SEED_POOL_TOKEN, launch.key().as_ref()], bump)]
    pub pool_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [SEED_VAULT, launch.key().as_ref()], bump)]
    pub buyback_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn execute_buyback_drip_handler(ctx: Context<ExecuteBuybackDrip>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require_live(ctx.accounts.launch.status)?;
    let (amount, out) = {
        let l = &ctx.accounts.launch;
        require!(l.drips_executed < l.drip_count, ErrorCode::VaultEmpty);
        require!(now >= l.next_drip_ts, ErrorCode::DripNotDue);
        let amount = math::drip_amount(l.vault_initial, l.drip_count, l.drips_executed, ctx.accounts.buyback_vault.amount);
        require!(amount > 0, ErrorCode::VaultEmpty);
        let out = math::cpmm_out(amount, ctx.accounts.pool.quote_reserve, ctx.accounts.pool.token_reserve);
        require!(out < ctx.accounts.pool.token_reserve, ErrorCode::MathOverflow);
        (amount, out)
    };

    let token_mint_key = ctx.accounts.launch.token_mint;
    let launch_bump = [ctx.accounts.launch.bump];
    let launch_seeds: &[&[u8]] = &[SEED_LAUNCH, token_mint_key.as_ref(), &launch_bump];
    let tp = ctx.accounts.token_program.to_account_info();

    // Vault quote → pool (fee-free buy), tokens out are burned straight from the pool reserve.
    token::transfer(
        CpiContext::new_with_signer(
            tp.clone(),
            Transfer {
                from: ctx.accounts.buyback_vault.to_account_info(),
                to: ctx.accounts.pool_quote.to_account_info(),
                authority: ctx.accounts.launch.to_account_info(),
            },
            &[launch_seeds],
        ),
        amount,
    )?;
    if out > 0 {
        token::burn(
            CpiContext::new_with_signer(
                tp,
                Burn {
                    mint: ctx.accounts.token_mint.to_account_info(),
                    from: ctx.accounts.pool_token.to_account_info(),
                    authority: ctx.accounts.launch.to_account_info(),
                },
                &[launch_seeds],
            ),
            out,
        )?;
    }

    let pool = &mut ctx.accounts.pool;
    pool.quote_reserve = pool.quote_reserve.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
    pool.token_reserve -= out;
    let l = &mut ctx.accounts.launch;
    l.tokens_burned = l.tokens_burned.checked_add(out).ok_or(ErrorCode::MathOverflow)?;
    l.drips_executed += 1;
    l.next_drip_ts = now.checked_add(l.drip_interval_sec).ok_or(ErrorCode::MathOverflow)?;
    emit!(BuybackDrip {
        launch: l.key(),
        quote_spent: amount,
        tokens_burned: out,
        drip_index: l.drips_executed,
        next_drip_ts: l.next_drip_ts,
    });
    Ok(())
}
