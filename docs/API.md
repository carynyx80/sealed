# API

Fastify, REST under `/api`, WebSocket at `/ws`, agent guide at `/llms.txt`. Contract: `packages/shared/src/api.ts`, `ws.ts`, `custody.ts`. Live: https://api-production-01dc1743.up.railway.app

Conventions: amounts in UI units (numbers); prices quote per whole token (6-decimal tokens); unix seconds; errors `{ "error": string, "details"?: unknown }`.

## Public endpoints (implemented, tests passing)
| Method | Path | Returns |
|---|---|---|
| GET | /api/health (also /health) | network, isDemo, db, cache, redacted rpc, programId, uptimeSec, version |
| GET | /api/stats | ProtocolStats |
| GET | /api/launches?status=&quote=&limit= | `{launches, total}`; status = LaunchStatus or auctions/vaults/graduated; quote = symbol/stocks/all; limit 1–200 |
| GET | /api/launches/:idOrMint | LaunchSummary |
| GET | /api/launches/:idOrMint/trades?limit= | `{trades}` |
| GET | /api/launches/:idOrMint/chart?interval=1m\|5m\|1h | `{points}` |
| POST | /api/launches | demo: creates launch (200); non-demo: **501 "sign client-side"** with create_launch args (omits drip_interval_sec/drip_count) |
| GET | /api/auctions/:idOrMint | `{launch, serverTimeTs}` — aggregates only |
| POST | /api/auctions/:idOrMint/demo-bid | demo only `{commitment, deposit, wallet?}` |
| GET | /api/vaults/:mint | `{launch, recentBuybacks, serverTimeTs}` |
| GET | /api/rewards/:mint/:wallet | HolderReward |
| GET | /api/revenue | `{stats, recentBuybacks, ledger, daily}` |
| GET | /api/relayer/pubkey | `{pubkey (x25519 b64), relayerAddress}` |
| POST | /api/relayer/reveals | SealedRevealEnvelope → `{accepted, id}` (400/401/404/409) |
| GET | /api/privacy/status | PrivacyStatusResponse |
| POST | /api/privacy/rpc | `{method, params}` → Helius SPR JSON-RPC (8 methods, 120/min/IP) |
| GET | /llms.txt | text/plain agent guide |

## Custody endpoints (`CUSTODY_ROUTES`, in development)
Bearer token required except info/nonce/verify.
| Method | Path | Body → response |
|---|---|---|
| GET | /api/custody/info | companyWallet, network, mode, payoutsEnabled, proofOfReserves[] |
| POST | /api/auth/nonce | `{wallet}` → `{nonce, message, expiresTs}` |
| POST | /api/auth/verify | `{wallet, nonce, signature}` → `{token, wallet, expiresTs}` |
| GET | /api/account | balances (available/locked), depositRef, companyWallet, sniperFlags |
| GET | /api/account/deposit/:asset | DepositInstructions |
| GET/POST | /api/account/deposits | list / `{signature}` nudge |
| GET/POST | /api/account/withdrawals | list / `{asset, amount, destination}` |
| POST | /api/trade/commit | `{launchId, commitment, deposit, sealedReveal?}` → `{bidId, bidCount}` |
| POST | /api/trade/reveal | `{launchId, maxPrice, bidAmount, salt}` |
| POST | /api/trade/swap | `{launchId, side, amountIn, minAmountOut}` → `{tradeId, amountIn, amountOut, fee, price, isSniper}` |
| POST | /api/trade/claim/:launchId | → `{tokens, refund}` |
| POST | /api/trade/stake | `{launchId, amount}` (negative = unstake) |
| POST | /api/trade/rewards/:launchId | → `{amount}` |
| GET/POST | /api/admin/withdrawals | approve/reject; `ADMIN_TOKEN` header |

## Example
```json
GET /api/health
{"ok":true,"network":"devnet","isDemo":true,"db":"memory","cache":"memory","rpc":"https://devnet.helius-rpc.com/?api-key=***","programId":"71geDPZMKfjJnKE4an15QyyH5TyFG1w7XEL5tUkp5Tpy","uptimeSec":221,"version":"0.1.0"}
```

## WebSocket `/ws`
Client: `{"op":"subscribe","channels":["global","launch:<id>"]}`, `unsubscribe`, `{"op":"ping"}` → `{"type":"pong","ts":…}`. Server envelope: `{type, data, channel, ts}`; a snapshot is sent on subscribe.
Events: launch.created, launch.updated, auction.bid_committed, auction.bid_revealed, auction.phase_changed, auction.cleared, trade, vault.drip, credit.ledger, credit.flywheel_activated, stats.updated (~3 s on global).

## /llms.txt
Rendered from live config: mode, network, program id, URLs, mechanics (numbers from shared constants), endpoints with JSON, WS protocol, an agent participation recipe, and Privacy Ring status.
