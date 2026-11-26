# Sealed — overview

Sealed is a Solana token launchpad. Every launch opens with a sealed-bid auction, clears at one uniform price, and graduates into a pool that gets a buyback budget on day one. Trading fees repay that budget, then flow to holders permanently.

In-app version: `/docs` on the web app. Live: website https://www.sealedsol.xyz · API https://api-production-01dc1743.up.railway.app (`/api/health`, `/llms.txt`).

## Execution mode

Sealed runs **offchain and custodial by default**. The Railway backend runs auctions, clearing, the graduation pool, buyback drips, fee splits and holder rewards in a Postgres double-entry ledger. Users sign in with their wallet (SIWS), deposit SOL/SPL to the company wallet `DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j` with memo `sealed:<depositRef>`, trade against internal balances, and withdraw. See [CUSTODY.md](CUSTODY.md). The Anchor program in `programs/` is the **future non-custodial mode** ("Onchain mode — roadmap").

## The four-phase loop

1. **Launch setup.** Name, ticker, quote asset (SOL, USDC or a tokenized stock), auction timing, floor, tick, target raise, clearing cap. Creator allocation ≤ 2% (`MAX_CREATOR_ALLOCATION_BPS = 200`).
2. **Sealed auction.** Commit `keccak256(bidder ‖ max_price u64le ‖ bid_amount u64le ‖ salt[32])` plus collateral; reveal later; clear at one uniform price over a 64-tick grid. Unrevealed bids lose 1%.
3. **Graduate + buyback vault.** The raise and pool supply seed a locked constant-product pool. The Credit Pool advances 10/12.5/15% of the raise (standard/plus/premier) into a vault that can only buy-and-burn, in 48 drips every 120–300 s (default 180 s).
4. **Repay → flywheel.** The 1% pool fee splits 80% credit repayment / 20% platform ops until outstanding credit is exactly 0, then 50% holders / 35% platform buyback-burn / 15% treasury. Buyers in the graduation slot (offchain: within 2 s) earn 0% holder rewards.

The math lives once in `@sealed/shared` (`computeClearing`, `settleBid`, `splitFees`, `computeCommitment`) and is mirrored in Rust.

## Status (2026-11-26)

| Capability | Status |
|---|---|
| Demo world (API `DEMO_MODE` or in-browser fallback) | Live in demo |
| Offchain custodial backend (ledger, SIWS, deposits, payouts, proof of reserves) | In development (`apps/api/src/offchain`, contract `packages/shared/src/custody.ts`) |
| Clearing / fee / commitment math | Off-chain, tests passing (shared 7/7, invariants 34 + 1 todo) |
| Anchor program | Implemented on-chain, tests pending — not built here, **not deployed** (program id has no devnet account) |
| Helius Privacy Rings | Simulated in demo; status probe + RPC proxy real; private escrow planned |
| Mainnet, audit | Planned — neither exists |

## Docs index

[ARCHITECTURE](ARCHITECTURE.md) · [MECHANICS](MECHANICS.md) · [CUSTODY](CUSTODY.md) · [PROGRAM](PROGRAM.md) · [API](API.md) · [STACK](STACK.md) · [DEPLOYMENT](DEPLOYMENT.md) · [SECURITY](SECURITY.md) · [PRIVACY](PRIVACY.md)
