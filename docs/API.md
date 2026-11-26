# API

Fastify, REST under `/api`, WebSocket at `/ws`, agent guide at `/llms.txt`. Contract: `packages/shared/src/api.ts`, `ws.ts`, `custody.ts`. Live: https://api-production-01dc1743.up.railway.app — **Solana mainnet, custodial, real funds (rolling out)**. Check `network` and `isDemo` in `/api/health` first. Read the disclosure in [CUSTODY.md](CUSTODY.md): the company holds deposits, withdrawals may need manual approval, only SOL and USDC withdraw, nothing is audited.

Conventions: amounts in UI units (numbers); prices quote per whole token (6-decimal tokens); unix seconds; errors `{ "error": string, "details"?: unknown }`.

## Public endpoints (implemented, tests passing — API suite 87/87)
| Method | Path | Returns |
|---|---|---|
| GET | /api/health (also /health) | network, isDemo, db, cache, redacted rpc, programId, uptimeSec, version |
| GET | /api/stats | ProtocolStats |
| GET | /api/launches?status=&quote=&limit= | `{launches, total}`; status = LaunchStatus or auctions/vaults/graduated; quote = symbol/stocks/all; limit 1–200 |
| GET | /api/launches/:idOrMint | LaunchSummary |
| GET | /api/launches/:idOrMint/trades?limit= | `{trades}` |
| GET | /api/launches/:idOrMint/chart?interval=1m\|5m\|1h | `{points}` |
| POST | /api/launches | offchain + bearer: real launch (mainnet: 15–30 min commit window, quote SOL or USDC); demo without token: in-memory launch (200); onchain mode, non-demo: **501 "sign client-side"** with create_launch args (omits drip_interval_sec/drip_count) |
| GET | /api/auctions/:idOrMint | `{launch, serverTimeTs}` — aggregates only |
| POST | /api/auctions/:idOrMint/demo-bid | demo only `{commitment, deposit, wallet?}`; disabled on mainnet |
| GET | /api/vaults/:mint | `{launch, recentBuybacks, serverTimeTs}` |
| GET | /api/rewards/:mint/:wallet | HolderReward |
| GET | /api/revenue | `{stats, recentBuybacks, ledger, daily}` |
| GET | /api/relayer/pubkey | `{pubkey (x25519 b64), relayerAddress}` |
| POST | /api/relayer/reveals | SealedRevealEnvelope → `{accepted, id}` (400/401/404/409) |
| GET | /api/privacy/status | PrivacyStatusResponse |
| POST | /api/privacy/rpc | `{method, params}` → Helius SPR JSON-RPC (8 methods, 120/min/IP) |
| POST | /api/rpc | browser RPC proxy (rolling out): JSON-RPC 2.0 `{jsonrpc, id, method, params}` for allowlisted methods only; rate limited (429); provider key never exposed |
| GET | /llms.txt | text/plain agent guide |

## Custody and trade endpoints (`CUSTODY_ROUTES`; built, tests passing, live on Railway)
Implemented in `apps/api/src/routes/{auth,account,trade,custody,admin}.ts`. Bearer token (`Authorization: Bearer <token>`) required except info/nonce/verify; the acting wallet is always the session wallet. Admin routes use header **`x-admin-token: <ADMIN_TOKEN>`** (503 if `ADMIN_TOKEN` unset). Trade routes answer 503 if the offchain ledger is unavailable or `EXECUTION_MODE=onchain`. Payouts need `COMPANY_WALLET_SECRET_KEY` and SOL in the company wallet for fees (otherwise they pause with a reason); deposit detection needs `HELIUS_API_KEY`/`SOLANA_RPC_URL`. On mainnet these are being set (rolling out) — check `payoutsEnabled`.

| Method | Path | Body → response |
|---|---|---|
| GET | /api/custody/info | `{companyWallet, network, mode, payoutsEnabled, proofOfReserves[{asset, onchain, liabilities, ratio, asOfTs}]}` (cached ~30 s) |
| POST | /api/auth/nonce | `{wallet}` → `{nonce, message, expiresTs}` (5 min, single use; 429 rate limit) |
| POST | /api/auth/verify | `{wallet, nonce, signature(base58)}` → `{token, wallet, expiresTs}` (7-day session; 401 on bad/expired/replayed nonce) |
| GET | /api/auth/session | → `{wallet}` (401 if the token is missing, expired or revoked) |
| POST | /api/auth/logout | revokes the presented token → `{ok: true}` |
| GET | /api/account | `{wallet, balances[{asset, symbol, available, locked, launchId?}], depositRef, companyWallet, network, sniperFlags}` |
| GET | /api/account/deposit/:asset | `{companyWallet, memo, asset, mint, minConfirmations, note}`; on mainnet SOL or USDC (stocks coming soon); 400 unknown asset / no mint on this network |
| GET | /api/account/deposits | `{deposits: DepositRecord[]}` (latest 100) |
| POST | /api/account/deposits | `{signature}` nudge → **200** DepositRecord · **202** `{status:"detected", amount:0, reason:"not yet finalized (or not found)…"}` (picked up automatically later) · **404** no deposit for your memo in that tx · 400 failed tx / non-base58 · 429 · 503 no RPC |
| GET | /api/account/withdrawals | `{withdrawals: WithdrawalRecord[]}` (latest 100) |
| POST | /api/account/withdrawals | `{asset, amount, destination}` → **201** WithdrawalRecord (`queued` ≤ $2,500 and within $25,000/day at a fresh live Jupiter price, else `pending_approval`); SOL/USDC only — launched tokens cannot be withdrawn yet |
| POST | /api/trade/commit | `{launchId, commitment, deposit, sealedReveal?}` → `{bidId, bidCount}` (409 window closed / second bid) |
| POST | /api/trade/reveal | `{launchId, maxPrice, bidAmount, salt}` (atoms as decimal strings, salt 64 hex) → `{revealed: true}` |
| POST | /api/trade/swap | `{launchId, side, amountIn, minAmountOut}` → `{tradeId, amountIn, amountOut, fee, price, isSniper}`; optional `Idempotency-Key` header |
| POST | /api/trade/claim/:launchId | → `{tokens, refund}` (409 until cleared) |
| POST | /api/trade/stake | `{launchId, amount}` (negative = unstake) → `{staked, eligible}`; optional `Idempotency-Key` |
| POST | /api/trade/rewards/:launchId | → `{amount}` |
| GET | /api/admin/withdrawals?status= | `{withdrawals, payoutsEnabled}`; default statuses pending_approval, queued, sending |
| POST | /api/admin/withdrawals | `{id, action: "approve"\|"reject", reason?}` → WithdrawalRecord (approve: pending_approval → queued; reject unlocks funds) |
| POST | /api/admin/credit-pool/seed | `{asset, amount, reference}` → `{ok, asset, amount, txId, replayed}`; idempotent on `reference` (409 on conflicting replay) |

`POST /api/launches` in offchain mode: with a bearer token (required outside demo) it creates a real launch for the session wallet; without a token in demo it creates an in-memory demo launch; the 501 "sign client-side" response only applies to `EXECUTION_MODE=onchain` outside demo.

## Example
```json
GET /api/health
{"ok":true,"network":"mainnet","isDemo":false,"db":"postgres","cache":"redis","rpc":"https://mainnet.helius-rpc.com/?api-key=***","programId":"71geDPZMKfjJnKE4an15QyyH5TyFG1w7XEL5tUkp5Tpy","uptimeSec":221,"version":"0.1.0"}
```

## WebSocket `/ws`
Client: `{"op":"subscribe","channels":["global","launch:<id>"]}`, `unsubscribe`, `{"op":"ping"}` → `{"type":"pong","ts":…}`. Server envelope: `{type, data, channel, ts}`; a snapshot is sent on subscribe.
Events: launch.created, launch.updated, auction.bid_committed, auction.bid_revealed, auction.phase_changed, auction.cleared, trade, vault.drip, credit.ledger, credit.flywheel_activated, stats.updated (~3 s on global).

## /llms.txt
Rendered from live config: mode, execution mode, network, mainnet base facts (SOL/USDC only, demo off, commit window, withdrawal rules, `/api/rpc`), the real-funds risk and jurisdiction disclosure, program id, URLs, the custodial trust disclosure, mechanics (numbers from shared constants), public endpoints and the custody/trade routes with JSON, WS protocol, agent participation recipes (offchain custodial and onchain), and Privacy Ring status.
