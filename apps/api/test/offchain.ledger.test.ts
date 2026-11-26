import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { Ledger, LedgerError, acct, fromAtoms, move, toAtoms } from "../src/offchain/ledger.js";
import { MemoryRepo } from "../src/offchain/repo/memory.js";

const wallets = Array.from({ length: 6 }, () => Keypair.generate().publicKey.toBase58());
const ASSETS = ["USDC", "SOL"] as const;

// Deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

async function expectCode(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof LedgerError && e.code === code);
}

describe("offchain ledger invariants", () => {
  it("random op fuzz keeps Σ=0 per tx, stored balances = Σ entries, no negative user balances", async () => {
    const repo = new MemoryRepo();
    const ledger = new Ledger(repo);
    const r = rng(42);
    const model = new Map<string, bigint>(); // `${wallet}|${asset}|available|locked`
    const k = (w: string, a: string, kind: string) => `${w}|${a}|${kind}`;
    const get = (key: string) => model.get(key) ?? 0n;
    let rejected = 0;
    let custody = new Map<string, bigint>();
    for (let i = 0; i < 1500; i++) {
      const w = wallets[Math.floor(r() * wallets.length)]!;
      const w2 = wallets[Math.floor(r() * wallets.length)]!;
      const a = ASSETS[Math.floor(r() * ASSETS.length)]!;
      const amt = BigInt(1 + Math.floor(r() * 5_000_000));
      const op = Math.floor(r() * 6);
      const key = `fuzz:${i}`;
      try {
        if (op === 0) {
          await ledger.credit(w, a, amt, key);
          model.set(k(w, a, "available"), get(k(w, a, "available")) + amt);
          custody.set(a, (custody.get(a) ?? 0n) + amt);
        } else if (op === 1) {
          await ledger.debitForWithdrawal(w, a, amt, key);
          model.set(k(w, a, "available"), get(k(w, a, "available")) - amt);
          model.set(k(w, a, "locked"), get(k(w, a, "locked")) + amt);
        } else if (op === 2) {
          await ledger.unlock(w, a, amt, key);
          model.set(k(w, a, "locked"), get(k(w, a, "locked")) - amt);
          model.set(k(w, a, "available"), get(k(w, a, "available")) + amt);
        } else if (op === 3) {
          await ledger.settleWithdrawal(w, a, amt, key);
          model.set(k(w, a, "locked"), get(k(w, a, "locked")) - amt);
          custody.set(a, (custody.get(a) ?? 0n) - amt);
        } else if (op === 4) {
          await ledger.post({ idempotencyKey: key, kind: "p2p", legs: move(acct.available(w, a), acct.available(w2, a), amt) });
          model.set(k(w, a, "available"), get(k(w, a, "available")) - amt);
          model.set(k(w2, a, "available"), get(k(w2, a, "available")) + amt);
        } else {
          // replay an earlier key: must be a no-op (or a conflict if the content differs)
          const j = Math.floor(r() * Math.max(1, i));
          await ledger.credit(w, a, amt, `fuzz:${j}`).then(
            (res) => {
              if (res.replayed) return;
              // the original op under that key had failed → this credit is genuinely new
              model.set(k(w, a, "available"), get(k(w, a, "available")) + amt);
              custody.set(a, (custody.get(a) ?? 0n) + amt);
            },
            (e: unknown) => assert.ok(e instanceof LedgerError && e.code === "IDEMPOTENCY_CONFLICT"),
          );
        }
      } catch (e) {
        assert.ok(e instanceof LedgerError && e.code === "INSUFFICIENT_FUNDS", String(e));
        rejected++;
      }
    }
    assert.ok(rejected > 50, "fuzz should exercise insufficient-funds rejections");
    const report = await ledger.verify();
    assert.deepEqual(report, { ok: true, unbalancedTxs: [], balanceMismatches: [], negativeBalances: [] });
    for (const w of wallets) {
      const bals = await ledger.balances(w);
      for (const a of ASSETS) {
        const b = bals.find((x) => x.asset === a);
        assert.equal(b?.available ?? 0n, get(k(w, a, "available")), `${w} ${a} available`);
        assert.equal(b?.locked ?? 0n, get(k(w, a, "locked")), `${w} ${a} locked`);
        assert.ok((b?.available ?? 0n) >= 0n && (b?.locked ?? 0n) >= 0n);
      }
    }
    for (const a of ASSETS) assert.equal(await ledger.liabilities(a), custody.get(a) ?? 0n);
  });

  it("idempotency: replay is a no-op, different content conflicts", async () => {
    const ledger = new Ledger(new MemoryRepo());
    const w = wallets[0]!;
    const r1 = await ledger.credit(w, "USDC", 1_000n, "dep:sig1:0");
    const r2 = await ledger.credit(w, "USDC", 1_000n, "dep:sig1:0");
    assert.equal(r1.replayed, false);
    assert.equal(r2.replayed, true);
    assert.equal(r2.txId, r1.txId);
    assert.equal((await ledger.balances(w))[0]!.available, 1_000n);
    await expectCode(ledger.credit(w, "USDC", 999n, "dep:sig1:0"), "IDEMPOTENCY_CONFLICT");
  });

  it("rejects unbalanced, non-bigint and negative-user postings atomically", async () => {
    const ledger = new Ledger(new MemoryRepo());
    const w = wallets[1]!;
    await ledger.credit(w, "SOL", 10n, "c1");
    await expectCode(ledger.post({ idempotencyKey: "u1", kind: "x", legs: [{ account: acct.available(w, "SOL"), amount: -5n }, { account: acct.system("treasury", "SOL"), amount: 4n }] }), "UNBALANCED");
    await expectCode(ledger.post({ idempotencyKey: "u2", kind: "x", legs: move(acct.available(w, "SOL"), acct.system("treasury", "SOL"), 11n) }), "INSUFFICIENT_FUNDS");
    await expectCode(ledger.credit(w, "SOL", 0n, "c0"), "INVALID");
    // a failed multi-leg tx leaves nothing behind
    await expectCode(
      ledger.post({ idempotencyKey: "u3", kind: "x", legs: [...move(acct.available(w, "SOL"), acct.system("treasury", "SOL"), 5n), ...move(acct.system("burned", "SOL"), acct.available(w, "SOL"), 1n)] }),
      "INSUFFICIENT_FUNDS",
    );
    assert.equal(await ledger.balanceOf(w, "SOL", "user_available"), 10n);
    assert.equal(await ledger.balanceOf("system", "SOL", "treasury"), 0n);
    assert.equal((await ledger.verify()).ok, true);
  });

  it("concurrent debits never overdraw (serialized transactions)", async () => {
    const ledger = new Ledger(new MemoryRepo());
    const w = wallets[2]!;
    await ledger.credit(w, "USDC", 20n * 1_000_000n, "seed");
    const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => ledger.debitForWithdrawal(w, "USDC", 1_000_000n, `wd:${i}`)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 20);
    const b = (await ledger.balances(w))[0]!;
    assert.equal(b.available, 0n);
    assert.equal(b.locked, 20_000_000n);
    assert.equal((await ledger.verify()).ok, true);
  });

  it("unit conversion truncates, never rounds up", () => {
    assert.equal(toAtoms(0.000005, 6), 5n);
    assert.equal(toAtoms(1.23456789, 6), 1_234_567n);
    assert.equal(toAtoms(0.1 + 0.2, 6), 300_000n);
    assert.equal(fromAtoms(1_500_000n, 6), 1.5);
    assert.throws(() => toAtoms(-1, 6));
    assert.throws(() => toAtoms(Number.NaN, 6));
  });
});
