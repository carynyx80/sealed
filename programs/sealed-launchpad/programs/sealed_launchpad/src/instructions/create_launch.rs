use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

use crate::constants::*;
use crate::errors::ErrorCode;
use crate::events::LaunchCreated;
use crate::state::*;

#[derive(Accounts)]
pub struct CreateLaunch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [SEED_PROTOCOL], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
    /// CHECK: PDA used only as the token mint authority; holds no data.
    #[account(seeds = [SEED_MINT_AUTHORITY, launch.key().as_ref()], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    /// New launch token mint (fresh keypair, signs). 6 decimals, mint authority = mint_authority PDA, no freeze authority.
    #[account(
        init,
        payer = creator,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = mint_authority,
    )]
    pub token_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = creator,
        space = 8 + LaunchAccount::INIT_SPACE,
        seeds = [SEED_LAUNCH, token_mint.key().as_ref()],
        bump
    )]
    pub launch: Box<Account<'info, LaunchAccount>>,
    #[account(
        init,
        payer = creator,
        seeds = [SEED_ESCROW, launch.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = launch,
    )]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = creator,
        seeds = [SEED_STAKE_VAULT, launch.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = launch,
    )]
    pub stake_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = creator,
        seeds = [SEED_REWARDS_VAULT, launch.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = launch,
    )]
    pub rewards_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = creator,
        associated_token::mint = token_mint,
        associated_token::authority = creator,
    )]
    pub creator_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

fn validate_durations(is_mainnet: bool, commit: i64, reveal: i64, drip_interval: i64, drip_count: u16) -> Result<()> {
    let relaxed = cfg!(feature = "test-mode") && !is_mainnet;
    let min_commit = if is_mainnet {
        MIN_COMMIT_DURATION_SEC_MAINNET
    } else if relaxed {
        TEST_MODE_MIN_COMMIT_SEC
    } else {
        MIN_COMMIT_DURATION_SEC_DEVNET
    };
    require!(commit >= min_commit && commit <= MAX_COMMIT_DURATION_SEC, ErrorCode::InvalidDuration);
    let min_reveal = if relaxed { TEST_MODE_MIN_REVEAL_SEC } else { MIN_REVEAL_DURATION_SEC };
    require!(reveal >= min_reveal && reveal <= MAX_REVEAL_DURATION_SEC, ErrorCode::InvalidDuration);
    let min_drip = if relaxed { TEST_MODE_MIN_DRIP_INTERVAL_SEC } else { MIN_DRIP_INTERVAL_SEC };
    require!(drip_interval >= min_drip && drip_interval <= MAX_DRIP_INTERVAL_SEC, ErrorCode::InvalidDripInterval);
    require!(drip_count >= 1, ErrorCode::InvalidDripInterval);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn create_launch_handler(
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
    require!(creator_allocation_bps <= MAX_CREATOR_ALLOCATION_BPS, ErrorCode::CreatorAllocationTooHigh);
    require!(
        (MIN_AUCTION_SUPPLY_BPS..=MAX_AUCTION_SUPPLY_BPS).contains(&auction_supply_bps),
        ErrorCode::InvalidAuctionSupply
    );
    require!((MIN_CREDIT_BPS..=MAX_CREDIT_BPS).contains(&credit_bps), ErrorCode::InvalidCreditBps);
    validate_durations(
        ctx.accounts.protocol.is_mainnet,
        commit_duration_sec,
        reveal_duration_sec,
        drip_interval_sec,
        drip_count,
    )?;
    require!(name.len() <= MAX_NAME_LEN && ticker.len() <= MAX_TICKER_LEN && uri.len() <= MAX_URI_LEN, ErrorCode::InvalidParams);
    require!(total_supply > 0 && floor_price > 0 && tick_size > 0 && clearing_cap > 0, ErrorCode::InvalidParams);
    // Highest tick price must not overflow.
    tick_size
        .checked_mul((NUM_PRICE_TICKS - 1) as u64)
        .and_then(|v| v.checked_add(floor_price))
        .ok_or(ErrorCode::MathOverflow)?;

    let d = BPS_DENOMINATOR as u128;
    let creator_allocation = (total_supply as u128 * creator_allocation_bps as u128 / d) as u64;
    let tokens_for_sale = (total_supply as u128 * auction_supply_bps as u128 / d) as u64;
    require!(tokens_for_sale > 0, ErrorCode::InvalidParams);
    // Cap below the floor value of the sale supply is an invalid config.
    require!(
        clearing_cap as u128 >= floor_price as u128 * tokens_for_sale as u128 / TOKEN_UNIT as u128,
        ErrorCode::InvalidParams
    );
    let pool_token_allocation = total_supply
        .checked_sub(creator_allocation)
        .and_then(|v| v.checked_sub(tokens_for_sale))
        .ok_or(ErrorCode::MathOverflow)?;

    let now = Clock::get()?.unix_timestamp;
    let launch_key = ctx.accounts.launch.key();

    {
        let l = &mut ctx.accounts.launch;
        l.creator = ctx.accounts.creator.key();
        l.token_mint = ctx.accounts.token_mint.key();
        l.quote_mint = ctx.accounts.quote_mint.key();
        l.status = LaunchStatus::Open;
        l.total_supply = total_supply;
        l.creator_allocation = creator_allocation;
        l.tokens_for_sale = tokens_for_sale;
        l.pool_token_allocation = pool_token_allocation;
        l.credit_bps = credit_bps;
        l.commit_start_ts = now;
        l.commit_end_ts = now.checked_add(commit_duration_sec).ok_or(ErrorCode::MathOverflow)?;
        l.reveal_end_ts = l.commit_end_ts.checked_add(reveal_duration_sec).ok_or(ErrorCode::MathOverflow)?;
        l.floor_price = floor_price;
        l.tick_size = tick_size;
        l.target_raise = target_raise;
        l.clearing_cap = clearing_cap;
        l.histogram = [0u64; NUM_PRICE_TICKS];
        l.marginal_tick = -1;
        l.fill_den = 1;
        l.drip_interval_sec = drip_interval_sec;
        l.drip_count = drip_count;
        l.bump = ctx.bumps.launch;
        l.auction_supply_bps = auction_supply_bps;
        l.creator_allocation_bps = creator_allocation_bps;
        l.name = name;
        l.ticker = ticker;
        l.uri = uri;
    }

    if creator_allocation > 0 {
        let bump = [ctx.bumps.mint_authority];
        let seeds: &[&[u8]] = &[SEED_MINT_AUTHORITY, launch_key.as_ref(), &bump];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.creator_token.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[seeds],
            ),
            creator_allocation,
        )?;
    }

    let p = &mut ctx.accounts.protocol;
    p.launch_count = p.launch_count.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
    emit!(LaunchCreated {
        launch: launch_key,
        mint: ctx.accounts.token_mint.key(),
        creator: ctx.accounts.creator.key(),
        quote_mint: ctx.accounts.quote_mint.key(),
    });
    Ok(())
}
