import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CreateLaunchInputSchema, MAX_CREATOR_ALLOCATION_BPS, DemoBidInputSchema, ListLaunchesQuerySchema } from "@sealed/shared";
import { forAll } from "../lib/rng.ts";

export const validLaunch = {
  name: "Invariant Test",
  ticker: "INVT",
  description: "qa",
  quoteAsset: "SOL",
  creatorAllocationBps: 150,
  floorPrice: 0.0001,
  tickSize: 0.000005,
  targetRaise: 500,
  clearingCap: 750,
} as const;

describe("CreateLaunchInputSchema — creator cap ≤ 2%", () => {
  test("MAX_CREATOR_ALLOCATION_BPS is 200 (2%)", () => assert.equal(MAX_CREATOR_ALLOCATION_BPS, 200));

  test("accepts every integer 0..200 bps", () => {
    for (let bps = 0; bps <= 200; bps++) assert.ok(CreateLaunchInputSchema.safeParse({ ...validLaunch, creatorAllocationBps: bps }).success, `rejected ${bps}`);
  });

  test("rejects anything > 200 bps (random 201..10000), negatives and fractions", () => {
    forAll("cap", (r) => {
      const bps = r.int(201, 10_000);
      const res = CreateLaunchInputSchema.safeParse({ ...validLaunch, creatorAllocationBps: bps });
      assert.equal(res.success, false, `accepted ${bps}`);
    });
    for (const bad of [201, 250, -1, 150.5, Number.NaN, "100"]) assert.equal(CreateLaunchInputSchema.safeParse({ ...validLaunch, creatorAllocationBps: bad }).success, false, `accepted ${String(bad)}`);
  });

  test("applies documented defaults", () => {
    const p = CreateLaunchInputSchema.parse(validLaunch);
    assert.equal(p.totalSupply, 1_000_000_000);
    assert.equal(p.creditTier, "standard");
    assert.equal(p.auctionSupplyBps, 4_000);
  });

  test("other guards: ticker format, commit duration bounds", () => {
    assert.equal(CreateLaunchInputSchema.safeParse({ ...validLaunch, ticker: "lower" }).success, false);
    assert.equal(CreateLaunchInputSchema.safeParse({ ...validLaunch, commitDurationSec: 60 }).success, false);
    assert.equal(CreateLaunchInputSchema.safeParse({ ...validLaunch, commitDurationSec: 31 * 60 }).success, false);
  });

  test("demo bid requires a 32-byte hex commitment; list query accepts tab aliases", () => {
    assert.equal(DemoBidInputSchema.safeParse({ commitment: "ab".repeat(32), deposit: 1 }).success, true);
    assert.equal(DemoBidInputSchema.safeParse({ commitment: "ab".repeat(31), deposit: 1 }).success, false);
    for (const s of ["auctions", "vaults", "graduated", "commit", "live"]) assert.ok(ListLaunchesQuerySchema.safeParse({ status: s }).success);
  });
});
