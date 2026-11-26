# Deployment

Live: website https://www.sealedsol.xyz (Vercel) · API https://api-production-01dc1743.up.railway.app (Railway; WS `wss://…/ws`).

Current status (2026-11-26): web live on Vercel (Next 15.0.8 / React 19.0.9, CVE-2025-66478 fix). API live on Railway with Postgres + Redis, `EXECUTION_MODE=offchain`, `DEMO_MODE=true` (demo launches merged with real offchain launches). Not yet set: `COMPANY_WALLET_SECRET_KEY` (payouts off) and `HELIUS_API_KEY` (no deposit detection). Program: builds and passes tests locally; not deployed to devnet.

## Local
```bash
corepack enable && pnpm install && pnpm dev   # API :4000 + web :3000, DEMO_MODE, no keys
```
`pnpm typecheck`, `pnpm build`, `pnpm --filter @sealed/e2e test:invariants`, `pnpm --filter @sealed/e2e test:e2e`, `scripts/verify.sh`, API suite `cd apps/api && node --import tsx --test test/*.test.ts` (87 tests), `pnpm anchor:build`, and `cd programs/sealed-launchpad && anchor test -- --features test-mode` (18 tests; the root `pnpm anchor:test` omits the required feature flag).

## API env (Railway) — templates in `apps/api/.env.example`
| Variable | Notes |
|---|---|
| EXECUTION_MODE | `offchain` (custodial, default) or `onchain` (roadmap) |
| COMPANY_WALLET | `DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j` |
| COMPANY_WALLET_SECRET_KEY | operator-set secret; signs payouts. Unset → `payoutsEnabled=false`, no withdrawal is ever sent (they stay `queued`/`pending_approval`, funds locked, until set or rejected) |
| ADMIN_TOKEN | value of header `x-admin-token` for `/api/admin/withdrawals` and `/api/admin/credit-pool/seed`; unset → 503 |
| DEPOSIT_CONFIRMATIONS | `finalized` (default) or integer 1–1000 slot depth before crediting |
| CUSTODY_WORKERS | run deposit watcher + payout worker; default `WORKERS_ENABLED && !isDemo`, so with `DEMO_MODE=true` set it to `true` |
| SIWS_DOMAIN, DEPOSIT_POLL_MS, PAYOUT_POLL_MS, OFFCHAIN_TICK_MS | sign-in domain (`sealed.app`), 15 s, 10 s, 2 s |
| HELIUS_API_KEY | builds Helius RPC URL if `SOLANA_RPC_URL` unset; deposits; privacy proxy |
| DEMO_MODE | `isDemo = DEMO_MODE ?? !SOLANA_RPC_URL` — `HELIUS_API_KEY` alone does **not** disable it |
| DATABASE_URL / REDIS_URL | `${{Postgres.DATABASE_URL}}` / `${{Redis.REDIS_URL}}`; Postgres required for custody |
| SOLANA_RPC_URL, SOLANA_WS_URL, NETWORK, PROGRAM_ID, IDL_PATH | chain config |
| RELAYER_SECRET_KEY, RELAYER_BOX_SEED, KEEPER_SECRET_KEY | onchain workers; without the box seed relayer keys are ephemeral |
| CORS_ORIGIN, PORT, HOST, JUPITER_API_URL, WORKERS_ENABLED, DEMO_TICK_MS, LOG_LEVEL, NODE_ENV | runtime |

## Web env (Vercel) — `apps/web/.env.example`
`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_NETWORK`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_PROGRAM_ID`, optional `NEXT_PUBLIC_JUPITER_API_URL`, `NEXT_PUBLIC_DEVNET_MINTS`. Inlined at build time.

## Railway
Add Postgres + Redis plugins; service builds `apps/api/Dockerfile` via `apps/api/railway.json` (context = repo root, health check `/api/health`, 120 s); set env; `scripts/deploy-api.sh` (`--yes`, `--dry-run`). Boot runs `prisma db push` when `DATABASE_URL` is set. For custody, then seed the credit pool: `POST /api/admin/credit-pool/seed {asset, amount, reference}` with `x-admin-token` (graduations get no buyback credit while it is empty).

## Vercel
Root Directory `apps/web`; `vercel.json` installs from the monorepo root and builds shared → defi → web; `scripts/deploy-web.sh [--preview]`.

## Devnet program (onchain mode, not yet deployed; builds and tests pass locally)
`scripts/deploy-devnet.sh` refuses mainnet RPCs, runs `anchor build`/`keys sync`/`deploy`, copies the IDL, runs `init-devnet.ts` (protocol, credit pools, mock mints) and writes program ids into env files. Needs ~5 devnet SOL.

Never run a public mainnet deployment with `DEMO_MODE=true` (demo-bid and unauthenticated demo launch creation are enabled). The hosted devnet API currently runs in demo.
