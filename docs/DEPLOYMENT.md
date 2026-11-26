# Deployment

Live: website https://www.sealedsol.xyz (Vercel) · API https://api-production-01dc1743.up.railway.app (Railway; WS `wss://…/ws`).

## Local
```bash
corepack enable && pnpm install && pnpm dev   # API :4000 + web :3000, DEMO_MODE, no keys
```
`pnpm typecheck`, `pnpm build`, `pnpm --filter @sealed/e2e test:invariants`, `pnpm --filter @sealed/e2e test:e2e`, `scripts/verify.sh`, `pnpm anchor:build|anchor:test`.

## API env (Railway) — templates in `apps/api/.env.example`
| Variable | Notes |
|---|---|
| EXECUTION_MODE | `offchain` (custodial, default) or `onchain` (roadmap) — custodial backend, in development |
| COMPANY_WALLET | `DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j` |
| COMPANY_WALLET_SECRET_KEY | operator-set secret; signs payouts. Unset → manual withdrawals only |
| ADMIN_TOKEN | secret for `/api/admin/withdrawals` |
| DEPOSIT_CONFIRMATIONS | confirmations before crediting deposits |
| HELIUS_API_KEY | builds Helius RPC URL if `SOLANA_RPC_URL` unset; deposits; privacy proxy |
| DEMO_MODE | defaults true when `SOLANA_RPC_URL` is unset — `HELIUS_API_KEY` alone does **not** disable it |
| DATABASE_URL / REDIS_URL | `${{Postgres.DATABASE_URL}}` / `${{Redis.REDIS_URL}}`; Postgres required for custody |
| SOLANA_RPC_URL, SOLANA_WS_URL, NETWORK, PROGRAM_ID, IDL_PATH | chain config |
| RELAYER_SECRET_KEY, RELAYER_BOX_SEED, KEEPER_SECRET_KEY | onchain workers; without the box seed relayer keys are ephemeral |
| CORS_ORIGIN, PORT, HOST, JUPITER_API_URL, WORKERS_ENABLED, DEMO_TICK_MS, LOG_LEVEL, NODE_ENV | runtime |

## Web env (Vercel) — `apps/web/.env.example`
`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_NETWORK`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_PROGRAM_ID`, optional `NEXT_PUBLIC_JUPITER_API_URL`, `NEXT_PUBLIC_DEVNET_MINTS`. Inlined at build time.

## Railway
Add Postgres + Redis plugins; service builds `apps/api/Dockerfile` via `apps/api/railway.json` (context = repo root, health check `/api/health`, 120 s); set env; `scripts/deploy-api.sh` (`--yes`, `--dry-run`). Boot runs `prisma db push` when `DATABASE_URL` is set.

## Vercel
Root Directory `apps/web`; `vercel.json` installs from the monorepo root and builds shared → defi → web; `scripts/deploy-web.sh [--preview]`.

## Devnet program (onchain mode, not yet deployed)
`scripts/deploy-devnet.sh` refuses mainnet RPCs, runs `anchor build`/`keys sync`/`deploy`, copies the IDL, runs `init-devnet.ts` (protocol, credit pools, mock mints) and writes program ids into env files. Needs ~5 devnet SOL.

Never deploy publicly with `DEMO_MODE=true` (demo-bid and launch creation are unauthenticated).
