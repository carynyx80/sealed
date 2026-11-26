import { keccak_256 } from "@noble/hashes/sha3";
import { PublicKey } from "@solana/web3.js";

/**
 * Sealed-bid commitment.
 *
 *   commitment = keccak256( bidder(32) || max_price(u64 LE) || bid_amount(u64 LE) || salt(32) )   // 80-byte preimage
 *
 * - max_price: quote atoms per 1 whole token; MUST be a valid tick: floor + i*tick, i < NUM_PRICE_TICKS.
 * - bid_amount: quote atoms the bidder is willing to spend (≤ deposited collateral).
 * - salt: 32 random bytes, kept client-side (and optionally sealed to the relayer).
 *
 * The Rust program recomputes this in `reveal_bid` with `solana_keccak_hasher::hashv` (or equivalent)
 * over exactly these 4 slices. Anyone holding the preimage may submit the reveal (that is how the
 * auto-reveal relayer works); the bidder pubkey inside the hash binds it to the bidder.
 */
export interface BidPreimage {
  bidder: PublicKey | string;
  maxPrice: bigint;
  bidAmount: bigint;
  salt: Uint8Array; // 32 bytes
}

export function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new RangeError("u64 out of range");
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function commitmentPreimage(p: BidPreimage): Uint8Array {
  if (p.salt.length !== 32) throw new Error("salt must be 32 bytes");
  const bidder = typeof p.bidder === "string" ? new PublicKey(p.bidder) : p.bidder;
  const buf = new Uint8Array(80);
  buf.set(bidder.toBytes(), 0);
  buf.set(u64le(p.maxPrice), 32);
  buf.set(u64le(p.bidAmount), 40);
  buf.set(p.salt, 48);
  return buf;
}

export function computeCommitment(p: BidPreimage): Uint8Array {
  return keccak_256(commitmentPreimage(p));
}

export function randomSalt(): Uint8Array {
  const s = new Uint8Array(32);
  globalThis.crypto.getRandomValues(s);
  return s;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(h: string): Uint8Array {
  const clean = h.startsWith("0x") ? h.slice(2) : h;
  if (clean.length % 2) throw new Error("bad hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Price of tick i. */
export function tickPrice(floorPrice: bigint, tickSize: bigint, index: number): bigint {
  return floorPrice + tickSize * BigInt(index);
}

/** Returns tick index or -1 if maxPrice is not on the tick grid. */
export function tickIndex(floorPrice: bigint, tickSize: bigint, maxPrice: bigint, numTicks: number): number {
  if (maxPrice < floorPrice || tickSize <= 0n) return -1;
  const d = maxPrice - floorPrice;
  if (d % tickSize !== 0n) return -1;
  const i = Number(d / tickSize);
  return i < numTicks ? i : -1;
}
