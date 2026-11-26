import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeClearing, settleBid, NUM_PRICE_TICKS, TOKEN_UNIT, type ClearingInput, type ClearingResult } from "@sealed/shared";
import { forAll, jsonBig, Rng } from "../lib/rng.ts";

interface Bid {
  tick: number;
  bidAmount: bigint;
  deposit: bigint;
}

interface Scenario {
  cfg: Omit<ClearingInput, "buckets">;
  bids: Bid[];
}

/** Random but *valid* launch config: clearingCap ≥ floor value of the whole sale (as the program must enforce). */
function genScenario(r: Rng): Scenario {
  const numTicks = r.bool(0.7) ? NUM_PRICE_TICKS : r.int(1, NUM_PRICE_TICKS);
  const floorPrice = r.logBig(9) + 1n; // quote atoms per whole token
  const tickSize = r.bool(0.1) ? 1n : r.big(1n, floorPrice);
  const tokensForSale = r.big(1n, 10n ** BigInt(r.int(0, 9))) * TOKEN_UNIT + r.big(0n, TOKEN_UNIT - 1n);
  const floorValue = (floorPrice * tokensForSale) / TOKEN_UNIT;
  const capMult = r.pick([1n, 2n, 3n, 5n, 10n, 1000n]);
  const clearingCap = floorValue * capMult + r.big(0n, floorValue + 1n) + 1n;
  const nBids = r.pick([0, 1, 2, 3, 5, 10, 40, 150]);
  const maxBid = clearingCap * 2n + 1n;
  const bids: Bid[] = [];
  for (let i = 0; i < nBids; i++) {
    const tick = r.bool(0.3) ? r.int(0, Math.min(3, numTicks - 1)) : r.int(0, numTicks - 1);
    const bidAmount = r.bool(0.1) ? r.big(1n, 1000n) : r.big(1n, maxBid / BigInt(Math.max(1, Math.floor(nBids / 3))) + 1n);
    const deposit = bidAmount + (r.bool(0.5) ? 0n : r.big(0n, bidAmount)); // padded collateral ≥ bidAmount
    bids.push({ tick, bidAmount, deposit });
  }
  return { cfg: { floorPrice, tickSize, numTicks, tokensForSale, clearingCap }, bids };
}

function buckets(numTicks: number, bids: Bid[]): bigint[] {
  const b = Array.from({ length: numTicks }, () => 0n);
  for (const x of bids) b[x.tick] = b[x.tick]! + x.bidAmount;
  return b;
}

function run(s: Scenario) {
  const res = computeClearing({ ...s.cfg, buckets: buckets(s.cfg.numTicks, s.bids) });
  const settles = s.bids.map((b) => ({ b, st: settleBid(res, s.cfg.floorPrice, s.cfg.tickSize, b.tick, b.bidAmount, b.deposit) }));
  return { res, settles };
}

/** Compact scenario dump for counterexamples: config + non-zero buckets. */
const dump = (s: Scenario) => jsonBig({ ...s.cfg, buckets: Object.fromEntries(buckets(s.cfg.numTicks, s.bids).map((b, i) => [i, b]).filter(([, b]) => b !== 0n)) });

const price = (cfg: Scenario["cfg"], tick: number) => cfg.floorPrice + cfg.tickSize * BigInt(tick);

describe("clearing invariants (computeClearing + settleBid)", () => {
  test("every winner pays the same uniform clearing price, never above their own max price", () => {
    forAll("uniform-price", (r) => {
      const s = genScenario(r);
      const { res, settles } = run(s);
      for (const { b, st } of settles) {
        if (!st.won) continue;
        assert.ok(price(s.cfg, b.tick) >= res.clearingPrice, `winner max ${price(s.cfg, b.tick)} < P ${res.clearingPrice}`);
        // tokens are exactly spent / P (rounded down): the effective price is P for everyone.
        assert.equal(st.tokens, (st.spent * TOKEN_UNIT) / res.clearingPrice, jsonBig({ b, st, res }));
        // implied price lies in [P, P + P/tokens) — i.e. no winner gets a better or worse rate beyond 1-atom rounding.
        if (st.tokens > 0n) {
          assert.ok(st.spent * TOKEN_UNIT >= res.clearingPrice * st.tokens);
          assert.ok(st.spent * TOKEN_UNIT < res.clearingPrice * (st.tokens + 1n));
        }
      }
    });
  });

  test("Σspent ≤ clearingCap and Σspent ≤ result.totalRaised", () => {
    forAll("cap", (r) => {
      const s = genScenario(r);
      const { res, settles } = run(s);
      const sum = settles.reduce((a, x) => a + x.st.spent, 0n);
      assert.ok(sum <= s.cfg.clearingCap, `Σspent ${sum} > cap ${s.cfg.clearingCap} ${jsonBig(res)} scenario=${dump(s)}`);
      assert.ok(sum <= res.totalRaised, `Σspent ${sum} > totalRaised ${res.totalRaised}`);
      assert.ok(res.totalRaised <= s.cfg.clearingCap);
    });
  });

  test("Σtokens ≤ tokensForSale (and ≤ result.tokensSold)", () => {
    forAll("supply", (r) => {
      const s = genScenario(r);
      const { res, settles } = run(s);
      const sum = settles.reduce((a, x) => a + x.st.tokens, 0n);
      assert.ok(sum <= s.cfg.tokensForSale, `Σtokens ${sum} > S ${s.cfg.tokensForSale} ${jsonBig(res)} scenario=${dump(s)}`);
      assert.ok(sum <= res.tokensSold, `Σtokens ${sum} > tokensSold ${res.tokensSold}`);
      assert.ok(res.tokensSold <= s.cfg.tokensForSale);
    });
  });

  test("refund + spent == deposit, 0 ≤ spent ≤ bidAmount, refund ≥ 0", () => {
    forAll("conservation", (r) => {
      const s = genScenario(r);
      for (const { b, st } of run(s).settles) {
        assert.equal(st.refund + st.spent, b.deposit);
        assert.ok(st.spent >= 0n && st.spent <= b.bidAmount, jsonBig({ b, st }));
        assert.ok(st.refund >= 0n);
        assert.equal(st.won, st.spent > 0n);
      }
    });
  });

  test("no bid priced below the clearing price wins anything", () => {
    forAll("losers", (r) => {
      const s = genScenario(r);
      const { res, settles } = run(s);
      for (const { b, st } of settles) {
        if (price(s.cfg, b.tick) < res.clearingPrice) {
          assert.equal(st.spent, 0n);
          assert.equal(st.tokens, 0n);
          assert.equal(st.refund, b.deposit);
        }
      }
    });
  });

  test("bids strictly above P fill fully unless the hard cap pro-rates everyone", () => {
    forAll("full-above", (r) => {
      const s = genScenario(r);
      const { res, settles } = run(s);
      if (res.rule !== "full_above") return;
      for (const { b, st } of settles) if (price(s.cfg, b.tick) > res.clearingPrice) assert.equal(st.spent, b.bidAmount);
    });
  });

  test("clearing price is on/above floor and ≤ the highest bid tick (when bids exist)", () => {
    forAll("price-bounds", (r) => {
      const s = genScenario(r);
      const { res } = run(s);
      assert.ok(res.clearingPrice >= s.cfg.floorPrice);
      if (s.bids.length > 0) {
        const top = Math.max(...s.bids.map((b) => b.tick));
        assert.ok(res.clearingPrice <= price(s.cfg, top), `P ${res.clearingPrice} > top bid ${price(s.cfg, top)}`);
      }
      assert.ok(res.fillDen > 0n);
      assert.ok(res.fillNum >= 0n && res.fillNum <= res.fillDen, jsonBig(res));
    });
  });

  test("monotonic: adding a higher bid never lowers the clearing price", () => {
    forAll("monotonic-higher", (r) => {
      const s = genScenario(r);
      const before = run(s).res;
      const topTick = s.bids.length ? Math.max(...s.bids.map((b) => b.tick)) : 0;
      const tick = r.int(topTick, s.cfg.numTicks - 1);
      const extra = { tick, bidAmount: r.big(1n, s.cfg.clearingCap * 2n), deposit: 0n };
      extra.deposit = extra.bidAmount;
      const after = run({ ...s, bids: [...s.bids, extra] }).res;
      assert.ok(after.clearingPrice >= before.clearingPrice, `P dropped ${before.clearingPrice} → ${after.clearingPrice} adding ${jsonBig(extra)} scenario=${dump(s)}`);
    });
  });

  test("monotonic (stronger): adding a bid at ANY tick never lowers the clearing price", () => {
    forAll("monotonic-any", (r) => {
      const s = genScenario(r);
      const before = run(s).res;
      const extra = { tick: r.int(0, s.cfg.numTicks - 1), bidAmount: r.big(1n, s.cfg.clearingCap), deposit: 0n };
      extra.deposit = extra.bidAmount;
      const after = run({ ...s, bids: [...s.bids, extra] }).res;
      assert.ok(after.clearingPrice >= before.clearingPrice, `P dropped ${before.clearingPrice} → ${after.clearingPrice} adding ${jsonBig(extra)} scenario=${dump(s)}`);
    });
  });

  test("bid order / splitting a bucket does not change the result (histogram-only)", () => {
    forAll("permutation", (r) => {
      const s = genScenario(r);
      const a = run(s).res;
      const shuffled = [...s.bids].sort(() => r.next() - 0.5);
      const b = run({ ...s, bids: shuffled }).res;
      assert.deepEqual(a, b);
    }, 100);
  });

  test("empty auction: no fills, price = floor", () => {
    const res = computeClearing({ floorPrice: 100n, tickSize: 10n, numTicks: 64, tokensForSale: 1000n * TOKEN_UNIT, clearingCap: 1_000_000n, buckets: Array(64).fill(0n) });
    assert.equal(res.clearingPrice, 100n);
    assert.equal(res.marginalTick, -1);
    assert.equal(settleBid(res, 100n, 10n, 5, 0n, 50n).refund, 50n);
  });

  test("KNOWN EDGE (config validation): clearingCap below floor value lets Σspent exceed the cap", () => {
    // Documents why create_launch / CreateLaunchInputSchema must enforce clearingCap ≥ floorPrice × tokensForSale.
    const res: ClearingResult = computeClearing({ floorPrice: 100n, tickSize: 10n, numTicks: 64, tokensForSale: 1000n * TOKEN_UNIT, clearingCap: 50_000n, buckets: [200_000n, ...Array(63).fill(0n)] });
    const st = settleBid(res, 100n, 10n, 0, 200_000n, 200_000n);
    assert.equal(res.clearingPrice, 100n); // Pc clamped up to the floor
    assert.ok(st.spent > 50_000n, "if this starts failing, computeClearing now enforces the cap even below floor — update the report");
  });
});
