# Custody (offchain custodial mode on Solana mainnet)

Status: **built, tests passing, live on Railway; switch to mainnet with real funds rolling out.** Contract: `packages/shared/src/custody.ts`. Server: `apps/api/src/offchain/**`, routes `apps/api/src/routes/{auth,account,trade,custody,admin}.ts`.

> **Real funds · custodial risk disclosure.** Sealed is custodial and runs on Solana **mainnet with real funds**.
> - **The company holds your funds.** Deposits sit in the company wallet [`DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j`](https://explorer.solana.com/address/DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j); your balance is a Sealed ledger entry, not a token account you control. The operator can pause, delay or refuse withdrawals, and a compromised company wallet key could lose every deposit. No insurance, no deposit guarantee, no multisig yet.
> - **Withdrawals may need manual approval:** above $2,500 USD-equivalent, above $25,000 per wallet per day (`WITHDRAWAL_LIMITS`), or when no fresh live price is available. Payouts pause, with a reason, when the company wallet lacks SOL for fees.
> - **Only SOL and USDC withdraw.** Launched tokens are custodial ledger balances and cannot be withdrawn on-chain yet.
> - **Proof of reserves** (`GET /api/custody/info`) compares the company wallet's on-chain balances, checkable on the [Explorer](https://explorer.solana.com/address/DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j), with ledger liabilities. It is a snapshot; it does not prove the ledger is complete or that the key is safe.
> - **Not audited.** Neither the custodial backend nor the Anchor program has had a third-party audit; the program is not deployed.
> - **Jurisdiction.** Sealed is not a bank, broker or licensed custodian, and nothing here is investment advice. You are responsible for making sure your use of Sealed is lawful where you live (securities, tax, sanctions). Do not use it where prohibited. Deposit only what you can afford to lose.

Before you send anything, check that `GET /api/custody/info` reports `"network": "mainnet"` and `"payoutsEnabled": true`. Company wallet: [Solana Explorer](https://explorer.solana.com/address/DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j) · [Solscan](https://solscan.io/account/DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j).

## Model
A Postgres double-entry ledger records every movement (auctions, clearing, pool, drips, fee splits, rewards). Real assets live only in the company wallet on mainnet. Proof of reserves compares that wallet's on-chain balances to ledger liabilities.

## Sign in (SIWS)
1. `POST /api/auth/nonce {wallet}` → `{nonce, message, expiresTs}`
2. Wallet signs `message` (statement: "Sign in to Sealed. This request will not trigger a transaction or cost any fees."). The domain in the message is `SIWS_DOMAIN` (`www.sealedsol.xyz` in production).
3. `POST /api/auth/verify {wallet, nonce, signature(base58)}` → `{token, wallet, expiresTs}`; send `Authorization: Bearer <token>`.

Nonces last 5 min and are single-use; sessions last 7 days (only a SHA-256 of the token is stored). `GET /api/auth/session` → `{wallet}`; `POST /api/auth/logout` revokes the token. Nonce/verify are rate-limited (429).

## Deposits
Send **SOL or USDC** on mainnet to the company wallet with memo `sealed:<depositRef>` (from `GET /api/account` or `GET /api/account/deposit/:asset`). Tokenized stocks are coming soon: their mainnet mints are not verified, so do not send them. Detected via Helius RPC, credited after `DEPOSIT_CONFIRMATIONS` (finality). Statuses: `detected → confirmed → credited` or `rejected`. `POST /api/account/deposits {signature}` nudges detection: 200 with the record, **202** if the tx is not finalized yet (or not found — it will be picked up automatically), **404** if the tx holds no deposit for your memo, 400 for a failed tx, 503 without an RPC. Transfers without the memo cannot be matched automatically.

## Trading
Commit (`/api/trade/commit`, same keccak preimage, bidder = signed-in wallet; deposit locked from available balance), reveal, swap, claim, stake, claim rewards — all API calls. Balances show `available` and `locked`. Mainnet launches use a 15–30 min commit window. Launched tokens are custodial ledger balances: trade, stake and claim them on Sealed; they cannot be withdrawn on-chain yet. Anti-snipe: buys within `ANTI_SNIPE_WINDOW_SEC = 2` of graduation are flagged.

## Withdrawals
`POST /api/account/withdrawals {asset, amount, destination}` — asset SOL or USDC. Auto-approved up to **$2,500** USD-equivalent and within **$25,000/day per wallet** (`WITHDRAWAL_LIMITS`), valued at live Jupiter Price API prices (rolling out). Otherwise — or when no fresh price is available — it is `pending_approval` until an operator approves (→ `queued`) or rejects (funds unlocked) at `/api/admin/withdrawals` with header `x-admin-token: <ADMIN_TOKEN>`; admin routes require `ADMIN_TOKEN`. `queued` withdrawals are sent only by the payout worker, which needs `COMPANY_WALLET_SECRET_KEY`, an RPC and SOL in the company wallet for fees; when the wallet runs low, payouts pause with a reason (rolling out) and withdrawals wait with funds locked. Statuses: `queued, pending_approval, sending, sent, failed, rejected`.

## Proof of reserves
`GET /api/custody/info` (public) → `{companyWallet, network, mode, payoutsEnabled, proofOfReserves:[{asset, onchain, liabilities, ratio, asOfTs}]}`. Verify the on-chain side yourself on the [Explorer](https://explorer.solana.com/address/DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j). It does not prove the ledger is complete, that assets stay put, or that the key is safe. Launched-token balances are ledger liabilities, not tokens held in the wallet.

## Risks
Operator key compromise (real funds lost) · operator insolvency/misconduct · ledger bugs · deposit mismatches · withdrawal delays (manual approval, missing price, fee-balance pause) · launched tokens not withdrawable on-chain · no audit · regulatory risk in your jurisdiction (your responsibility) · rule drift vs the program (2 s window instead of a slot). Credit pool: offchain credit lines are capped by the `credit_pool:<asset>` ledger balance, which the operator seeds from company funds with `POST /api/admin/credit-pool/seed {asset, amount, reference}` (idempotent on `reference`). Unseeded → graduations get no buyback vault.

Planned hardening: multisig/MPC, hot/cold split, independent attestations, on-chain withdrawal of launched tokens.
