import { TOKEN_UNIT } from "./constants.js";

/**
 * Uniform-price clearing over a tick histogram — the canonical algorithm.
 * The Rust `clear_auction` + `claim_or_refund` MUST produce byte-identical integer results
 * (see test vectors in __tests__/clearing.test.ts; port them to Rust unit tests).
 *
 * Units: prices = quote atoms per whole token (TOKEN_UNIT token atoms). Budgets = quote atoms.
 * Supply = token atoms. All math in unsigned integers, rounding DOWN (in favour of the protocol/refunds).
 *
 * Reveals add each bid's `bidAmount` into `buckets[tick]`. Then:
 *
 * 1. Walk ticks from highest to lowest keeping B_k = Σ budgets with tick ≥ k.
 *    Within price band (p_{k-1}, p_k] demand is B_k / p, so the best feasible price there is
 *    c_k = min(p_k, B_k * UNIT / S). Unconstrained clearing price P = max_k c_k over k with c_k ≥ floor
 *    and c_k > p_{k-1} (for k=0 the lower bound is the floor itself, inclusive).
 *    If no band is feasible (undersubscribed: B_0*UNIT/S < floor) → P = floor, everyone with a bid fills
 *    fully; unsold supply goes to the pool.
 * 2. Hard cap: if P * S / UNIT > clearingCap → P = clearingCap * UNIT / S (rounded down, but never below floor),
 *    and EVERY qualifying bid (tick price ≥ P) is pro-rated by fill = cap / B_Q.
 * 3. Otherwise, bids with tick price > P fill fully; bids whose tick price == P (marginal tick) are
 *    pro-rated: marginalFillNum / marginalFillDen = (S*P/UNIT − B_above) / bucket[marginal].
 *
 * Per-bid settlement (claim_or_refund):
 *    spent  = bidAmount * fillNum / fillDen   (fillNum/fillDen = 1/1 for full fills, 0/1 for losers)
 *    tokens = spent * UNIT / P
 *    refund = deposit − spent   (deposit is the escrowed collateral, ≥ bidAmount)
 */

export interface ClearingInput {
  floorPrice: bigint;
  tickSize: bigint;
  numTicks: number;
  buckets: bigint[]; // length numTicks, quote atoms revealed per tick
  tokensForSale: bigint; // token atoms
  clearingCap: bigint; // quote atoms (max raise)
}

export type FillRule = "full_above" | "pro_rata_all";

export interface ClearingResult {
  clearingPrice: bigint; // quote atoms per whole token
  /** Lowest tick index that receives any fill; -1 if no bids at all. */
  marginalTick: number;
  rule: FillRule;
  /** Fill fraction for marginal tick (rule=full_above) or for all qualifying ticks (rule=pro_rata_all). */
  fillNum: bigint;
  fillDen: bigint;
  totalRaised: bigint; // quote atoms actually spent by winners (sum of per-bid spent, upper bound before per-bid rounding)
  tokensSold: bigint; // token atoms (upper bound before per-bid rounding)
  undersubscribed: boolean;
}

const minB = (a: bigint, b: bigint) => (a < b ? a : b);
const maxB = (a: bigint, b: bigint) => (a > b ? a : b);

export function computeClearing(input: ClearingInput): ClearingResult {
  const { floorPrice, tickSize, numTicks, buckets, tokensForSale: S, clearingCap } = input;
  if (buckets.length !== numTicks) throw new Error("buckets length mismatch");
  if (S <= 0n) throw new Error("tokensForSale must be > 0");
  const price = (i: number) => floorPrice + tickSize * BigInt(i);

  const totalBudget = buckets.reduce((a, b) => a + b, 0n);
  if (totalBudget === 0n) {
    return { clearingPrice: floorPrice, marginalTick: -1, rule: "full_above", fillNum: 0n, fillDen: 1n, totalRaised: 0n, tokensSold: 0n, undersubscribed: true };
  }

  // Step 1 — unconstrained clearing price.
  let P = -1n;
  let cum = 0n;
  for (let k = numTicks - 1; k >= 0; k--) {
    cum += buckets[k]!;
    if (buckets[k] === 0n && cum === 0n) continue;
    const pk = price(k);
    const ck = minB(pk, (cum * TOKEN_UNIT) / S);
    const lower = k === 0 ? floorPrice - 1n : price(k - 1); // band is (p_{k-1}, p_k]; floor inclusive at k=0
    if (ck > lower && ck >= floorPrice) P = maxB(P, ck);
  }

  let undersubscribed = false;
  if (P < 0n) {
    P = floorPrice;
    undersubscribed = true;
  }

  // Step 2 — hard cap (exact comparison: P*S > cap*UNIT, no flooring).
  if (P * S > clearingCap * TOKEN_UNIT) {
    let Pc = (clearingCap * TOKEN_UNIT) / S;
    if (Pc < floorPrice) Pc = floorPrice;
    // qualifying = ticks with price ≥ Pc
    let BQ = 0n;
    let marginal = -1;
    for (let i = 0; i < numTicks; i++) {
      if (price(i) >= Pc && buckets[i]! > 0n) {
        BQ += buckets[i]!;
        if (marginal < 0) marginal = i;
      }
    }
    const raise = (Pc * S) / TOKEN_UNIT;
    const fillNum = minB(raise, BQ);
    return { clearingPrice: Pc, marginalTick: marginal, rule: "pro_rata_all", fillNum, fillDen: BQ, totalRaised: fillNum, tokensSold: (fillNum * TOKEN_UNIT) / Pc, undersubscribed: false };
  }

  // Step 3 — full fills above, pro-rata at marginal tick.
  let above = 0n; // budgets with price > P
  let marginal = -1;
  for (let i = numTicks - 1; i >= 0; i--) {
    const p = price(i);
    if (buckets[i] === 0n) continue;
    if (p > P) above += buckets[i]!;
    else if (p === P) marginal = i;
  }
  const lowestFilled = (() => {
    for (let i = 0; i < numTicks; i++) if (buckets[i]! > 0n && price(i) >= P) return i;
    return -1;
  })();

  if (undersubscribed) {
    // Demand < supply even at the floor: everyone at/above the floor fills fully.
    const raised = above + (marginal >= 0 ? buckets[marginal]! : 0n);
    return { clearingPrice: P, marginalTick: lowestFilled, rule: "full_above", fillNum: 1n, fillDen: 1n, totalRaised: raised, tokensSold: (raised * TOKEN_UNIT) / P, undersubscribed };
  }

  const value = (S * P) / TOKEN_UNIT;
  const mbAll = marginal >= 0 ? buckets[marginal]! : 0n;
  if (above + mbAll > value && (marginal < 0 || above >= value)) {
    // P was floored from B/S (interior of a band): demand above P slightly exceeds S*P.
    // Pro-rate every qualifying bid to exactly `value` so Σtokens ≤ S and Σspent ≤ cap.
    const BQ = above + mbAll;
    return { clearingPrice: P, marginalTick: lowestFilled, rule: "pro_rata_all", fillNum: value, fillDen: BQ, totalRaised: value, tokensSold: (value * TOKEN_UNIT) / P, undersubscribed: false };
  }
  if (marginal < 0) {
    return { clearingPrice: P, marginalTick: lowestFilled, rule: "full_above", fillNum: 1n, fillDen: 1n, totalRaised: above, tokensSold: (above * TOKEN_UNIT) / P, undersubscribed: false };
  }

  const remaining = value > above ? value - above : 0n;
  const mb = buckets[marginal]!;
  const fillNum = minB(remaining, mb);
  const raised = above + fillNum;
  return { clearingPrice: P, marginalTick: marginal, rule: "full_above", fillNum, fillDen: mb, totalRaised: raised, tokensSold: (raised * TOKEN_UNIT) / P, undersubscribed: false };
}

export interface BidSettlement {
  spent: bigint;
  tokens: bigint;
  refund: bigint;
  won: boolean;
}

/** Per-bid settlement given the clearing result. `tick` is the bid's revealed tick index. */
export function settleBid(r: ClearingResult, floorPrice: bigint, tickSize: bigint, tick: number, bidAmount: bigint, deposit: bigint): BidSettlement {
  const p = floorPrice + tickSize * BigInt(tick);
  let spent = 0n;
  if (r.marginalTick >= 0 && p >= r.clearingPrice) {
    if (r.rule === "pro_rata_all") spent = (bidAmount * r.fillNum) / r.fillDen;
    else if (p > r.clearingPrice) spent = bidAmount;
    else spent = (bidAmount * r.fillNum) / r.fillDen; // marginal tick
  }
  const tokens = r.clearingPrice > 0n ? (spent * TOKEN_UNIT) / r.clearingPrice : 0n;
  return { spent, tokens, refund: deposit - spent, won: spent > 0n };
}
