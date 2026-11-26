# Custody (offchain custodial mode — default)

Status: **in development.** Contract: `packages/shared/src/custody.ts`. Server: `apps/api/src/offchain/**`.

> **Disclosure.** Deposits leave your wallet and sit in the company wallet `DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j`. Your balance is a ledger entry. The operator can pause, delay or refuse withdrawals and sees your bids once submitted; a compromised operator key could lose funds. No insurance, no audit. The non-custodial alternative (the Anchor program) is roadmap only.

## Model
A Postgres double-entry ledger records every movement (auctions, clearing, pool, drips, fee splits, rewards). Real assets live only in the company wallet. Proof of reserves compares that wallet's on-chain balances to ledger liabilities.

## Sign in (SIWS)
1. `POST /api/auth/nonce {wallet}` → `{nonce, message, expiresTs}`
2. Wallet signs `message` (statement: "Sign in to Sealed. This request will not trigger a transaction or cost any fees.")
3. `POST /api/auth/verify {wallet, nonce, signature(base58)}` → `{token}`; send `Authorization: Bearer <token>`.

## Deposits
Send SOL/SPL to the company wallet with memo `sealed:<depositRef>` (from `GET /api/account` or `GET /api/account/deposit/:asset`). Detected via Helius RPC, credited after `DEPOSIT_CONFIRMATIONS` (finality). Statuses: `detected → confirmed → credited` or `rejected`. `POST /api/account/deposits {signature}` nudges detection. Transfers without the memo cannot be matched automatically.

## Trading
Commit (`/api/trade/commit`, same keccak preimage, bidder = signed-in wallet; deposit locked from available balance), reveal, swap, claim, stake, claim rewards — all API calls. Balances show `available` and `locked`. Anti-snipe: buys within `ANTI_SNIPE_WINDOW_SEC = 2` of graduation are flagged.

## Withdrawals
`POST /api/account/withdrawals {asset, amount, destination}`. Auto-approved up to **$2,500** USD-equivalent and within **$25,000/day per wallet** (`WITHDRAWAL_LIMITS`); otherwise, or when `COMPANY_WALLET_SECRET_KEY` is unset (`payoutsEnabled=false`), it waits for manual approval at `/api/admin/withdrawals` (`ADMIN_TOKEN`). Statuses: `queued, pending_approval, sending, sent, failed, rejected`. USD limits use the registry's demo reference prices.

## Proof of reserves
`GET /api/custody/info` (public) → `{companyWallet, network, mode, payoutsEnabled, proofOfReserves:[{asset, onchain, liabilities, ratio, asOfTs}]}`. It does not prove the ledger is complete, that assets stay put, or that the key is safe.

## Risks
Operator key compromise · operator insolvency/misconduct · ledger bugs · deposit mismatches · withdrawal delays · rule drift vs the program (2 s window instead of a slot). Planned hardening: multisig/MPC, hot/cold split, independent attestations.
