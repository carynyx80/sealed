import { BPS_DENOMINATOR, POOL_FEE_BPS, TOKEN_UNIT, cpmmOut } from "@sealed/shared";

/**
 * Quote helpers for the program's INTERNAL constant-product pool (the canonical graduation venue, see
 * @sealed/shared program.ts). All math is bigint atoms and mirrors the on-chain `swap` instruction:
 *
 *   buy  (quote → token): fee = amountIn * POOL_FEE_BPS / 10_000 (quote), net = amountIn − fee,
 *                         tokensOut = cpmmOut(net, quoteReserve, tokenReserve)
 *   sell (token → quote): grossQuote = cpmmOut(amountIn, tokenReserve, quoteReserve),
 *                         fee = grossQuote * POOL_FEE_BPS / 10_000 (quote), quoteOut = grossQuote − fee
 *
 * The fee is always denominated in quote and routed to the Fee Collector PDA. Rounding: integer floor, as in
 * shared `cpmmOut`.
 */

export interface PoolReserves {
  quoteReserve: bigint; // quote atoms
  tokenReserve: bigint; // token atoms (6 decimals)
}

export interface CpmmQuote {
  isBuy: boolean;
  amountIn: bigint;
  amountOut: bigint;
  /** Pool fee in quote atoms (1%). */
  feeQuote: bigint;
  /** Spot price before the trade, quote atoms per whole token. */
  spotPrice: bigint;
  /** Effective execution price incl. fee, quote atoms per whole token. */
  executionPrice: bigint;
  /** Spot price after the trade, quote atoms per whole token. */
  postTradePrice: bigint;
  /** Price impact of the trade itself (excl. fee), basis points. */
  priceImpactBps: number;
  /** Reserves after the trade (fee leaves the pool). */
  reservesAfter: PoolReserves;
}

export const feeOn = (amount: bigint, feeBps: number = POOL_FEE_BPS): bigint =>
  (amount * BigInt(feeBps)) / BigInt(BPS_DENOMINATOR);

/** Quote atoms per whole token. */
export function spotPrice(r: PoolReserves): bigint {
  if (r.tokenReserve <= 0n) return 0n;
  return (r.quoteReserve * TOKEN_UNIT) / r.tokenReserve;
}

function impactBps(spot: bigint, quoteNoFee: bigint, tokens: bigint): number {
  if (spot <= 0n || tokens <= 0n) return 0;
  // |exec − spot| / spot without flooring exec first: exec = quoteNoFee*UNIT/tokens
  const num = quoteNoFee * TOKEN_UNIT;
  const den = spot * tokens;
  const diff = num > den ? num - den : den - num;
  return Number((diff * BigInt(BPS_DENOMINATOR)) / den);
}

export function quoteBuy(quoteIn: bigint, r: PoolReserves, feeBps: number = POOL_FEE_BPS): CpmmQuote {
  const spot = spotPrice(r);
  const feeQuote = feeOn(quoteIn, feeBps);
  const net = quoteIn - feeQuote;
  const out = cpmmOut(net, r.quoteReserve, r.tokenReserve);
  const after = { quoteReserve: r.quoteReserve + net, tokenReserve: r.tokenReserve - out };
  return {
    isBuy: true,
    amountIn: quoteIn,
    amountOut: out,
    feeQuote,
    spotPrice: spot,
    executionPrice: out > 0n ? (quoteIn * TOKEN_UNIT) / out : 0n,
    postTradePrice: spotPrice(after),
    priceImpactBps: impactBps(spot, net, out),
    reservesAfter: after,
  };
}

export function quoteSell(tokensIn: bigint, r: PoolReserves, feeBps: number = POOL_FEE_BPS): CpmmQuote {
  const spot = spotPrice(r);
  const gross = cpmmOut(tokensIn, r.tokenReserve, r.quoteReserve);
  const feeQuote = feeOn(gross, feeBps);
  const out = gross - feeQuote;
  const after = { quoteReserve: r.quoteReserve - gross, tokenReserve: r.tokenReserve + tokensIn };
  return {
    isBuy: false,
    amountIn: tokensIn,
    amountOut: out,
    feeQuote,
    spotPrice: spot,
    executionPrice: tokensIn > 0n ? (out * TOKEN_UNIT) / tokensIn : 0n,
    postTradePrice: spotPrice(after),
    priceImpactBps: impactBps(spot, gross, tokensIn),
    reservesAfter: after,
  };
}

export function quoteSwap(amountIn: bigint, isBuy: boolean, r: PoolReserves, feeBps: number = POOL_FEE_BPS): CpmmQuote {
  return isBuy ? quoteBuy(amountIn, r, feeBps) : quoteSell(amountIn, r, feeBps);
}

/** Minimum acceptable output for the `swap` ix `min_amount_out` arg. */
export function minOutWithSlippage(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > BPS_DENOMINATOR) throw new RangeError("slippageBps out of range");
  return (amountOut * BigInt(BPS_DENOMINATOR - slippageBps)) / BigInt(BPS_DENOMINATOR);
}

/**
 * Approximate reserves from a UI market snapshot (DTO numbers) when on-chain reserves are not loaded:
 * quoteReserve = liquidityQuote/2 (liquidity reported as both sides in quote), tokenReserve = quoteReserve/price.
 */
export function reservesFromMarket(m: { price: number; liquidityQuote: number }, quoteDecimals: number): PoolReserves {
  const quoteSideUi = m.liquidityQuote / 2;
  const tokenSideUi = m.price > 0 ? quoteSideUi / m.price : 0;
  return {
    quoteReserve: uiToAtoms(quoteSideUi, quoteDecimals),
    tokenReserve: uiToAtoms(tokenSideUi, 6),
  };
}

/** Convert UI number → bigint atoms without float drift (truncates beyond `decimals`). */
export function uiToAtoms(v: number | string, decimals: number): bigint {
  const s = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(Math.min(decimals, 20)) : "0") : v.trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === "" || s === "-") throw new Error(`invalid amount: ${v}`);
  const neg = s.startsWith("-");
  const [i = "0", f = ""] = (neg ? s.slice(1) : s).split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  const out = BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return neg ? -out : out;
}

/** bigint atoms → UI number. */
export function atomsToUi(v: bigint, decimals: number): number {
  const d = 10n ** BigInt(decimals);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const n = Number(a / d) + Number(a % d) / Number(d);
  return neg ? -n : n;
}
