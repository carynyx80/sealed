# Custody (offchain custodial mode — default)

Status: **built, tests passing (API 87/87), live on Railway — payouts pending operator key.** Contract: `packages/shared/src/custody.ts`. Server: `apps/api/src/offchain/**`, routes `apps/api/src/routes/{auth,account,trade,custody,admin}.ts`.

Hosted API today: `COMPANY_WALLET_SECRET_KEY` is not set (`payoutsEnabled=false`, nothing is sent) and `HELIUS_API_KEY` is not set (no deposit detection; `POST /api/account/deposits` → 503). It also runs `DEMO_MODE=true`, which keeps the deposit watcher and payout worker off unless `CUSTODY_WORKERS=true`. Do not send real funds until `/api/custody/info` reports `payoutsEnabled: true`.

> **Disclosure.** Deposits leave your wallet and sit in the company wallet `DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j`. Your balance is a ledger entry. The operator can pause, delay or refuse withdrawals and sees your bids once submitted; a compromised operator key could lose funds. No insurance, no audit. The non-custodial alternative (the Anchor program) is roadmap only.

## Model
A Postgres double-entry ledger records every movement (auctions, clearing, pool, drips, fee splits, rewards). Real assets live only in the company wallet. Proof of reserves compares that wallet's on-chain balances to ledger liabilities.

## Sign in (SIWS)
1. `POST /api/auth/nonce {wallet}` → `{nonce, message, expiresTs}`
2. Wallet signs `message` (statement: "Sign in to Sealed. This request will not trigger a transaction or cost any fees.")
3. `POST /api/auth/verify {wallet, nonce, signature(base58)}` → `{token, wallet, expiresTs}`; send `Authorization: Bearer <token>`.

Nonces last 5 min and are single-use; sessions last 7 days (only a SHA-256 of the token is stored). `GET /api/auth/session` → `{wallet}`; `POST /api/auth/logout` revokes the token. Nonce/verify are rate-limited (429).

## Deposits
Send SOL/SPL to the company wallet with memo `sealed:<depositRef>` (from `GET /api/account` or `GET /api/account/deposit/:asset`). Detected via Helius RPC, credited after `DEPOSIT_CONFIRMATIONS` (finality). Statuses: `detected → confirmed → credited` or `rejected`. `POST /api/account/deposits {signature}` nudges detection: 200 with the record, **202** if the tx is not finalized yet (or not found — it will be picked up automatically), **404** if the tx holds no deposit for your memo, 400 for a failed tx, 503 without an RPC. Transfers without the memo cannot be matched automatically.

## Trading
Commit (`/api/trade/commit`, same keccak preimage, bidder = signed-in wallet; deposit locked from available balance), reveal, swap, claim, stake, claim rewards — all API calls. Balances show `available` and `locked`. Anti-snipe: buys within `ANTI_SNIPE_WINDOW_SEC = 2` of graduation are flagged.

## Withdrawals
`POST /api/account/withdrawals {asset, amount, destination}`. Auto-approved up to **$2,500** USD-equivalent and within **$25,000/day per wallet** (`WITHDRAWAL_LIMITS`); otherwise it is `pending_approval` until an operator approves (→ `queued`) or rejects (funds unlocked) at `/api/admin/withdrawals` with header `x-admin-token: <ADMIN_TOKEN>`. `queued` withdrawals are sent only by the payout worker, which needs `COMPANY_WALLET_SECRET_KEY` and an RPC; while it is unset (`payoutsEnabled=false`) they wait with funds locked. Statuses: `queued, pending_approval, sending, sent, failed, rejected`. USD limits use the registry's demo reference prices.

## Proof of reserves
`GET /api/custody/info` (public) → `{companyWallet, network, mode, payoutsEnabled, proofOfReserves:[{asset, onchain, liabilities, ratio, asOfTs}]}`. It does not prove the ledger is complete, that assets stay put, or that the key is safe.

## Risks
Operator key compromise · operator insolvency/misconduct · ledger bugs · deposit mismatches · withdrawal delays · rule drift vs the program (2 s window instead of a slot). Credit pool: offchain credit lines are capped by the `credit_pool:<asset>` ledger balance, which the operator seeds from company funds with `POST /api/admin/credit-pool/seed {asset, amount, reference}` (idempotent on `reference`). Unseeded → graduations get no buyback vault.

Planned hardening: multisig/MPC, hot/cold split, independent attestations.
