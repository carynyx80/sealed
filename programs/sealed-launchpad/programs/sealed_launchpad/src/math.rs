//! Pure integer math: integer-for-integer ports of packages/shared/src/{clearing,fees,commitment}.ts.
//! All intermediate products are done in u128; every result is rounded DOWN.

use crate::constants::*;

pub const FILL_RULE_FULL_ABOVE: u8 = 0;
pub const FILL_RULE_PRO_RATA_ALL: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClearingResult {
    pub clearing_price: u64,
    /// Lowest tick receiving any fill (rule full_above: marginal/lowest filled tick); -1 if no bids.
    pub marginal_tick: i16,
    pub rule: u8,
    pub fill_num: u64,
    pub fill_den: u64,
    pub total_raised: u64,
    pub tokens_sold: u64,
    pub undersubscribed: bool,
}

#[inline]
fn price(floor: u128, tick: u128, i: usize) -> u128 {
    floor + tick * i as u128
}

fn to_u64(v: u128) -> Option<u64> {
    u64::try_from(v).ok()
}

/// Port of `computeClearing` (clearing.ts). Returns None on overflow / invalid input
/// (tokens_for_sale == 0 or floor_price == 0).
pub fn compute_clearing(
    floor_price: u64,
    tick_size: u64,
    buckets: &[u64],
    tokens_for_sale: u64,
    clearing_cap: u64,
) -> Option<ClearingResult> {
    let n = buckets.len();
    if tokens_for_sale == 0 || floor_price == 0 {
        return None;
    }
    let floor = floor_price as u128;
    let tick = tick_size as u128;
    let s = tokens_for_sale as u128;
    let unit = TOKEN_UNIT as u128;
    let cap = clearing_cap as u128;

    let total_budget: u128 = buckets.iter().map(|b| *b as u128).sum();
    if total_budget == 0 {
        return Some(ClearingResult {
            clearing_price: floor_price,
            marginal_tick: -1,
            rule: FILL_RULE_FULL_ABOVE,
            fill_num: 0,
            fill_den: 1,
            total_raised: 0,
            tokens_sold: 0,
            undersubscribed: true,
        });
    }

    // Step 1 — unconstrained clearing price.
    let mut p: Option<u128> = None;
    let mut cum: u128 = 0;
    for k in (0..n).rev() {
        cum += buckets[k] as u128;
        if buckets[k] == 0 && cum == 0 {
            continue;
        }
        let pk = price(floor, tick, k);
        let ck = core::cmp::min(pk, cum * unit / s);
        let lower = if k == 0 { floor - 1 } else { price(floor, tick, k - 1) };
        if ck > lower && ck >= floor {
            p = Some(match p {
                Some(x) => core::cmp::max(x, ck),
                None => ck,
            });
        }
    }
    let mut undersubscribed = false;
    let p = match p {
        Some(x) => x,
        None => {
            undersubscribed = true;
            floor
        }
    };

    // Step 2 — hard cap (exact comparison: P*S > cap*UNIT, no flooring).
    if p * s > cap * unit {
        let mut pc = cap * unit / s;
        if pc < floor {
            pc = floor;
        }
        let mut bq: u128 = 0;
        let mut marginal: i32 = -1;
        for i in 0..n {
            if price(floor, tick, i) >= pc && buckets[i] > 0 {
                bq += buckets[i] as u128;
                if marginal < 0 {
                    marginal = i as i32;
                }
            }
        }
        let raise = pc * s / unit;
        let fill_num = core::cmp::min(raise, bq);
        return Some(ClearingResult {
            clearing_price: to_u64(pc)?,
            marginal_tick: marginal as i16,
            rule: FILL_RULE_PRO_RATA_ALL,
            fill_num: to_u64(fill_num)?,
            fill_den: to_u64(bq)?,
            total_raised: to_u64(fill_num)?,
            tokens_sold: to_u64(fill_num * unit / pc)?,
            undersubscribed: false,
        });
    }

    // Step 3 — full fills above, pro-rata at marginal tick.
    let mut above: u128 = 0;
    let mut marginal: i32 = -1;
    for i in (0..n).rev() {
        let pi = price(floor, tick, i);
        if buckets[i] == 0 {
            continue;
        }
        if pi > p {
            above += buckets[i] as u128;
        } else if pi == p {
            marginal = i as i32;
        }
    }
    let mut lowest_filled: i32 = -1;
    for i in 0..n {
        if buckets[i] > 0 && price(floor, tick, i) >= p {
            lowest_filled = i as i32;
            break;
        }
    }

    if undersubscribed {
        let raised = above + if marginal >= 0 { buckets[marginal as usize] as u128 } else { 0 };
        return Some(ClearingResult {
            clearing_price: to_u64(p)?,
            marginal_tick: lowest_filled as i16,
            rule: FILL_RULE_FULL_ABOVE,
            fill_num: 1,
            fill_den: 1,
            total_raised: to_u64(raised)?,
            tokens_sold: to_u64(raised * unit / p)?,
            undersubscribed,
        });
    }

    let value = s * p / unit;
    let mb_all: u128 = if marginal >= 0 { buckets[marginal as usize] as u128 } else { 0 };
    if above + mb_all > value && (marginal < 0 || above >= value) {
        // P floored from B/S: pro-rate every qualifying bid to exactly `value` (Σtokens ≤ S, Σspent ≤ cap).
        let bq = above + mb_all;
        return Some(ClearingResult {
            clearing_price: to_u64(p)?,
            marginal_tick: lowest_filled as i16,
            rule: FILL_RULE_PRO_RATA_ALL,
            fill_num: to_u64(value)?,
            fill_den: to_u64(bq)?,
            total_raised: to_u64(value)?,
            tokens_sold: to_u64(value * unit / p)?,
            undersubscribed: false,
        });
    }
    if marginal < 0 {
        return Some(ClearingResult {
            clearing_price: to_u64(p)?,
            marginal_tick: lowest_filled as i16,
            rule: FILL_RULE_FULL_ABOVE,
            fill_num: 1,
            fill_den: 1,
            total_raised: to_u64(above)?,
            tokens_sold: to_u64(above * unit / p)?,
            undersubscribed: false,
        });
    }

    let remaining = if value > above { value - above } else { 0 };
    let mb = buckets[marginal as usize] as u128;
    let fill_num = core::cmp::min(remaining, mb);
    let raised = above + fill_num;
    Some(ClearingResult {
        clearing_price: to_u64(p)?,
        marginal_tick: marginal as i16,
        rule: FILL_RULE_FULL_ABOVE,
        fill_num: to_u64(fill_num)?,
        fill_den: to_u64(mb)?,
        total_raised: to_u64(raised)?,
        tokens_sold: to_u64(raised * unit / p)?,
        undersubscribed: false,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BidSettlement {
    pub spent: u64,
    pub tokens: u64,
    pub refund: u64,
    pub won: bool,
}

/// Port of `settleBid` (clearing.ts).
#[allow(clippy::too_many_arguments)]
pub fn settle_bid(
    clearing_price: u64,
    marginal_tick: i16,
    rule: u8,
    fill_num: u64,
    fill_den: u64,
    floor_price: u64,
    tick_size: u64,
    tick: u8,
    bid_amount: u64,
    deposit: u64,
) -> Option<BidSettlement> {
    let p = floor_price as u128 + tick_size as u128 * tick as u128;
    let cp = clearing_price as u128;
    let mut spent: u128 = 0;
    if marginal_tick >= 0 && p >= cp {
        let prorata = || -> Option<u128> {
            if fill_den == 0 {
                return None;
            }
            Some(bid_amount as u128 * fill_num as u128 / fill_den as u128)
        };
        if rule == FILL_RULE_PRO_RATA_ALL {
            spent = prorata()?;
        } else if p > cp {
            spent = bid_amount as u128;
        } else {
            spent = prorata()?;
        }
    }
    let tokens = if cp > 0 { spent * TOKEN_UNIT as u128 / cp } else { 0 };
    let spent = to_u64(spent)?;
    Some(BidSettlement {
        spent,
        tokens: to_u64(tokens)?,
        refund: deposit.checked_sub(spent)?,
        won: spent > 0,
    })
}

/// Tick index for `max_price`, or None when off-grid / out of range (port of `tickIndex`).
pub fn tick_index(floor_price: u64, tick_size: u64, max_price: u64, num_ticks: usize) -> Option<u8> {
    if max_price < floor_price || tick_size == 0 {
        return None;
    }
    let d = max_price - floor_price;
    if d % tick_size != 0 {
        return None;
    }
    let i = d / tick_size;
    if (i as u128) < num_ticks as u128 {
        Some(i as u8)
    } else {
        None
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct FeeSplit {
    pub credit_repay: u64,
    pub platform_ops: u64,
    pub holders: u64,
    pub platform_buyback_burn: u64,
    pub treasury: u64,
    pub credit_outstanding_after: u64,
}

/// Port of `splitFees` (fees.ts).
pub fn split_fees(fees: u64, credit_outstanding: u64) -> FeeSplit {
    let d = BPS_DENOMINATOR as u128;
    let f = fees as u128;
    let mut credit_repay: u128 = 0;
    let mut platform_ops: u128 = 0;
    let mut flywheel_base: u128 = f;
    if credit_outstanding > 0 {
        let repay_share = f * REPAY_CREDIT_BPS as u128 / d;
        platform_ops = f * REPAY_PLATFORM_BURN_OPS_BPS as u128 / d;
        credit_repay = core::cmp::min(repay_share, credit_outstanding as u128);
        flywheel_base = repay_share - credit_repay;
    }
    let holders = flywheel_base * FLYWHEEL_HOLDER_PAYOUT_BPS as u128 / d;
    let platform_buyback_burn = flywheel_base * FLYWHEEL_PLATFORM_BUYBACK_BURN_BPS as u128 / d;
    let treasury = f - credit_repay - platform_ops - holders - platform_buyback_burn;
    FeeSplit {
        credit_repay: credit_repay as u64,
        platform_ops: platform_ops as u64,
        holders: holders as u64,
        platform_buyback_burn: platform_buyback_burn as u64,
        treasury: treasury as u64,
        credit_outstanding_after: credit_outstanding - credit_repay as u64,
    }
}

/// Port of `computeCreditLine` (fees.ts). Returns None when credit_bps is out of range.
pub fn compute_credit_line(total_raised: u64, credit_bps: u16, pool_available: u64, per_launch_max: u64) -> Option<u64> {
    if !(MIN_CREDIT_BPS..=MAX_CREDIT_BPS).contains(&credit_bps) {
        return None;
    }
    let mut c = (total_raised as u128 * credit_bps as u128 / BPS_DENOMINATOR as u128) as u64;
    if c > pool_available {
        c = pool_available;
    }
    if c > per_launch_max {
        c = per_launch_max;
    }
    Some(c)
}

/// Port of `dripAmount` (fees.ts).
pub fn drip_amount(vault_initial: u64, drip_count: u16, drips_executed: u16, vault_balance: u64) -> u64 {
    if drips_executed as i32 >= drip_count as i32 - 1 {
        return vault_balance;
    }
    let slice = vault_initial / drip_count as u64;
    core::cmp::min(slice, vault_balance)
}

/// Port of `cpmmOut` (fees.ts).
pub fn cpmm_out(amount_in: u64, reserve_in: u64, reserve_out: u64) -> u64 {
    if amount_in == 0 || reserve_in == 0 || reserve_out == 0 {
        return 0;
    }
    (amount_in as u128 * reserve_out as u128 / (reserve_in as u128 + amount_in as u128)) as u64
}

/// Pool swap fee in quote atoms (rounded down).
pub fn pool_fee(amount: u64) -> u64 {
    (amount as u128 * POOL_FEE_BPS as u128 / BPS_DENOMINATOR as u128) as u64
}

/// Holder reward accrual: staked * rps / 1e12 − debt (saturating).
pub fn pending_rewards(staked: u64, reward_per_share: u128, reward_debt: u128) -> u64 {
    let acc = staked as u128 * reward_per_share / REWARD_SCALE;
    acc.saturating_sub(reward_debt) as u64
}

pub fn reward_debt(staked: u64, reward_per_share: u128) -> u128 {
    staked as u128 * reward_per_share / REWARD_SCALE
}

/// keccak256(bidder || max_price LE || bid_amount LE || salt) — 80-byte preimage (commitment.ts).
pub fn compute_commitment(bidder: &[u8; 32], max_price: u64, bid_amount: u64, salt: &[u8; 32]) -> [u8; 32] {
    solana_keccak_hasher::hashv(&[bidder, &max_price.to_le_bytes(), &bid_amount.to_le_bytes(), salt]).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    const U: u64 = 1_000_000;

    fn hist(m: &[(usize, u64)]) -> [u64; 64] {
        let mut h = [0u64; 64];
        for (i, v) in m {
            h[*i] = *v;
        }
        h
    }

    fn clear(h: &[u64; 64], cap: u64) -> ClearingResult {
        compute_clearing(100, 10, h, 1_000 * U, cap).unwrap()
    }

    fn settle(r: &ClearingResult, tick: u8, amt: u64, dep: u64) -> BidSettlement {
        settle_bid(r.clearing_price, r.marginal_tick, r.rule, r.fill_num, r.fill_den, 100, 10, tick, amt, dep).unwrap()
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{:02x}", x)).collect()
    }

    #[test]
    fn commitment_vector() {
        let c = compute_commitment(&[0u8; 32], 150, 5000, &[7u8; 32]);
        assert_eq!(hex(&c), "3b10bfafd02724e8e5f26313c9e95931ac6a3429bcda3816144916013c12fe7f");
    }

    #[test]
    fn vector_a_oversubscribed_marginal_pro_rated() {
        let r = clear(&hist(&[(5, 100_000), (2, 100_000)]), 10_000_000);
        assert_eq!(r.clearing_price, 120);
        assert_eq!(r.marginal_tick, 2);
        assert_eq!(r.rule, FILL_RULE_FULL_ABOVE);
        assert_eq!((r.fill_num, r.fill_den), (20_000, 100_000));
        assert_eq!(r.total_raised, 120_000);
        assert_eq!(r.tokens_sold, 1_000 * U);
        assert!(!r.undersubscribed);
        let hi = settle(&r, 5, 100_000, 100_000);
        assert_eq!(hi.spent, 100_000);
        let lo = settle(&r, 2, 100_000, 120_000);
        assert_eq!(lo.spent, 20_000);
        assert_eq!(lo.refund, 100_000);
    }

    #[test]
    fn undersubscribed_floor_full_fill() {
        let r = clear(&hist(&[(3, 10_000)]), 10_000_000);
        assert_eq!(r.clearing_price, 100);
        assert!(r.undersubscribed);
        assert_eq!(settle(&r, 3, 10_000, 10_000).tokens, 100 * U);
    }

    #[test]
    fn between_ticks() {
        let r = clear(&hist(&[(10, 125_000)]), 10_000_000);
        assert_eq!(r.clearing_price, 125);
        assert_eq!(settle(&r, 10, 125_000, 125_000).tokens, 1_000 * U);
    }

    #[test]
    fn hard_cap_pro_rata_all() {
        let r = clear(&hist(&[(20, 300_000), (15, 100_000)]), 150_000);
        assert_eq!(r.rule, FILL_RULE_PRO_RATA_ALL);
        assert_eq!(r.clearing_price, 150);
        assert_eq!(r.fill_num, 150_000);
        assert_eq!(r.fill_den, 400_000);
    }

    #[test]
    fn vector_b_floored_price_pro_rata_all() {
        let mut h = [0u64; 64];
        h[2] = 6_695_036;
        h[17] = 7_140_768;
        let s = 366_461_818_897u64;
        let r = compute_clearing(10, 3, &h, s, 21_984_877).unwrap();
        assert_eq!(r.clearing_price, 19);
        assert_eq!(r.rule, FILL_RULE_PRO_RATA_ALL);
        assert_eq!(r.fill_num, 6_962_774);
        assert_eq!(r.fill_num as u128, s as u128 * 19 / 1_000_000);
        assert_eq!(r.fill_den, 7_140_768);
        // Invariants: Σspent ≤ cap, Σtokens ≤ S.
        let st = settle_bid(r.clearing_price, r.marginal_tick, r.rule, r.fill_num, r.fill_den, 10, 3, 17, h[17], h[17]).unwrap();
        assert!(st.spent <= 21_984_877);
        assert!(st.tokens <= s);
    }

    #[test]
    fn no_bids() {
        let r = clear(&[0u64; 64], 10_000_000);
        assert_eq!(r.marginal_tick, -1);
        assert_eq!(r.total_raised, 0);
        let s = settle(&r, 3, 0, 500);
        assert_eq!((s.spent, s.refund), (0, 500));
    }

    #[test]
    fn loser_below_clearing_refunded() {
        let r = clear(&hist(&[(5, 100_000), (2, 100_000), (0, 50_000)]), 10_000_000);
        assert_eq!(r.clearing_price, 120);
        let l = settle(&r, 0, 50_000, 60_000);
        assert_eq!((l.spent, l.tokens, l.refund, l.won), (0, 0, 60_000, false));
    }

    #[test]
    fn tick_index_grid() {
        assert_eq!(tick_index(100, 10, 150, 64), Some(5));
        assert_eq!(tick_index(100, 10, 155, 64), None);
        assert_eq!(tick_index(100, 10, 99, 64), None);
        assert_eq!(tick_index(100, 10, 100 + 640, 64), None);
        assert_eq!(tick_index(100, 10, 100 + 630, 64), Some(63));
    }

    #[test]
    fn fee_split_phases() {
        let a = split_fees(1000, 10_000);
        assert_eq!((a.credit_repay, a.platform_ops, a.holders), (800, 200, 0));
        assert_eq!(a.credit_outstanding_after, 9_200);
        let b = split_fees(1000, 300);
        assert_eq!(b.credit_repay, 300);
        assert_eq!(b.holders, 250);
        assert_eq!(b.platform_buyback_burn, 175);
        assert_eq!(b.treasury, 1000 - 300 - 200 - 250 - 175);
        assert_eq!(b.credit_outstanding_after, 0);
        let c = split_fees(1000, 0);
        assert_eq!((c.holders, c.platform_buyback_burn, c.treasury), (500, 350, 150));
        let d = split_fees(7, 0); // dust → treasury
        assert_eq!(d.holders + d.platform_buyback_burn + d.treasury, 7);
    }

    #[test]
    fn credit_line_caps() {
        assert_eq!(compute_credit_line(1_000_000, 1_000, u64::MAX, u64::MAX), Some(100_000));
        assert_eq!(compute_credit_line(1_000_000, 1_500, 50_000, u64::MAX), Some(50_000));
        assert_eq!(compute_credit_line(1_000_000, 1_250, u64::MAX, 10_000), Some(10_000));
        assert_eq!(compute_credit_line(1_000_000, 999, u64::MAX, u64::MAX), None);
    }

    #[test]
    fn drip_slices_and_sweep() {
        assert_eq!(drip_amount(4_800, 48, 0, 4_800), 100);
        assert_eq!(drip_amount(4_805, 48, 46, 105), 100);
        assert_eq!(drip_amount(4_805, 48, 47, 105), 105);
        assert_eq!(drip_amount(100, 2, 0, 30), 30);
    }

    #[test]
    fn cpmm() {
        assert_eq!(cpmm_out(100, 1_000, 1_000), 90);
        assert_eq!(cpmm_out(0, 1_000, 1_000), 0);
        assert_eq!(pool_fee(10_000), 100);
    }

    #[test]
    fn rewards_accrual() {
        let rps = 500u128 * REWARD_SCALE / 1_000;
        assert_eq!(pending_rewards(1_000, rps, 0), 500);
        assert_eq!(pending_rewards(1_000, rps, reward_debt(1_000, rps)), 0);
    }
}
