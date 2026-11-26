# Sealed — overview

Sealed is a Solana token launchpad. Every launch opens with a sealed-bid auction, clears at one uniform price, and graduates into a pool that gets a buyback budget on day one. Trading fees repay that budget, then flow to holders permanently.

In-app version: `/docs` on the web app. Live: website https://www.sealedsol.xyz · API https://api-production-01dc1743.up.railway.app (`/api/health`, `/llms.txt`). Network: **Solana mainnet** (switch from devnet rolling out).

> **Real funds · custodial risk disclosure.** Sealed is custodial and runs on Solana **mainnet with real funds**.
> - **The company holds your funds.** Deposits sit in the company wallet [`DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j`](https://explorer.solana.com/address/DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j); your balance is a Sealed ledger entry, not a token account you control. The operator can pause, delay or refuse withdrawals, and a compromised company wallet key could lose every deposit. No insurance, no deposit guarantee, no multisig yet.
> - **Withdrawals may need manual approval:** above $2,500 USD-equivalent, above $25,000 per wallet per day (`WITHDRAWAL_LIMITS`), or when no fresh live price is available. Payouts pause, with a reason, when the company wallet lacks SOL for fees.
> - **Only SOL and USDC withdraw.** Launched tokens are custodial ledger balances and cannot be withdrawn on-chain yet.
> - **Proof of reserves** (`GET /api/custody/info`) compares the company wallet's on-chain balances, checkable on the [Explorer](https://explorer.solana.com/address/DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j), with ledger liabilities. It is a snapshot; it does not prove the ledger is complete or that the key is safe.
> - **Not audited.** Neither the custodial backend nor the Anchor program has had a third-party audit; the program is not deployed.
> - **Jurisdiction.** Sealed is not a bank, broker or licensed custodian, and nothing here is investment advice. You are responsible for making sure your use of Sealed is lawful where you live (securities, tax, sanctions). Do not use it where prohibited. Deposit only what you can afford to lose.

## Execution mode

Sealed runs **offchain and custodial on Solana mainnet**. The Railway backend runs auctions, clearing, the graduation pool, buyback drips, fee splits and holder rewards in a Postgres double-entry ledger. Users sign in with their wallet (SIWS), deposit SOL or USDC to the company wallet [`DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j`](https://explorer.solana.com/address/DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j) with memo `sealed:<depositRef>`, trade against internal balances, and withdraw SOL or USDC. Launched tokens stay as ledger balances for now. See [CUSTODY.md](CUSTODY.md). The Anchor program in `programs/` is the **future non-custodial mode** ("Onchain mode — roadmap") and is not deployed.

## The four-phase loop

1. **Launch setup.** Name, ticker, quote asset (SOL or USDC on mainnet; tokenized stocks coming soon), auction timing (15–30 min commit window on mainnet), floor, tick, target raise, clearing cap. Creator allocation ≤ 2% (`MAX_CREATOR_ALLOCATION_BPS = 200`).
2. **Sealed auction.** Commit `keccak256(bidder ‖ max_price u64le ‖ bid_amount u64le ‖ salt[32])` plus collateral; reveal later; clear at one uniform price over a 64-tick grid. Unrevealed bids lose 1%.
3. **Graduate + buyback vault.** The raise and pool supply seed a locked constant-product pool. The Credit Pool advances 10/12.5/15% of the raise (standard/plus/premier) into a vault that can only buy-and-burn, in 48 drips every 120–300 s (default 180 s); the first drip is due one interval after graduation.
4. **Repay → flywheel.** The 1% pool fee splits 80% credit repayment / 20% platform ops until outstanding credit is exactly 0, then 50% holders / 35% platform buyback-burn / 15% treasury. Buyers in the graduation slot (offchain: within 2 s) earn 0% holder rewards.

The math lives once in `@sealed/shared` (`computeClearing`, `settleBid`, `splitFees`, `computeCommitment`) and is mirrored in Rust.

## Moving to mainnet (2026-11-26)

These changes are being made now; each is "rolling out" until it can be checked on the hosted API.

| Mainnet change | Status |
|---|---|
| `NETWORK=mainnet` (API), `NEXT_PUBLIC_NETWORK=mainnet` (web) | Rolling out — confirm `network` in `/api/health` |
| Demo mode disabled on mainnet: no demo launches, no `demo-bid`, no in-browser fallback | Rolling out |
| Quote assets on mainnet: SOL and USDC. Tokenized stocks (NVDAx, TSLAx, TTWOx, AAPLx, SPYx) coming soon — mainnet mints not verified | Rolling out |
| Withdrawal USD limits from live Jupiter Price API prices; no fresh price → manual approval (`pending_approval`) | Rolling out |
| Payouts pause with a reason when the company wallet lacks SOL for fees | Rolling out |
| Browser RPC proxy `POST /api/rpc`: allowlisted methods, rate limited, provider key never exposed | Rolling out |
| Admin approvals (`/api/admin/*`) require `ADMIN_TOKEN` | Rolling out |
| Mainnet launches require a 15–30 min commit window (`MIN_COMMIT_DURATION_SEC_MAINNET`–`MAX_COMMIT_DURATION_SEC`) | Rolling out |
| Launched tokens are custodial ledger balances; only SOL/USDC withdraw on-chain | Rolling out |
| Anchor program (non-custodial onchain mode) | Roadmap — not deployed |

## Status (2026-11-26)

| Capability | Status |
|---|---|
| Offchain ledger engine, SIWS auth, trade/account/custody/admin routes | Off-chain, tests passing; live on Railway with Postgres + Redis (`apps/api/src/offchain`, `apps/api/src/routes`); moving to mainnet |
| Deposit detection and payouts | Built + tested; on mainnet need `HELIUS_API_KEY`, `COMPANY_WALLET_SECRET_KEY` and SOL in the company wallet for fees — rolling out (check `payoutsEnabled` in `/api/custody/info`) |
| Demo world | Local development and devnet only; disabled on mainnet |
| Clearing / fee / commitment math | Off-chain, tests passing (shared 7/7, invariants 34 + 1 todo) |
| Anchor program | On-chain, tests passing (anchor build OK, 15/15 Rust, 18/18 `anchor test -- --features test-mode`) — **not deployed** (roadmap) |
| Helius Privacy Rings | Simulated in demo; status probe + RPC proxy real; private escrow planned |
| Audit | None |

## Docs index

[ARCHITECTURE](ARCHITECTURE.md) · [MECHANICS](MECHANICS.md) · [CUSTODY](CUSTODY.md) · [PROGRAM](PROGRAM.md) · [API](API.md) · [STACK](STACK.md) · [DEPLOYMENT](DEPLOYMENT.md) · [SECURITY](SECURITY.md) · [PRIVACY](PRIVACY.md)
