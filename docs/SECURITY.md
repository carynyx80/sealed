# Security

No audit. No mainnet deployment.

## Custody disclosure
Default mode is **custodial**: deposits sit in `DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j`; balances are ledger entries. The operator can see submitted bids, delay or refuse withdrawals, and a key compromise could lose funds. No insurance or licence. See CUSTODY.md.

## Trust model
**Offchain:** operator key holder can move reserves and gate withdrawals; admin-token holder approves withdrawals over $2,500; chain observers see deposits/withdrawals to the company wallet but not bids or trades; the API never returns bids before reveal.
**Onchain (roadmap):** admin initializes once and cannot withdraw vault/escrow/pool; relayer can learn or withhold a reveal but cannot change it or move funds; crankers can only run due drips/distributions; creator gets ≤ 2% and cannot mint more (PDA mint authority).

## Invariants tested
- Clearing (tests passing): uniform price ≤ max; Σspent ≤ cap; Σtokens ≤ supply; refund + spent = deposit; no bid below P wins; monotone in added bids; order-independent.
- Fees (passing): exact sum; repay ≤ outstanding; flip at exactly 0 with overflow to flywheel; drips drain to 0.
- Commitment (passing): 80-byte layout; field/salt sensitivity. Schema: > 200 bps rejected. Demo world: legal transitions.
- API 26/26, defi 13/13, shared 7/7, invariants 34 + 1 todo (run 2026-11-26).
- Program suite + 14 math.rs tests: written, **not yet run**.
- Custodial ledger (Σ postings = 0, reserves ≥ liabilities, limits): in development.

## Known limitations
- Deposit sizes are public (escrow transfer onchain; company-wallet deposits offchain). Pad deposits.
- Lost salt + missed window → 1% slash.
- Relayer keys are ephemeral without `RELAYER_BOX_SEED`.
- Onchain keeper passes `keeper` instead of `cranker` and omits required accounts.
- Holder rewards require staking; with nothing staked the holder share goes to treasury.
- Platform-token buyback-burn (35%) and ops (20%) land as quote in `platform_ops`; the burn is not built.
- Anti-snipe binds wallets, not tokens. Offchain uses a 2 s window rather than a slot.
- API schema allows 2-minute commits on any network; only the program enforces 15 min on mainnet.
- Non-demo `POST /api/launches` returns 501 and omits drip args.
- Withdrawal USD limits use demo reference prices.
- `DEMO_MODE` endpoints are unauthenticated — never public.

## Roadmap
Custodial backend → custody hardening (multisig/MPC, hot/cold, attestations) → program to devnet (run tests, fix keeper) → onchain non-custodial mode → private deposits phases A/B/C (PRIVACY.md) → external audit, then mainnet.
