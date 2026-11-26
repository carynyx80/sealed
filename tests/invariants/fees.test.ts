import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { splitFees, computeCreditLine, dripAmount, FLYWHEEL_SPLIT, REPAY_SPLIT, BPS_DENOMINATOR } from "@sealed/shared";
import { forAll, jsonBig } from "../lib/rng.ts";

const D = BigInt(BPS_DENOMINATOR);
const sumSplit = (s: ReturnType<typeof splitFees>) => s.creditRepay + s.platformOps + s.holders + s.platformBuybackBurn + s.treasury;

describe("fee splitter invariants (splitFees)", () => {
  test("split sums to the input exactly, every leg ≥ 0", () => {
    forAll("sum", (r) => {
      const fees = r.bool(0.05) ? 0n : r.logBig(18);
      const outstanding = r.bool(0.3) ? 0n : r.logBig(18);
      const s = splitFees(fees, outstanding);
      assert.equal(sumSplit(s), fees, jsonBig({ fees, outstanding, s }));
      for (const [k, v] of Object.entries(s)) assert.ok((v as bigint) >= 0n, `${k} negative: ${jsonBig(s)}`);
    }, 2000);
  });

  test("repay never exceeds outstanding (nor 80% of fees); outstandingAfter = outstanding − repay ≥ 0", () => {
    forAll("repay-cap", (r) => {
      const fees = r.logBig(18);
      const outstanding = r.logBig(18);
      const s = splitFees(fees, outstanding);
      assert.ok(s.creditRepay <= outstanding);
      assert.ok(s.creditRepay <= (fees * BigInt(REPAY_SPLIT.creditRepayBps)) / D);
      assert.equal(s.creditOutstandingAfter, outstanding - s.creditRepay);
      assert.ok(s.creditOutstandingAfter >= 0n);
    }, 2000);
  });

  test("repaying phase: ops leg is exactly 20%, nothing to flywheel unless the 80% overshoots", () => {
    forAll("phase1", (r) => {
      const fees = r.logBig(15);
      const repayShare = (fees * BigInt(REPAY_SPLIT.creditRepayBps)) / D;
      const outstanding = repayShare + r.logBig(12); // strictly more than this batch can repay
      const s = splitFees(fees, outstanding);
      assert.equal(s.creditRepay, repayShare);
      assert.equal(s.platformOps, (fees * BigInt(REPAY_SPLIT.platformBurnOpsBps)) / D);
      assert.equal(s.holders, 0n);
      assert.equal(s.platformBuybackBurn, 0n);
      assert.ok(s.treasury <= 1n, "only rounding dust goes to treasury while repaying");
    });
  });

  test("flywheel phase (outstanding == 0): 50/35/15 with dust → treasury, no repay/ops", () => {
    forAll("phase2", (r) => {
      const fees = r.logBig(18);
      const s = splitFees(fees, 0n);
      assert.equal(s.creditRepay, 0n);
      assert.equal(s.platformOps, 0n);
      assert.equal(s.holders, (fees * BigInt(FLYWHEEL_SPLIT.holderPayoutBps)) / D);
      assert.equal(s.platformBuybackBurn, (fees * BigInt(FLYWHEEL_SPLIT.platformBuybackBurnBps)) / D);
      assert.ok(s.treasury >= (fees * BigInt(FLYWHEEL_SPLIT.treasuryBps)) / D);
      assert.ok(s.treasury - (fees * BigInt(FLYWHEEL_SPLIT.treasuryBps)) / D <= 2n, "dust ≤ 2 atoms");
    });
  });

  test("phase transition is exact at 0: a fee stream drives outstanding to exactly 0, then flywheel takes over", () => {
    forAll("transition", (r) => {
      let outstanding = r.logBig(14);
      const initial = outstanding;
      let repaidTotal = 0n;
      let steps = 0;
      let sawCrossover = false;
      while (outstanding > 0n && steps < 10_000) {
        const fees = r.logBig(13);
        const s = splitFees(fees, outstanding);
        assert.equal(sumSplit(s), fees);
        const repayShare = (fees * BigInt(REPAY_SPLIT.creditRepayBps)) / D;
        if (repayShare > outstanding) {
          // crossover batch: repay exactly the remainder, the excess of the 80% flows to the flywheel legs.
          sawCrossover = true;
          assert.equal(s.creditRepay, outstanding);
          assert.equal(s.creditOutstandingAfter, 0n);
          const overflow = repayShare - outstanding;
          assert.equal(s.holders, (overflow * BigInt(FLYWHEEL_SPLIT.holderPayoutBps)) / D);
        }
        repaidTotal += s.creditRepay;
        outstanding = s.creditOutstandingAfter;
        steps++;
      }
      assert.equal(outstanding, 0n, "credit should be fully repaid");
      assert.equal(repaidTotal, initial, "total repaid == credit line, never more");
      const after = splitFees(10_000n, outstanding);
      assert.equal(after.creditRepay, 0n);
      assert.equal(after.holders, 5_000n);
      void sawCrossover;
    }, 300);
  });

  test("boundary: outstanding = 1 atom vs 0", () => {
    const one = splitFees(1_000n, 1n);
    assert.equal(one.creditRepay, 1n);
    assert.equal(one.platformOps, 200n);
    assert.equal(one.creditOutstandingAfter, 0n);
    assert.equal(sumSplit(one), 1_000n);
    const zero = splitFees(1_000n, 0n);
    assert.deepEqual([zero.creditRepay, zero.platformOps, zero.holders, zero.platformBuybackBurn, zero.treasury], [0n, 0n, 500n, 350n, 150n]);
  });

  test("credit line: within tier bounds, capped by pool and per-launch max; out-of-range bps throws", () => {
    forAll("credit-line", (r) => {
      const raised = r.logBig(15);
      const bps = r.int(1_000, 1_500);
      const pool = r.logBig(15);
      const max = r.logBig(15);
      const c = computeCreditLine(raised, bps, pool, max);
      assert.ok(c <= (raised * 1_500n) / D && c <= pool && c <= max);
    });
    assert.throws(() => computeCreditLine(100n, 999, 1n, 1n), RangeError);
    assert.throws(() => computeCreditLine(100n, 1_501, 1n, 1n), RangeError);
  });

  test("drips: the vault drains to exactly 0 across dripCount drips, never overdrawn", () => {
    forAll("drips", (r) => {
      const initial = r.logBig(15);
      const count = r.int(1, 96);
      let bal = initial;
      for (let i = 0; i < count; i++) {
        const d = dripAmount(initial, count, i, bal);
        assert.ok(d >= 0n && d <= bal, jsonBig({ initial, count, i, bal, d }));
        bal -= d;
      }
      assert.equal(bal, 0n);
    });
  });
});
