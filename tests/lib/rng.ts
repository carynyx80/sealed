/**
 * Tiny seeded PRNG for property tests (no extra deps). Override the base seed with
 * INVARIANT_SEED=<int> and the iteration count with INVARIANT_RUNS=<int> to reproduce / soak.
 */
export const BASE_SEED = Number(process.env.INVARIANT_SEED ?? 20261126);
export const RUNS = Number(process.env.INVARIANT_RUNS ?? 400);

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  /** mulberry32 → [0, 1) */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  /** Uniform-ish bigint in [a, b] (inclusive) built from 2×32-bit draws. */
  big(a: bigint, b: bigint): bigint {
    if (b <= a) return a;
    const span = b - a + 1n;
    const hi = BigInt(Math.floor(this.next() * 2 ** 32));
    const lo = BigInt(Math.floor(this.next() * 2 ** 32));
    return a + ((hi << 32n) | lo) % span;
  }
  /** Log-uniform bigint in [1, 10^maxExp] — exercises tiny and huge magnitudes. */
  logBig(maxExp: number): bigint {
    const e = this.int(0, maxExp);
    return this.big(1n, 10n ** BigInt(e));
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.int(0, 255);
    return out;
  }
}

/** Runs `fn` RUNS times with independent, reproducible seeds; failures report the seed. */
export function forAll(name: string, fn: (r: Rng, iter: number) => void, runs = RUNS): void {
  for (let i = 0; i < runs; i++) {
    const seed = (BASE_SEED + i * 7919) >>> 0;
    try {
      fn(new Rng(seed), i);
    } catch (e) {
      const err = e as Error;
      err.message = `[${name}] counterexample at iter=${i} seed=${seed} (INVARIANT_SEED=${BASE_SEED}): ${err.message}`;
      throw err;
    }
  }
}

export const jsonBig = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Minimal base58 encoder (bitcoin alphabet) so tests don't need a direct web3.js dependency. */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}
