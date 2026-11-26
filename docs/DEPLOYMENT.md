# Deployment

Live: website https://www.sealedsol.xyz (Vercel) · API https://api-production-01dc1743.up.railway.app (Railway; WS `wss://…/ws`).

Current status (2026-11-26): web live on Vercel (Next 15.0.8 / React 19.0.9, CVE-2025-66478 fix). API live on Railway with Postgres + Redis, `EXECUTION_MODE=offchain`. **Switch from devnet to Solana mainnet with real funds is rolling out:** `NETWORK=mainnet`, `DEMO_MODE=false`, custody workers on, operator secrets (`COMPANY_WALLET_SECRET_KEY`, `HELIUS_API_KEY`, `ADMIN_TOKEN`) set. Company wallet: [`DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j`](https://explorer.solana.com/address/DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j). Program: builds and passes tests locally; roadmap, not deployed.

> **Real funds.** On mainnet the company holds every deposit in the company wallet; withdrawals may need manual approval; only SOL and USDC withdraw (launched tokens are ledger-only); proof of reserves is a snapshot; nothing is audited; users are responsible for complying with the laws of their jurisdiction. Full disclosure: [CUSTODY.md](CUSTODY.md).

## Mainnet readiness checklist

Tick each item only after seeing the result on the hosted API or in the dashboard.

**API (Railway variables)**
- [ ] `NETWORK=mainnet` → `GET /api/health` shows `"network":"mainnet"`.
- [ ] `DEMO_MODE=false` → `/api/health` shows `"isDemo":false`; no launch has `isDemo: true`; `POST /api/auctions/:id/demo-bid` answers 403.
- [ ] `ADMIN_TOKEN` (long random secret) → `/api/admin/withdrawals` refuses requests without `x-admin-token`.
- [ ] `COMPANY_WALLET_SECRET_KEY` (Railway secret only; its public key must equal `COMPANY_WALLET`) → `/api/custody/info` shows `payoutsEnabled: true`.
- [ ] `HELIUS_API_KEY` (mainnet) → a small test deposit is detected and credited; `/api/health` shows a redacted mainnet RPC.
- [ ] `CUSTODY_WORKERS=true` → deposit watcher and payout worker start.
- [ ] `SIWS_DOMAIN=www.sealedsol.xyz` → the `POST /api/auth/nonce` message names www.sealedsol.xyz.
- [ ] `DATABASE_URL=${{Postgres.DATABASE_URL}}` with **automated backups enabled and one restore tested** — the ledger is the only record of who owns what.
- [ ] `CORS_ORIGIN=https://www.sealedsol.xyz` (no wildcard).

**Funds**
- [ ] Fund the company wallet with SOL for payout fees and keep a buffer (payouts pause with a reason when it runs low).
- [ ] Seed the credit pool: send company SOL/USDC to the company wallet, then `POST /api/admin/credit-pool/seed {asset, amount, reference}` with `x-admin-token` (reference = funding tx signature).
- [ ] `GET /api/custody/info` shows a ratio ≥ 1 for SOL and USDC and matches the [Explorer](https://explorer.solana.com/address/DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j).

**Web (Vercel)**
- [ ] `NEXT_PUBLIC_NETWORK=mainnet`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL` set; redeploy (values are inlined at build time).
- [ ] No Devnet / Demo label, no demo launches, no in-browser demo fallback when the API is unreachable.
- [ ] No RPC provider key in any `NEXT_PUBLIC_*` variable; the browser uses `POST /api/rpc`.

**Behaviour to verify (rolling out)**
- [ ] Only SOL and USDC offered as quote/deposit assets; tokenized stocks show "coming soon".
- [ ] A launch with a commit window outside 15–30 min is rejected.
- [ ] A withdrawal with no fresh Jupiter price lands in `pending_approval`.
- [ ] Launched-token withdrawals are refused; a SOL and a USDC withdrawal reach `sent` with a mainnet signature.
- [ ] The risk disclosure is visible on the custody, security and deposit screens.

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
| COMPANY_WALLET_SECRET_KEY | operator-set secret; signs mainnet payouts. Unset → `payoutsEnabled=false`, no withdrawal is ever sent (they stay `queued`/`pending_approval`, funds locked, until set or rejected) |
| ADMIN_TOKEN | required on mainnet; value of header `x-admin-token` for `/api/admin/withdrawals` and `/api/admin/credit-pool/seed`; unset → 503 |
| DEPOSIT_CONFIRMATIONS | `finalized` (default) or integer 1–1000 slot depth before crediting |
| CUSTODY_WORKERS | run deposit watcher + payout worker; default `WORKERS_ENABLED && !isDemo`; set `true` on mainnet |
| SIWS_DOMAIN | sign-in domain; `www.sealedsol.xyz` in production (code default `sealed.app`) |
| DEPOSIT_POLL_MS, PAYOUT_POLL_MS, OFFCHAIN_TICK_MS | 15 s, 10 s, 2 s |
| HELIUS_API_KEY | builds the mainnet Helius RPC URL if `SOLANA_RPC_URL` unset; deposits, payouts, browser RPC proxy `POST /api/rpc`, privacy proxy; never sent to the browser |
| DEMO_MODE | `false` on mainnet (demo disabled there). `isDemo = DEMO_MODE ?? !SOLANA_RPC_URL` — `HELIUS_API_KEY` alone does **not** disable it |
| DATABASE_URL / REDIS_URL | `${{Postgres.DATABASE_URL}}` / `${{Redis.REDIS_URL}}`; Postgres required for custody — enable backups |
| NETWORK | `mainnet` in production (`mainnet \| devnet \| localnet`) |
| SOLANA_RPC_URL, SOLANA_WS_URL, PROGRAM_ID, IDL_PATH | chain config (program id unused in offchain mode) |
| RELAYER_SECRET_KEY, RELAYER_BOX_SEED, KEEPER_SECRET_KEY | onchain workers; without the box seed relayer keys are ephemeral |
| CORS_ORIGIN, PORT, HOST, JUPITER_API_URL, WORKERS_ENABLED, DEMO_TICK_MS, LOG_LEVEL, NODE_ENV | runtime |

## Web env (Vercel) — `apps/web/.env.example`
`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_NETWORK` (`mainnet` in production), `NEXT_PUBLIC_RPC_URL` (optional; the browser uses the API's `POST /api/rpc` proxy, so no provider key here), `NEXT_PUBLIC_PROGRAM_ID`, optional `NEXT_PUBLIC_JUPITER_API_URL`, `NEXT_PUBLIC_DEVNET_MINTS`. Inlined at build time.

## Railway
Add Postgres + Redis plugins; service builds `apps/api/Dockerfile` via `apps/api/railway.json` (context = repo root, health check `/api/health`, 120 s); set env (mainnet values in the checklist above); `scripts/deploy-api.sh` (`--yes`, `--dry-run`). Boot runs `prisma db push` when `DATABASE_URL` is set. For custody, then seed the credit pool: `POST /api/admin/credit-pool/seed {asset, amount, reference}` with `x-admin-token` (graduations get no buyback credit while it is empty).

## Vercel
Root Directory `apps/web`; `vercel.json` installs from the monorepo root and builds shared → defi → web; `scripts/deploy-web.sh [--preview]`.

## Devnet program (onchain mode, roadmap — not deployed; builds and tests pass locally)
`scripts/deploy-devnet.sh` refuses mainnet RPCs, runs `anchor build`/`keys sync`/`deploy`, copies the IDL, runs `init-devnet.ts` (protocol, credit pools, mock mints) and writes program ids into env files. Needs ~5 devnet SOL.

Never run a public mainnet deployment with `DEMO_MODE=true` (demo-bid and unauthenticated demo launch creation are enabled). Mainnet disables demo mode; finish the checklist above first.
