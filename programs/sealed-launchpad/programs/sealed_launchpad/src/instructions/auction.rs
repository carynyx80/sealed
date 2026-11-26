use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::ErrorCode;
use crate::events::*;
use crate::math;
use crate::state::*;

/// True when `acc` is an initialized AntiSnipeEntry owned by this program.
pub fn is_sniper(acc: &AccountInfo) -> bool {
    acc.owner == &crate::ID && !acc.data_is_empty()
}

// ---------------------------------------------------------------- commit_bid

#[derive(Accounts)]
pub struct CommitBid<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(mut, seeds = [SEED_LAUNCH, launch.token_mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, LaunchAccount>>,
    #[account(
        init,
        payer = bidder,
        space = 8 + SealedBid::INIT_SPACE,
        seeds = [SEED_BID, launch.key().as_ref(), bidder.key().as_ref()],
        bump
    )]
    pub bid: Box<Account<'info, SealedBid>>,
    #[account(mut, seeds = [SEED_ESCROW, launch.key().as_ref()], bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = launch.quote_mint, token::authority = bidder)]
    pub bidder_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn commit_bid_handler(ctx: Context<CommitBid>, commitment: [u8; 32], deposit: u64) -> Result<()> {
    require!(deposit > 0, ErrorCode::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let launch = &mut ctx.accounts.launch;
    require!(launch.status == LaunchStatus::Open, ErrorCode::CommitWindowClosed);
    require!(now >= launch.commit_start_ts && now < launch.commit_end_ts, ErrorCode::CommitWindowClosed);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.bidder_quote.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.bidder.to_account_info(),
            },
        ),
        deposit,
    )?;

    let bid = &mut ctx.accounts.bid;
    bid.launch = launch.key();
    bid.bidder = ctx.accounts.bidder.key();
    bid.commitment = commitment;
    bid.deposit = deposit;
    bid.revealed = false;
    bid.max_price = 0;
    bid.bid_amount = 0;
    bid.tick = 0;
    bid.claimed = false;
    bid.bump = ctx.bumps.bid;

    launch.bid_count = launch.bid_count.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
    launch.total_escrowed = launch.total_escrowed.checked_add(deposit).ok_or(ErrorCode::MathOverflow)?;
    emit!(BidCommitted { launch: launch.key(), bid_count: launch.bid_count, total_escrowed: launch.total_escrowed });
    Ok(())
}

// ---------------------------------------------------------------- reveal_bid

#[derive(Accounts)]
pub struct RevealBid<'info> {
    /// Anyone may submit the reveal (bidder or the auto-reveal relayer).
    pub payer: Signer<'info>,
    #[account(mut, seeds = [SEED_LAUNCH, launch.token_mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, LaunchAccount>>,
    /// CHECK: bidder wallet; bound by the bid PDA seeds and the commitment preimage.
    pub bidder: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [SEED_BID, launch.key().as_ref(), bidder.key().as_ref()],
        bump = bid.bump,
        has_one = bidder,
        has_one = launch,
    )]
    pub bid: Box<Account<'info, SealedBid>>,
}

pub fn reveal_bid_handler(ctx: Context<RevealBid>, max_price: u64, bid_amount: u64, salt: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let launch = &mut ctx.accounts.launch;
    let bid = &mut ctx.accounts.bid;
    require!(launch.status == LaunchStatus::Open, ErrorCode::RevealWindowClosed);
    require!(now >= launch.commit_end_ts, ErrorCode::RevealWindowNotOpen);
    require!(now < launch.reveal_end_ts, ErrorCode::RevealWindowClosed);
    require!(!bid.revealed, ErrorCode::AlreadyRevealed);

    let c = math::compute_commitment(&bid.bidder.to_bytes(), max_price, bid_amount, &salt);
    require!(c == bid.commitment, ErrorCode::CommitmentMismatch);
    let tick = math::tick_index(launch.floor_price, launch.tick_size, max_price, NUM_PRICE_TICKS).ok_or(ErrorCode::InvalidTick)?;
    require!(bid_amount <= bid.deposit, ErrorCode::BidExceedsDeposit);

    bid.revealed = true;
    bid.max_price = max_price;
    bid.bid_amount = bid_amount;
    bid.tick = tick;
    let h = &mut launch.histogram[tick as usize];
    *h = h.checked_add(bid_amount).ok_or(ErrorCode::MathOverflow)?;
    launch.revealed_count = launch.revealed_count.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
    emit!(BidRevealed { launch: launch.key(), revealed_count: launch.revealed_count });
    Ok(())
}

// ---------------------------------------------------------------- clear_auction

#[derive(Accounts)]
pub struct ClearAuction<'info> {
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [SEED_LAUNCH, launch.token_mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, LaunchAccount>>,
}

pub fn clear_auction_handler(ctx: Context<ClearAuction>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let l = &mut ctx.accounts.launch;
    require!(l.status == LaunchStatus::Open, ErrorCode::InvalidStatus);
    require!(now >= l.reveal_end_ts, ErrorCode::AuctionNotEnded);
    let r = math::compute_clearing(l.floor_price, l.tick_size, &l.histogram, l.tokens_for_sale, l.clearing_cap)
        .ok_or(ErrorCode::MathOverflow)?;
    l.clearing_price = r.clearing_price;
    l.marginal_tick = r.marginal_tick;
    l.fill_rule = r.rule;
    l.fill_num = r.fill_num;
    l.fill_den = r.fill_den;
    l.total_raised = r.total_raised;
    l.tokens_sold = r.tokens_sold;
    l.status = if r.marginal_tick < 0 || r.total_raised == 0 { LaunchStatus::Failed } else { LaunchStatus::Cleared };
    emit!(AuctionCleared {
        launch: l.key(),
        clearing_price: l.clearing_price,
        total_raised: l.total_raised,
        tokens_sold: l.tokens_sold,
    });
    Ok(())
}

// ---------------------------------------------------------------- claim_or_refund

#[derive(Accounts)]
pub struct ClaimOrRefund<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(seeds = [SEED_PROTOCOL], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [SEED_LAUNCH, launch.token_mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, LaunchAccount>>,
    #[account(
        mut,
        close = bidder,
        seeds = [SEED_BID, launch.key().as_ref(), bidder.key().as_ref()],
        bump = bid.bump,
        has_one = bidder,
        has_one = launch,
    )]
    pub bid: Box<Account<'info, SealedBid>>,
    #[account(mut, address = launch.token_mint)]
    pub token_mint: Box<Account<'info, Mint>>,
    /// CHECK: mint authority PDA (signs mint_to).
    #[account(seeds = [SEED_MINT_AUTHORITY, launch.key().as_ref()], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_ESCROW, launch.key().as_ref()], bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = launch.quote_mint, token::authority = bidder)]
    pub bidder_quote: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = bidder,
        associated_token::mint = token_mint,
        associated_token::authority = bidder,
    )]
    pub bidder_token: Box<Account<'info, TokenAccount>>,
    /// Treasury quote token account (receives the no-reveal slash).
    #[account(
        mut,
        constraint = treasury_quote.owner == protocol.treasury @ ErrorCode::InvalidAccount,
        constraint = treasury_quote.mint == launch.quote_mint @ ErrorCode::InvalidAccount,
    )]
    pub treasury_quote: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = bidder,
        space = 8 + HolderPosition::INIT_SPACE,
        seeds = [SEED_POSITION, launch.key().as_ref(), bidder.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, HolderPosition>>,
    #[account(mut, seeds = [SEED_STAKE_VAULT, launch.key().as_ref()], bump)]
    pub stake_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: AntiSnipeEntry PDA for (launch, bidder); only its existence is inspected.
    #[account(seeds = [SEED_ANTI_SNIPE, launch.key().as_ref(), bidder.key().as_ref()], bump)]
    pub anti_snipe: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_or_refund_handler(ctx: Context<ClaimOrRefund>, stake: bool) -> Result<()> {
    let launch_key = ctx.accounts.launch.key();
    let status = ctx.accounts.launch.status;
    require!(status != LaunchStatus::Open, ErrorCode::AuctionNotCleared);
    require!(!ctx.accounts.bid.claimed, ErrorCode::AlreadyClaimed);

    let (refund, slash, tokens) = {
        let l = &ctx.accounts.launch;
        let b = &ctx.accounts.bid;
        if status == LaunchStatus::Failed {
            (b.deposit, 0u64, 0u64)
        } else if !b.revealed {
            let slash = (b.deposit as u128 * NO_REVEAL_SLASH_BPS as u128 / BPS_DENOMINATOR as u128) as u64;
            (b.deposit - slash, slash, 0u64)
        } else {
            let s = math::settle_bid(
                l.clearing_price,
                l.marginal_tick,
                l.fill_rule,
                l.fill_num,
                l.fill_den,
                l.floor_price,
                l.tick_size,
                b.tick,
                b.bid_amount,
                b.deposit,
            )
            .ok_or(ErrorCode::MathOverflow)?;
            (s.refund, 0u64, s.tokens)
        }
    };
    ctx.accounts.bid.claimed = true;

    let token_mint_key = ctx.accounts.launch.token_mint;
    let launch_bump = [ctx.accounts.launch.bump];
    let launch_seeds: &[&[u8]] = &[SEED_LAUNCH, token_mint_key.as_ref(), &launch_bump];
    let tp = ctx.accounts.token_program.to_account_info();

    if refund > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                tp.clone(),
                Transfer {
                    from: ctx.accounts.escrow.to_account_info(),
                    to: ctx.accounts.bidder_quote.to_account_info(),
                    authority: ctx.accounts.launch.to_account_info(),
                },
                &[launch_seeds],
            ),
            refund,
        )?;
    }
    if slash > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                tp.clone(),
                Transfer {
                    from: ctx.accounts.escrow.to_account_info(),
                    to: ctx.accounts.treasury_quote.to_account_info(),
                    authority: ctx.accounts.launch.to_account_info(),
                },
                &[launch_seeds],
            ),
            slash,
        )?;
    }

    // Initialise position bookkeeping on first touch.
    {
        let pos = &mut ctx.accounts.position;
        if pos.owner == Pubkey::default() {
            pos.launch = launch_key;
            pos.owner = ctx.accounts.bidder.key();
            pos.bump = ctx.bumps.position;
        }
    }

    if tokens > 0 {
        let do_stake = stake;
        if do_stake {
            require!(!is_sniper(&ctx.accounts.anti_snipe.to_account_info()), ErrorCode::SniperIneligible);
        }
        let ma_bump = [ctx.bumps.mint_authority];
        let ma_seeds: &[&[u8]] = &[SEED_MINT_AUTHORITY, launch_key.as_ref(), &ma_bump];
        let to = if do_stake {
            ctx.accounts.stake_vault.to_account_info()
        } else {
            ctx.accounts.bidder_token.to_account_info()
        };
        token::mint_to(
            CpiContext::new_with_signer(
                tp.clone(),
                MintTo {
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to,
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[ma_seeds],
            ),
            tokens,
        )?;
        if do_stake {
            let l = &mut ctx.accounts.launch;
            let pos = &mut ctx.accounts.position;
            let pending = math::pending_rewards(pos.staked, l.reward_per_share, pos.reward_debt);
            pos.unclaimed = pos.unclaimed.checked_add(pending).ok_or(ErrorCode::MathOverflow)?;
            pos.staked = pos.staked.checked_add(tokens).ok_or(ErrorCode::MathOverflow)?;
            pos.reward_debt = math::reward_debt(pos.staked, l.reward_per_share);
            l.total_staked = l.total_staked.checked_add(tokens).ok_or(ErrorCode::MathOverflow)?;
        }
    }
    Ok(())
}
