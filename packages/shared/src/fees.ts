import { BPS_DENOMINATOR, FLYWHEEL_SPLIT, MAX_CREDIT_BPS, MIN_CREDIT_BPS, REPAY_SPLIT } from "./constants.js";

/**
 * Fee splitter — mirrors Rust `distribute_fees`. Integer quote atoms, rounding down; dust → treasury.
 *
 * Phase "repaying" (creditOutstanding > 0):
 *   repay = min(fees * 80%, outstanding); ops = fees * 20%;
 *   any part of the 80% exceeding outstanding (the crossover) is split by the flywheel ratios.
 * Phase "flywheel" (creditOutstanding == 0):
 *   holders 50%, platform buyback-burn 35%, treasury 15% (+ rounding dust).
 */
export interface FeeSplit {
  creditRepay: bigint;
  platformOps: bigint; // phase-1 20% (platform burn / operations)
  holders: bigint;
  platformBuybackBurn: bigint;
  treasury: bigint;
  creditOutstandingAfter: bigint;
}

export function splitFees(fees: bigint, creditOutstanding: bigint): FeeSplit {
  const D = BigInt(BPS_DENOMINATOR);
  let creditRepay = 0n;
  let platformOps = 0n;
  let flywheelBase = fees;

  if (creditOutstanding > 0n) {
    const repayShare = (fees * BigInt(REPAY_SPLIT.creditRepayBps)) / D;
    platformOps = (fees * BigInt(REPAY_SPLIT.platformBurnOpsBps)) / D;
    creditRepay = repayShare < creditOutstanding ? repayShare : creditOutstanding;
    flywheelBase = repayShare - creditRepay; // overflow past full repayment
  }

  const holders = (flywheelBase * BigInt(FLYWHEEL_SPLIT.holderPayoutBps)) / D;
  const platformBuybackBurn = (flywheelBase * BigInt(FLYWHEEL_SPLIT.platformBuybackBurnBps)) / D;
  const treasury = fees - creditRepay - platformOps - holders - platformBuybackBurn;

  return { creditRepay, platformOps, holders, platformBuybackBurn, treasury, creditOutstandingAfter: creditOutstanding - creditRepay };
}

/** Credit line advanced at graduation: raise * creditBps, capped by pool liquidity and per-launch max. */
export function computeCreditLine(totalRaised: bigint, creditBps: number, poolAvailable: bigint, perLaunchMax: bigint): bigint {
  if (creditBps < MIN_CREDIT_BPS || creditBps > MAX_CREDIT_BPS) throw new RangeError("credit bps out of range");
  let c = (totalRaised * BigInt(creditBps)) / BigInt(BPS_DENOMINATOR);
  if (c > poolAvailable) c = poolAvailable;
  if (c > perLaunchMax) c = perLaunchMax;
  return c;
}

/** Drip size: equal slices, last drip sweeps remainder. */
export function dripAmount(vaultInitial: bigint, dripCount: number, dripsExecuted: number, vaultBalance: bigint): bigint {
  if (dripsExecuted >= dripCount - 1) return vaultBalance;
  const slice = vaultInitial / BigInt(dripCount);
  return slice < vaultBalance ? slice : vaultBalance;
}

/** Constant-product swap with fee taken from input (quote side for buys, output quote for sells is handled by caller). */
export function cpmmOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  return (amountIn * reserveOut) / (reserveIn + amountIn);
}
