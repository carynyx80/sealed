import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { commitmentPreimage, computeCommitment, toHex, fromHex, u64le, tickIndex, tickPrice } from "@sealed/shared";
import { base58, forAll } from "../lib/rng.ts";

const readU64 = (b: Uint8Array, off: number) => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]!);
  return v;
};

describe("commitment invariants", () => {
  test("preimage is exactly 80 bytes: bidder(32) | maxPrice u64 LE | bidAmount u64 LE | salt(32)", () => {
    forAll("layout", (r) => {
      const bidderBytes = r.bytes(32);
      const bidder = base58(bidderBytes);
      const maxPrice = r.big(0n, 0xffff_ffff_ffff_ffffn);
      const bidAmount = r.big(0n, 0xffff_ffff_ffff_ffffn);
      const salt = r.bytes(32);
      const pre = commitmentPreimage({ bidder, maxPrice, bidAmount, salt });
      assert.equal(pre.length, 80);
      assert.deepEqual(pre.slice(0, 32), bidderBytes);
      assert.equal(readU64(pre, 32), maxPrice);
      assert.equal(readU64(pre, 40), bidAmount);
      assert.deepEqual(pre.slice(48, 80), salt);
      assert.equal(computeCommitment({ bidder, maxPrice, bidAmount, salt }).length, 32);
    });
  });

  test("distinct salts → distinct commitments (same bidder/price/amount)", () => {
    const seen = new Set<string>();
    forAll("salts", (r) => {
      const c = toHex(computeCommitment({ bidder: "11111111111111111111111111111111", maxPrice: 150n, bidAmount: 5_000n, salt: r.bytes(32) }));
      assert.ok(!seen.has(c), "collision");
      seen.add(c);
    }, 2000);
  });

  test("any single-field change changes the commitment (binding)", () => {
    forAll("binding", (r) => {
      const p = { bidder: base58(r.bytes(32)), maxPrice: r.big(1n, 10n ** 12n), bidAmount: r.big(1n, 10n ** 12n), salt: r.bytes(32) };
      const c = toHex(computeCommitment(p));
      const salt2 = p.salt.slice();
      salt2[r.int(0, 31)] ^= 1 << r.int(0, 7);
      const variants = [
        { ...p, maxPrice: p.maxPrice + 1n },
        { ...p, bidAmount: p.bidAmount + 1n },
        { ...p, salt: salt2 },
        { ...p, bidder: base58(r.bytes(32)) },
      ];
      for (const v of variants) assert.notEqual(toHex(computeCommitment(v)), c);
    });
  });

  test("u64le range checks and hex round-trip", () => {
    assert.throws(() => u64le(-1n), RangeError);
    assert.throws(() => u64le(1n << 64n), RangeError);
    assert.throws(() => commitmentPreimage({ bidder: "11111111111111111111111111111111", maxPrice: 1n, bidAmount: 1n, salt: new Uint8Array(31) }));
    forAll("hex", (r) => {
      const b = r.bytes(r.int(0, 64));
      assert.deepEqual(fromHex(toHex(b)), b);
    }, 200);
  });

  test("tick grid: tickIndex inverts tickPrice and rejects off-grid prices", () => {
    forAll("ticks", (r) => {
      const floor = r.big(1n, 10n ** 9n);
      const tick = r.big(1n, 10n ** 6n);
      const n = r.int(1, 64);
      const i = r.int(0, n - 1);
      assert.equal(tickIndex(floor, tick, tickPrice(floor, tick, i), n), i);
      assert.equal(tickIndex(floor, tick, tickPrice(floor, tick, n), n), -1);
      if (tick > 1n) assert.equal(tickIndex(floor, tick, tickPrice(floor, tick, i) + 1n, n), -1);
      assert.equal(tickIndex(floor, tick, floor - 1n, n), -1);
    });
  });
});
