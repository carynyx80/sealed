# Onchain program — `sealed_launchpad` (roadmap non-custodial mode)

Status: **implemented on-chain, tests pending.** Program id `71geDPZMKfjJnKE4an15QyyH5TyFG1w7XEL5tUkp5Tpy` has **no account on devnet** (checked 2026-11-26); no `.so` built in this workspace. Anchor 0.32. IDL: `programs/sealed-launchpad/idl/sealed_launchpad.json`. Contract: `packages/shared/src/program.ts`.

## Instructions (14)
| Instruction | Caller | Args | Emits |
|---|---|---|---|
| initialize_protocol | admin once | treasury, platform_ops, keeper, is_mainnet, max_credit_per_launch | — |
| fund_credit_pool | anyone | amount | — |
| create_launch | creator | name, ticker, uri, total_supply, creator_allocation_bps (≤200), auction_supply_bps (2000–6000), credit_bps (1000–1500), commit/reveal durations, floor_price, tick_size, target_raise, clearing_cap, drip_interval_sec (120–300), drip_count | LaunchCreated |
| commit_bid | bidder | commitment[32], deposit | BidCommitted (aggregates only) |
| reveal_bid | anyone with preimage | max_price, bid_amount, salt[32] | BidRevealed |
| clear_auction | anyone after reveal_end | — | AuctionCleared |
| claim_or_refund | bidder | stake: bool | — |
| graduate_and_open_credit | anyone after clear | — | Graduated (+FlywheelActivated if credit 0) |
| swap | anyone, live | amount_in, min_amount_out, is_buy | SwapEvent, SniperFlagged |
| execute_buyback_drip | anyone when due | — | BuybackDrip |
| distribute_fees | anyone, live | — | FeesDistributed, FlywheelActivated |
| stake / unstake | holder | amount | — |
| claim_rewards | holder | — | — |

No instruction moves funds out of `buyback_vault` except `execute_buyback_drip` (into the pool quote reserve). Note: README previously listed `repay_credit` / `distribute_rewards`; the real instruction is `distribute_fees`.

## Accounts
ProtocolConfig, CreditPool, LaunchAccount (incl. `histogram: [u64; 64]`, clearing result, graduation/credit/drip/reward state, plus program-only `auction_supply_bps, creator_allocation_bps, pool_quote_seeded, name, ticker, uri`), SealedBid, Pool, AntiSnipeEntry (created manually in `swap`, not in IDL accounts), HolderPosition (+`unclaimed`). Status u8: Open 0, Cleared 1, Failed 2, Live 3, Flywheel 4.

## PDA seeds
`protocol` · `credit_pool, quote_mint` · `launch, token_mint` · `bid, launch, bidder` · `escrow, launch` · `buyback_vault, launch` · `fee_collector, launch` · `pool, launch` · `pool_quote, launch` · `pool_token, launch` · `anti_snipe, launch, wallet` · `position, launch, owner` · `rewards_vault, launch` · `mint_authority, launch` · program-only `credit_vault, quote_mint` and `stake_vault, launch`.

## Errors
6000–6022 (order of `PROGRAM_ERRORS`): CreatorAllocationTooHigh, InvalidAuctionSupply, InvalidCreditBps, InvalidDuration, InvalidDripInterval, CommitWindowClosed, RevealWindowNotOpen, RevealWindowClosed, CommitmentMismatch, InvalidTick, BidExceedsDeposit, AlreadyRevealed, AuctionNotEnded, AuctionNotCleared, AlreadyClaimed, AlreadyGraduated, DripNotDue, VaultEmpty, SlippageExceeded, SniperIneligible, InsufficientStake, MathOverflow, Unauthorized. 6023–6027: InvalidParams, InvalidStatus, ZeroAmount, NotLive, InvalidAccount.

## Tests
`programs/sealed-launchpad/tests/sealed-launchpad.ts` (full lifecycle, cap, vault guard, flywheel flip, sniper exclusion, failed auction) and 14 `math.rs` unit tests. Not yet run here: `pnpm anchor:test`.

## Known gap
`apps/api/src/workers/buybackKeeper.ts` passes `keeper` (IDL: `cranker`) and omits `token_mint` (drip) and `credit_vault`, `platform_ops_quote`, `treasury_quote` (distribute_fees).
