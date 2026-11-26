# Security

No audit. No mainnet deployment.

## Custody disclosure
Default mode is **custodial**: deposits sit in `DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j`; balances are ledger entries. The operator can see submitted bids, delay or refuse withdrawals, and a key compromise could lose funds. No insurance or licence. See CUSTODY.md.

## Trust model
**Offchain:** operator key holder can move reserves and gate withdrawals; admin-token holder (`x-admin-token`) approves or rejects withdrawals held over $2,500 or the $25,000 daily cap and can seed the credit pool ledger account; chain observers see deposits/withdrawals to the company wallet but not bids or trades; the API never returns bids before reveal.
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
- Hosted API runs `DEMO_MODE=true`: demo launches are merged with real offchain ones (`isDemo` per launch); custody workers stay off unless `CUSTODY_WORKERS=true`. `COMPANY_WALLET_SECRET_KEY` and `HELIUS_API_KEY` are not set, so no deposit is detected and no withdrawal is sent.
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
- API schema allows 2-minute commits on any network; only the program enforces 15 min on mainnet.
- With `EXECUTION_MODE=onchain` and no demo, `POST /api/launches` returns 501 and omits drip args (offchain mode creates a real launch for a signed-in creator).
- Withdrawal USD limits use demo reference prices.
- `DEMO_MODE` endpoints are unauthenticated — never public.

## Roadmap
Custodial backend (built, tests passing) → operator sets `COMPANY_WALLET_SECRET_KEY` + `HELIUS_API_KEY`, seeds the credit pool, leaves demo → custody hardening (multisig/MPC, hot/cold, attestations) → program to devnet (tests pass locally; deploy, fix keeper) → onchain non-custodial mode → private deposits phases A/B/C (PRIVACY.md) → external audit, then mainnet.
