# Architecture

```
Browser (Vercel: apps/web, Wallet Adapter, encrypted bid vault)
   │ REST · WS
   ▼
API (Railway: Fastify REST + /ws, ledger engine, workers) ── Postgres (ledger) · Redis (cache/queue)
   │ RPC (Helius)
   ▼
Solana: company wallet (custodial deposits/payouts) · sealed_launchpad (onchain mode, roadmap) · Helius Privacy Rings
```

## Monorepo
| Path | Package | Role |
|---|---|---|
| packages/shared | @sealed/shared | types, Zod schemas, PDAs, clearing/fee/commitment math, custody contract, demo world, REST/WS contract |
| packages/defi | @sealed/defi | Anchor client, Jupiter v6, optional Raydium adapter, CPMM quotes, encrypted bid vault, Privacy Ring clients |
| programs/sealed-launchpad | — | Anchor program + tests + devnet init |
| apps/api | @sealed/api | Fastify REST + WS, Prisma, Redis, workers, `/llms.txt`; `src/offchain/` custodial ledger, engine, SIWS auth and custody (deposit watcher, withdrawals, payouts, reserves); routes `src/routes/{trade,auth,account,custody,admin}.ts` |
| apps/web | @sealed/web | Next.js 15.0.8 / React 19.0.9, Tailwind, framer-motion, in-app `/docs` |
| tests | @sealed/e2e | invariants, API e2e, web smoke |

Dependencies: web → defi → shared; api → shared (not defi). Rust mirrors `constants.ts` and the math.

## Data flow — offchain custodial (default)
SIWS sign-in → bearer token · deposit to company wallet with memo `sealed:<ref>` → detected via Helius, credited after finality · commits/reveals/swaps/claims/stakes post ledger transactions · schedulers clear, graduate, drip and split fees · events stream on `/ws` · withdrawals paid from the company wallet or queued for approval.

## Data flow — onchain (roadmap)
Browser signs program transactions · indexer polls `getProgramAccounts` every 20 s plus `onLogs` (debounced 1.5 s), decodes with the IDL, upserts, emits WS diffs.

## Workers
| Worker | Cadence | Runs when | Status |
|---|---|---|---|
| indexer.ts | 20 s + onLogs | not demo, RPC + IDL | onchain mode; program not deployed |
| revealRelayer.ts | 2 s | always (demo marks revealed) | live in demo; ≤ 8 attempts |
| buybackKeeper.ts | 10 s | not demo, KEEPER_SECRET_KEY | partial — account wiring gap (see PROGRAM.md) |
| demo ticker | DEMO_TICK_MS | DEMO_MODE | live in demo |
| offchain scheduler (clear, graduate, auto-reveal, drips, fees) | OFFCHAIN_TICK_MS (2 s) | EXECUTION_MODE=offchain | off-chain, tests passing; live on Railway |
| deposit watcher | DEPOSIT_POLL_MS (15 s) | RPC set and custody workers on (default `WORKERS_ENABLED && !isDemo`; force with `CUSTODY_WORKERS`) | built + tested; idle on Railway (no `HELIUS_API_KEY`, DEMO_MODE=true) |
| payout worker | PAYOUT_POLL_MS (10 s) | as above + `COMPANY_WALLET_SECRET_KEY` | built + tested; payouts pending operator key |

## Storage
Postgres via Prisma (Launch, Bid, RevealPayload, Trade, BuybackEvent, CreditLedger, HolderReward, ProtocolStats; custodial tables User, AuthNonce, Session, Deposit, Withdrawal, LedgerAccount, LedgerTransaction, LedgerEntry, OffchainLaunch, OffchainBid, OffchainPosition, OffchainAntiSnipe). Memory store when `DATABASE_URL` is unset (demo only). Redis for 1–2 s response caches and the keeper queue. Browser: encrypted salts in IndexedDB, client-side demo world when the API is unreachable.
