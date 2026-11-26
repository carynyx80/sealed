import { test } from "node:test";
import assert from "node:assert/strict";
import { computeClearing, settleBid } from "../clearing.js";
import { computeCommitment, toHex } from "../commitment.js";
import { splitFees } from "../fees.js";
import { createDemoWorld, tickDemoWorld, demoStats } from "../demo.js";

const U = 1_000_000n;
const base = { floorPrice: 100n, tickSize: 10n, numTicks: 64, tokensForSale: 1_000n * U, clearingCap: 10_000_000n };
const hist = (m: Record<number, bigint>) => Array.from({ length: 64 }, (_, i) => m[i] ?? 0n);

test("commitment vector is stable", () => {
  const c = computeCommitment({ bidder: "11111111111111111111111111111111", maxPrice: 150n, bidAmount: 5000n, salt: new Uint8Array(32).fill(7) });
  assert.equal(c.length, 32);
  console.log("COMMITMENT_VECTOR", toHex(c));
});

test("oversubscribed: marginal tick pro-rated", () => {
  // tick 5 (150) budget 100_000, tick 2 (120) budget 100_000. S=1000 tokens.
  const r = computeClearing({ ...base, buckets: hist({ 5: 100_000n, 2: 100_000n }) });
  // Band k=5: c=min(150, 100_000/1000=100) =100 ≤ p4 → infeasible. k=2: cum 200_000 → min(120,200)=120 > p1 → P=120
  assert.equal(r.clearingPrice, 120n);
  assert.equal(r.marginalTick, 2);
  const hi = settleBid(r, 100n, 10n, 5, 100_000n, 100_000n);
  assert.equal(hi.spent, 100_000n);
  const lo = settleBid(r, 100n, 10n, 2, 100_000n, 120_000n);
  assert.equal(lo.spent, 20_000n); // value=120*1000=120_000 - 100_000 above
  assert.equal(lo.refund, 100_000n);
  console.log("VECTOR_A", JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
});

test("undersubscribed clears at floor, full fills", () => {
  const r = computeClearing({ ...base, buckets: hist({ 3: 10_000n }) });
  assert.equal(r.clearingPrice, 100n);
  assert.equal(r.undersubscribed, true);
  assert.equal(settleBid(r, 100n, 10n, 3, 10_000n, 10_000n).tokens, 100n * U);
});

test("between ticks: P = B/S", () => {
  const r = computeClearing({ ...base, buckets: hist({ 10: 125_000n }) });
  assert.equal(r.clearingPrice, 125n);
  assert.equal(settleBid(r, 100n, 10n, 10, 125_000n, 125_000n).tokens, 1000n * U);
});

test("hard cap pro-rates all", () => {
  const r = computeClearing({ ...base, clearingCap: 150_000n, buckets: hist({ 20: 300_000n, 15: 100_000n }) });
  assert.equal(r.rule, "pro_rata_all");
  assert.equal(r.clearingPrice, 150n);
  assert.equal(r.fillNum, 150_000n);
  assert.equal(r.fillDen, 400_000n);
});

test("fee split phases", () => {
  const a = splitFees(1000n, 10_000n);
  assert.deepEqual([a.creditRepay, a.platformOps, a.holders], [800n, 200n, 0n]);
  const b = splitFees(1000n, 300n);
  assert.equal(b.creditRepay, 300n);
  assert.equal(b.holders, 250n); // 500 overflow * 50%
  const c = splitFees(1000n, 0n);
  assert.deepEqual([c.holders, c.platformBuybackBurn, c.treasury], [500n, 350n, 150n]);
});

test("demo world ticks", () => {
  const now = 1_800_000_000;
  const w = createDemoWorld(now);
  assert.ok(w.launches.length >= 10);
  let evs = 0;
  for (let t = 1; t <= 400; t++) evs += tickDemoWorld(w, now + t).length;
  assert.ok(evs > 10);
  assert.ok(demoStats(w, now).totalVolumeUsd > 0);
});
