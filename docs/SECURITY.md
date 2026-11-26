# Security

No audit. **Custodial on Solana mainnet with real funds (rolling out).** Company wallet: [`DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j`](https://explorer.solana.com/address/DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j).

## Custody disclosure
Default mode is **custodial on mainnet**: real deposits sit in `DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j`; balances are ledger entries. The company holds the funds. The operator can see submitted bids, delay or refuse withdrawals (manual approval above $2,500 / $25,000 per day or without a fresh price; payouts pause when the wallet lacks SOL for fees), and a key compromise could lose funds. Only SOL and USDC withdraw; launched tokens are ledger-only. Proof of reserves is a snapshot. No audit, insurance or licence. Users are responsible for complying with the laws of their jurisdiction. See [CUSTODY.md](CUSTODY.md).

## Trust model
**Offchain:** operator key holder can move reserves and gate withdrawals; admin-token holder (`x-admin-token`, requires `ADMIN_TOKEN`) approves or rejects withdrawals held over $2,500, over the $25,000 daily cap or without a fresh price, and can seed the credit pool ledger account; the browser RPC proxy (`POST /api/rpc`) exposes only allowlisted methods, rate limited, never the provider key; chain observers see deposits/withdrawals to the company wallet but not bids or trades; the API never returns bids before reveal.
**Onchain (roadmap):** admin initializes once and cannot withdraw vault/escrow/pool; relayer can learn or withhold a reveal but cannot change it or move funds; crankers can only run due drips/distributions; creator gets ≤ 2% and cannot mint more (PDA mint authority).

## Invariants tested
- Clearing (tests passing): uniform price ≤ max; Σspent ≤ cap; Σtokens ≤ supply; refund + spent = deposit; no bid below P wins; monotone in added bids; order-independent.
- Fees (passing): exact sum; repay ≤ outstanding; flip at exactly 0 with overflow to flywheel; drips drain to 0.
- Commitment (passing): 80-byte layout; field/salt sensitivity. Schema: > 200 bps rejected. Demo world: legal transitions.
- API 87/87 (`cd apps/api && node --import tsx --test test/*.test.ts`), defi 13/13, shared 7/7, invariants 34 + 1 todo (run 2026-11-26).
- Program: `anchor build` OK; 15/15 Rust unit tests; `anchor test -- --features test-mode` 18/18. Not deployed.
- Custodial ledger (tests passing): random-op fuzz keeps Σ postings = 0 per tx, stored balances = Σ entries, no negative user balances; idempotent replays; serialized concurrent debits; lifecycle reconciles supply and liabilities.
- Custody (tests passing): SIWS nonce replay/expiry/revocation; deposit parser fixtures + exactly-once crediting; withdrawal limits; payouts disabled without key; idempotent payout worker; admin auth.

## Known limitations
- Real funds sit in one hot company wallet controlled by one key (Railway secret). No multisig/MPC or hot/cold split yet.
- Launched tokens are custodial ledger balances and cannot be withdrawn on-chain yet; only SOL and USDC withdraw.
- Tokenized stocks are coming soon on mainnet (mints not verified); only SOL and USDC are enabled.
- Payouts depend on SOL in the company wallet for fees; when low they pause with a reason.
- Graduation seeds Sealed's own constant-product pool (program pool / ledger pool), not Raydium; the Raydium adapter in `packages/defi` is optional and unused.
- First buyback drip is due one interval after graduation (`graduated_ts + drip_interval`), not at graduation.
- Offchain credit lines are capped by the `credit_pool` ledger balance; until the operator seeds it (`POST /api/admin/credit-pool/seed`) graduations get no vault and go straight to the flywheel split.
- The relayer decrypts an auto-reveal envelope once at submission (to validate it against the commitment; plaintext discarded) and again when the reveal window opens.
- Deposit sizes are public (escrow transfer onchain; company-wallet deposits offchain). Pad deposits.
- Lost salt + missed window → 1% slash.
- Relayer keys are ephemeral without `RELAYER_BOX_SEED`.
- Onchain keeper passes `keeper` instead of `cranker` and omits required accounts.
- Holder rewards require staking; with nothing staked the holder share goes to treasury.
- Platform-token buyback-burn (35%) and ops (20%) land as quote in `platform_ops`; the burn is not built.
- Anti-snipe binds wallets, not tokens. Offchain uses a 2 s window rather than a slot.
- On mainnet the API requires a 15–30 min commit window (rolling out); devnet/localnet still accept 2 min.
- With `EXECUTION_MODE=onchain` and no demo, `POST /api/launches` returns 501 and omits drip args (offchain mode creates a real launch for a signed-in creator).
- Withdrawal USD limits use live Jupiter Price API prices (rolling out); without a fresh price withdrawals fail safe to manual approval, which can delay them.
- `DEMO_MODE` endpoints are unauthenticated — never public; demo is disabled on mainnet.

## Roadmap
Custodial backend (built, tests passing) → **mainnet custody (rolling out):** `NETWORK=mainnet`, `DEMO_MODE=false`, `COMPANY_WALLET_SECRET_KEY` + `HELIUS_API_KEY` + `ADMIN_TOKEN`, company wallet funded with SOL for fees, credit pool seeded (see the checklist in DEPLOYMENT.md) → custody hardening (multisig/MPC, hot/cold, attestations) → on-chain withdrawal of launched tokens → program to devnet, then mainnet (tests pass locally; deploy, fix keeper) → onchain non-custodial mode → private deposits phases A/B/C (PRIVACY.md) → external audit.
