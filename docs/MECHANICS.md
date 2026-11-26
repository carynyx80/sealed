# Mechanics

All numbers are constants in `packages/shared/src/constants.ts` (mirrored in `constants.rs`). Both execution modes use the same functions.

## Launch parameters
| Parameter | Bounds |
|---|---|
| Creator allocation | 0–200 bps (schema 400 + `CreatorAllocationTooHigh`) |
| Auction supply | 2,000–6,000 bps of supply; pool gets the rest + unsold |
| Commit window | program: 15–30 min mainnet, ≥ 2 min devnet; API schema: 2–30 min on any network |
| Reveal window | API 60–600 s, program 60–1,800 s, default 120 s |
| Drip interval / count | 120–300 s, default 180 s; default 48 drips |
| Clearing cap | ≥ targetRaise (API), ≥ floor × tokensForSale (program) |

Tokens have 6 decimals; prices are quote atoms per whole token.

## Sealed auction
- Commitment: `keccak256(bidder[32] ‖ max_price u64 LE ‖ bid_amount u64 LE ‖ salt[32])` (80-byte preimage). One bid per bidder per launch; `bid_amount ≤ deposit`.
- Tick grid: `price(i) = floor + i × tick`, `0 ≤ i < 64`. Reveals add `bid_amount` to `histogram[tick]`.
- Auto-reveal: preimage sealed with `nacl.box` to the relayer's x25519 key, wallet signs `sealed-reveal:v1:<launch>:<commitment>`. The relayer decrypts once on submission to verify integrity (plaintext discarded), then again at window open to reveal (≤ 8 attempts).

### Clearing (`computeClearing`)
1. Walk ticks high→low with B_k = Σ budgets at ticks ≥ k. Band (p_{k-1}, p_k]: `c_k = min(p_k, B_k·UNIT/S)`. P = max feasible c_k ≥ floor. None feasible → undersubscribed, P = floor, all fill.
2. If `P·S > cap·UNIT`: P = `cap·UNIT/S` (≥ floor), every qualifying bid pro-rated by cap/B_Q (`pro_rata_all`).
3. Else bids above P fill fully; marginal tick gets `(S·P/UNIT − B_above)/bucket` (`full_above`).

Per bid (`settleBid`): `spent = bid × fillNum/fillDen`, `tokens = spent·UNIT/P`, `refund = deposit − spent`. Unrevealed: refund deposit − 1%. Failed auction: full refund.

### Worked example (core.test.ts vector A)
floor 100, tick 10, S = 1,000 tokens, cap 10,000,000. Bids: 100,000 @ tick 5 (150), 100,000 @ tick 2 (120).
- Tick 5: c = min(150, 100) = 100 ≤ p4 = 140 → infeasible. Tick 2: c = min(120, 200) = 120 > p1 → **P = 120**.
- Value 120,000: tick-5 bid spends 100,000 (833.33 tokens, refund 0); marginal tick-2 bid spends 20,000 (fill 20,000/100,000; 166.67 tokens; refund 100,000 of a 120,000 deposit).
Other vectors: undersubscribed (tick 3: 10,000 → P = 100, all fill), between ticks (tick 10: 125,000 → P = 125), hard cap (cap 150,000 → P = 150, fill 150,000/400,000).

## Buyback vault
- `credit = min(raise × credit_bps/10,000, credit_pool_available, max_credit_per_launch)`; tiers standard 1,000 / plus 1,250 / premier 1,500 bps.
- Drip: `drips_executed ≥ count−1 ? balance : min(initial/count, balance)` — vault ends at exactly 0. Example: 1,000 USDC premier → 150 USDC → 48 × 3.125 every 3 min (144 min).
- Each drip is a fee-free buy through the pool; tokens bought are burned from the pool reserve. First drip at `graduated_ts + drip_interval` (not literally minute one).
- Onchain: vault authority is the launch PDA; only `execute_buyback_drip` moves funds out. Offchain: a backend ledger policy — trust the operator.

## Fees (`splitFees`)
Pool fee 1% (`POOL_FEE_BPS = 100`) in quote, on every swap.
- Repaying (outstanding > 0): `repay = min(fees·80%, outstanding)`, `ops = fees·20%`, overflow of the 80% share → flywheel split.
- Flywheel (outstanding = 0): holders 50%, platform buyback-burn 35%, treasury 15% + dust.
- Cases: (1000, 10,000) → 800/200; (1000, 300) → repay 300, ops 200, holders 250, burn 175, treasury 75; (1000, 0) → 500/350/150.
- Holder share accrues per **staked** token (`reward_per_share`, scale 1e12). If nothing is staked, it goes to treasury. Ops (20%) and buyback-burn (35%) both land as quote in the `platform_ops` account; platform-token burn is off-chain and not built.

## Anti-snipe
Onchain: a buy in `graduation_slot` creates an `AntiSnipeEntry`; stake / claim_rewards fail with `SniperIneligible`. Offchain: buys within 2 s of graduation are flagged. The buy itself is not blocked; the rule binds wallets, not tokens.
