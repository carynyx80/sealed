# Sealed — Sealed-Block Launchpad with a Fee-Credit Buyback Vault (Solana)

**Live:** website https://www.sealedsol.xyz · API https://api-production-01dc1743.up.railway.app (`/api/health`, `/llms.txt`, `wss://…/ws`)

Fair token launches on Solana in four phases:

1. **Launch setup.** The creator picks name, ticker, quote asset (SOL, USDC or a tokenized stock such as NVDAx, TSLAx or TTWOx), auction length (15–30 min on mainnet, down to 2 min on devnet), target raise, clearing cap and supply (1B by default). The creator allocation is **capped at 2% (200 bps) on-chain**.
2. **Sealed-block auction (commit → reveal).** Bidders escrow collateral and submit `keccak256(bidder ‖ max_price u64le ‖ bid_amount u64le ‖ salt[32])`, an 80-byte preimage. The public sees the bid count, the time left and the escrowed-wallet count. Nobody sees individual prices or sizes. In the reveal window an optional **auto-reveal relayer** submits the reveals users sealed to it during commit. After that the auction clears at **one uniform price**: everyone at or above it pays the same price, the marginal tick is pro-rated, and everything else is refunded (`claim_or_refund`).
3. **Graduation + instant Fee-Credit Buyback Vault.** The raise and supply seed the pool (LP locked). The Protocol Credit Pool advances **10–15% of the raise** (by tier) into a **non-withdrawable buyback vault**. A keeper drips it into open-market buy-and-burns every 2–5 minutes, starting at minute one.
4. **Auto-repay → permanent flywheel.** Pool fees go first **80% to repaying the credit line and 20% to platform burn/ops**. Once the line is 100% repaid (the switch happens at exactly 0 outstanding, and any overflow in the crossover batch goes straight to the flywheel), fees split **50% to holders (in the quote asset), 35% to platform buyback-burn and 15% to treasury**. Wallets that buy in the graduation slot land in the **anti-snipe registry** and earn 0% holder rewards.

The canonical math is in `packages/shared`: `computeClearing` / `settleBid` (clearing.ts), `splitFees` (fees.ts) and `computeCommitment` (commitment.ts). The Rust program mirrors it integer-for-integer.

## Documentation

In-app docs: `/docs` on the web app (https://www.sealedsol.xyz/docs). Repo docs in [`docs/`](docs/):

| Doc | Covers |
|---|---|
| [OVERVIEW](docs/OVERVIEW.md) | what Sealed is, the four-phase loop, execution modes, status |
| [CUSTODY](docs/CUSTODY.md) | offchain custodial mode (default): SIWS, deposits, withdrawals, limits, proof of reserves, risks |
| [MECHANICS](docs/MECHANICS.md) | auction, clearing with worked example, buyback vault, fee splits, anti-snipe |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | monorepo, data flow, workers, storage |
| [PROGRAM](docs/PROGRAM.md) | Anchor program (roadmap onchain mode): instructions, accounts, seeds, events, errors |
| [API](docs/API.md) | REST, custody routes, WebSocket, `/llms.txt` |
| [STACK](docs/STACK.md) | what powers Sealed, with status |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | local, env vars, Railway, Vercel, devnet |
| [SECURITY](docs/SECURITY.md) | custody disclosure, trust model, invariants, limitations, roadmap |
| [PRIVACY](docs/PRIVACY.md) | Helius Privacy Rings integration |

## Architecture

```
packages/shared            @sealed/shared: types, Zod schemas, PDAs, clearing/fee/commitment math, demo world, REST + WS contract
packages/defi              @sealed/defi: wallet, Jupiter v6, Raydium graduation adapter, quote-asset registry, salt sealing
programs/sealed-launchpad  Anchor program (commit_bid, reveal_bid, clear_auction, claim_or_refund, graduate_and_open_credit,
                           execute_buyback_drip, repay_credit, distribute_rewards) + anchor tests + devnet init script
apps/api                   @sealed/api: Fastify REST + /ws, Prisma/Postgres (optional), Redis (optional), indexer,
                           auto-reveal relayer, buyback keeper, /llms.txt. Railway: Dockerfile + railway.json
apps/web                   @sealed/web: Next.js 15 App Router, Tailwind + Framer Motion, cream-and-white editorial UI. Vercel: vercel.json
tests                      @sealed/e2e: invariant/property tests + black-box API e2e + web smoke
scripts                    deploy-devnet.sh · deploy-api.sh · deploy-web.sh · verify.sh
```

REST is mounted under `/api`: `/health`, `/stats`, `/launches` (`?status=auctions|vaults|graduated|<status>&quote=SOL|USDC|stocks|<symbol>`), `/launches/:idOrMint`, `/auctions/:id`, `/vaults/:mint`, `/revenue`, `/rewards/:mint/:wallet` and `/relayer/*`. The server also serves `GET /llms.txt` (a guide for AI trading agents) and `WS /ws`, where clients send `{op:"subscribe",channels:["global","launch:<id>"]}`. Full contract: `packages/shared/src/api.ts` and `ws.ts`.

## Quickstart (demo mode, no keys and no infrastructure)

```bash
corepack enable            # or install pnpm 12 yourself
pnpm install
pnpm dev                   # builds @sealed/shared, then runs API :4000 + web :3000
open http://localhost:3000
```

With no env set, the API runs in **DEMO_MODE** with an in-memory store. It seeds a deterministic demo world on boot: live sealed auctions, buyback countdowns that tick, repayment bars and a trade tape. The UI labels this mode **Devnet / Demo**. `pnpm seed` only does something when `DATABASE_URL` is set (see below).

Useful commands:

| | |
|---|---|
| `pnpm typecheck` / `pnpm build` | all workspaces |
| `pnpm --filter @sealed/e2e test:invariants` | property tests on clearing, fees, commitment, schema and the demo world |
| `pnpm --filter @sealed/e2e test:e2e` | boots the built API (and the built web, if present) and checks them black-box |
| `scripts/verify.sh` | the full definition of done, with a PASS/FAIL table |
| `pnpm anchor:build` / `pnpm anchor:test` | Solana program |

## Environment

All variables are optional for local demo use. Templates:

- `apps/api/.env.example`: `PORT`, `DEMO_MODE`, `DATABASE_URL`, `REDIS_URL`, `SOLANA_RPC_URL`, `HELIUS_API_KEY`, `NETWORK`, `PROGRAM_ID`, `RELAYER_SECRET_KEY` (base58 fee payer), `RELAYER_BOX_SEED` (32-byte hex x25519 seed), `KEEPER_SECRET_KEY`, `CORS_ORIGIN`, …
- `apps/web/.env.example`: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_NETWORK`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_PROGRAM_ID`
- `.env.example` (root): inputs for the deploy scripts (Solana wallet, Railway/Vercel tokens)

Setting `SOLANA_RPC_URL` (or `HELIUS_API_KEY`) turns demo mode off by default. Force it either way with `DEMO_MODE=true|false`.

### Postgres seed

```bash
cd apps/api
DATABASE_URL=postgresql://… pnpm exec prisma db push
DATABASE_URL=postgresql://… pnpm seed           # upserts the demo world; add -- --reset to replace previous demo rows
```

## Deploy

All three scripts ask before doing anything (skip the prompt with `--yes`) and support `--dry-run`.

### 1. Program → Solana devnet

```bash
solana-keygen new -o ~/.config/solana/id.json   # if needed, then fund it with ~5 devnet SOL
scripts/deploy-devnet.sh
```

The script runs `anchor build` and `anchor deploy` to devnet using `programs/sealed-launchpad/target/deploy/sealed_launchpad-keypair.json`. It copies the IDL to `programs/sealed-launchpad/idl/` and runs `programs/sealed-launchpad/scripts/init-devnet.ts`, which creates the protocol config, the credit pools and the mock quote mints. Finally it writes `PROGRAM_ID` / `NEXT_PUBLIC_PROGRAM_ID` into `.env`, `apps/api/.env` and `apps/web/.env.local`. It refuses mainnet RPCs.

### 2. API → Railway

1. Create a Railway project and add the **Postgres** and **Redis** plugins.
2. Add a service from this repo. Railway builds with `apps/api/railway.json`, which points at the `apps/api/Dockerfile` builder (build context is the repo root) and health-checks `/api/health`.
3. Set the variables from `apps/api/.env.example`: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `REDIS_URL=${{Redis.REDIS_URL}}`, `SOLANA_RPC_URL`, `PROGRAM_ID`, `RELAYER_*`, `KEEPER_SECRET_KEY`, and `CORS_ORIGIN=https://<your-vercel-domain>`.
4. Run `scripts/deploy-api.sh`, which wraps `railway up`. On boot the container runs `prisma db push` when `DATABASE_URL` is set.

Local image: `docker build -f apps/api/Dockerfile -t sealed-api . && docker run -p 4000:4000 sealed-api`

### 3. Web → Vercel

1. Import the repo and set **Root Directory = `apps/web`**. `apps/web/vercel.json` installs from the monorepo root, then builds `@sealed/shared`, then `@sealed/defi`, then `@sealed/web`.
2. Set `NEXT_PUBLIC_API_URL=https://<railway-domain>`, `NEXT_PUBLIC_WS_URL=wss://<railway-domain>/ws`, `NEXT_PUBLIC_NETWORK=devnet`, `NEXT_PUBLIC_RPC_URL` and `NEXT_PUBLIC_PROGRAM_ID`.
3. Run `scripts/deploy-web.sh` (production) or `scripts/deploy-web.sh --preview`.

## Testing

- **Invariant tests** (`tests/invariants`) use seeded random generation with only `node:test` and `tsx`. Reproduce a failure with `INVARIANT_SEED=<seed>`, and soak with `INVARIANT_RUNS=5000`. They check:
  - **Clearing:** every winner pays the one uniform price (never more than their own max); Σspent ≤ clearing cap; Σtokens ≤ tokens for sale; refund + spent = deposit; no bid below P wins; adding a bid never lowers P; results don't depend on bid order.
  - **Fees:** the split sums exactly to the input; repayment never exceeds what's outstanding; the switch to flywheel happens exactly at 0, and the crossover overflow goes to the flywheel; drips drain the vault to exactly 0.
  - **Commitment:** the 80-byte layout; distinct salts give distinct commitments; changing any single field changes the commitment.
  - **Schema:** a creator allocation above 200 bps is rejected.
  - **Demo world:** only legal status transitions; vault balance ≥ 0; repaidPct within 0–100; every buyback lowers the vault balance by exactly the amount it spent.
- **E2E** (`tests/e2e`):
  - `api.e2e.test.ts` starts `apps/api/dist/server.js` on :4200 with no env. It checks health, stats, the launch tab and quote filters, that auctions expose no per-bid fields, vaults, revenue and `/llms.txt`, that `POST /api/launches` returns 200 for valid input and 400 for 250 bps, that a demo bid increments `bidCount`, and that a WS `global` subscription receives events.
  - `web.smoke.test.ts` runs `next start -p 3200` against that API and checks that `/`, `/launch`, `/revenue` and `/token/<mint>` render with the expected copy.
  - Both suites **skip with a message** if their build output is missing.
- **Program:** `anchor test` covers commit-reveal, uniform clearing, refunds, rejection of creator allocations above 2%, the vault withdrawal guard, the switch from repayment to flywheel, and same-slot sniper exclusion.

## Security notes

- **Sealed bids hide price and size, but not deposit size.** The commitment hides `max_price` and `bid_amount`. The collateral transfer into escrow is a public SPL transfer, though, so an observer learns an upper bound on each bidder's size. **Pad your deposit.** Escrow more than you intend to bid (unused collateral is refunded in full by `claim_or_refund`), or split bids across round-number deposits. The UI should nudge users toward padded, round deposits.
- **Salts are the secret.** Anyone who has the preimage can reveal, which is how the relayer works. Anyone who has your salt plus your price and amount can brute-force-confirm your bid. Salts are 32 random bytes and stay client-side (IndexedDB) unless you opt into auto-reveal. If you lose the salt and miss the reveal window, the commitment cannot be revealed and `NO_REVEAL_SLASH_BPS` (1%) of the deposit is forfeited.
- **Relayer trust model.** Auto-reveal payloads are sealed to the relayer's x25519 key (`nacl.box`), and the bidder signs them over `sealed-reveal:v1:<launch>:<commitment>`. The API stores only ciphertext and decrypts it once the reveal window opens. The relayer **can** learn your bid early, because it holds the key. It **can** withhold your reveal, and you then fall back to revealing manually. It **cannot** change your bid, because the on-chain keccak check binds it, and it **cannot** move your funds, because it only pays fees. Treat it as a liveness service, not a custodian. Opting out keeps your bid fully private until you reveal it yourself.
- **The buyback vault cannot be withdrawn.** The vault is a PDA-owned token account. The program exposes only swap-to-burn (`execute_buyback_drip`) and paired-asset holder drips. There is no instruction that transfers vault funds to a creator, admin or arbitrary wallet. Drips are permissionless cranks with bounded size and interval, so a malicious keeper can at most run them early within the schedule or skip them.
- **Config validation.** `clearingCap` must be ≥ `floorPrice × tokensForSale`. If it isn't, the clamp to the floor price lets the raise exceed the cap (see the invariant test `KNOWN EDGE`). The program and API should reject such launches.
- **Anti-snipe** is keyed on the graduation slot. Wallets that buy in that slot are recorded on-chain and get 0% holder rewards. This does not stop the buy itself.
- **Demo mode is not secure mode.** `POST /api/auctions/:id/demo-bid` and in-memory launch creation exist only when `DEMO_MODE=true`. Never run a public mainnet deployment in demo mode.
