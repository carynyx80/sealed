import { PublicKey } from "@solana/web3.js";
import {
  NUM_PRICE_TICKS,
  computeCommitment,
  fromHex,
  randomSalt,
  revealSignMessage,
  sealReveal,
  tickIndex,
  tickPrice,
  toHex,
  type RevealPlaintext,
  type SealedRevealEnvelope,
} from "@sealed/shared";
import { atomsToUi, uiToAtoms } from "./cpmm.js";

/**
 * Sealed-bid preparation: tick selection, keccak commitment (shared commitment.ts), and the auto-reveal envelope
 * (shared relayer.ts sealReveal). All on-chain values are bigint atoms; prices are quote atoms per whole token.
 */

export interface TickGrid {
  floorPrice: bigint;
  tickSize: bigint;
  numTicks?: number;
}

export function priceTicks(g: TickGrid): bigint[] {
  const n = g.numTicks ?? NUM_PRICE_TICKS;
  return Array.from({ length: n }, (_, i) => tickPrice(g.floorPrice, g.tickSize, i));
}

/** UI-number tick ladder from a DTO auction (floorPrice/tickSize are quote UI units per whole token). */
export function priceTicksUi(auction: { floorPrice: number; tickSize: number }, quoteDecimals: number, numTicks = NUM_PRICE_TICKS): number[] {
  const g = gridFromUi(auction, quoteDecimals, numTicks);
  return priceTicks(g).map((p) => atomsToUi(p, quoteDecimals));
}

export function gridFromUi(auction: { floorPrice: number; tickSize: number }, quoteDecimals: number, numTicks = NUM_PRICE_TICKS): TickGrid {
  return { floorPrice: uiToAtoms(auction.floorPrice, quoteDecimals), tickSize: uiToAtoms(auction.tickSize, quoteDecimals), numTicks };
}

/** Snap a desired max price DOWN to the tick grid (clamped to [floor, top tick]). */
export function pickTick(g: TickGrid, desiredMaxPrice: bigint): { index: number; price: bigint } {
  const n = g.numTicks ?? NUM_PRICE_TICKS;
  if (g.tickSize <= 0n) throw new Error("tickSize must be > 0");
  if (desiredMaxPrice <= g.floorPrice) return { index: 0, price: g.floorPrice };
  let i = Number((desiredMaxPrice - g.floorPrice) / g.tickSize);
  if (i > n - 1) i = n - 1;
  return { index: i, price: tickPrice(g.floorPrice, g.tickSize, i) };
}

export interface PrepareSealedBidArgs {
  bidder: PublicKey | string;
  grid: TickGrid;
  /** Desired max price (atoms); snapped down to the grid unless `exactTick` is set, which requires an on-grid price. */
  maxPrice: bigint;
  bidAmount: bigint;
  deposit: bigint;
  salt?: Uint8Array;
  exactTick?: boolean;
}

export interface PreparedSealedBid {
  bidder: string;
  maxPrice: bigint;
  bidAmount: bigint;
  deposit: bigint;
  tick: number;
  salt: Uint8Array;
  saltHex: string;
  commitment: Uint8Array;
  commitmentHex: string;
  /** Payload sealed to the relayer for auto-reveal. */
  plaintext: RevealPlaintext;
}

export function prepareSealedBid(a: PrepareSealedBidArgs): PreparedSealedBid {
  const n = a.grid.numTicks ?? NUM_PRICE_TICKS;
  let tick: number;
  let maxPrice: bigint;
  if (a.exactTick) {
    tick = tickIndex(a.grid.floorPrice, a.grid.tickSize, a.maxPrice, n);
    if (tick < 0) throw new Error("maxPrice is not a valid tick");
    maxPrice = a.maxPrice;
  } else {
    const t = pickTick(a.grid, a.maxPrice);
    tick = t.index;
    maxPrice = t.price;
  }
  if (a.bidAmount <= 0n) throw new Error("bidAmount must be > 0");
  if (a.bidAmount > a.deposit) throw new Error("bidAmount exceeds deposit (BidExceedsDeposit)");
  const salt = a.salt ?? randomSalt();
  if (salt.length !== 32) throw new Error("salt must be 32 bytes");
  const bidder = typeof a.bidder === "string" ? a.bidder : a.bidder.toBase58();
  const commitment = computeCommitment({ bidder, maxPrice, bidAmount: a.bidAmount, salt });
  const saltHex = toHex(salt);
  return {
    bidder,
    maxPrice,
    bidAmount: a.bidAmount,
    deposit: a.deposit,
    tick,
    salt,
    saltHex,
    commitment,
    commitmentHex: toHex(commitment),
    plaintext: { maxPrice: maxPrice.toString(), bidAmount: a.bidAmount.toString(), salt: saltHex },
  };
}

/** Re-verify a stored preimage before revealing (guards against corrupted local storage). */
export function verifyPreimage(p: { bidder: string; maxPrice: bigint | string; bidAmount: bigint | string; saltHex: string; commitmentHex: string }): boolean {
  const c = computeCommitment({ bidder: p.bidder, maxPrice: BigInt(p.maxPrice), bidAmount: BigInt(p.bidAmount), salt: fromHex(p.saltHex) });
  return toHex(c) === p.commitmentHex.toLowerCase();
}

export interface AutoRevealArgs {
  launchId: string;
  prepared: PreparedSealedBid;
  relayerPubkeyB64: string;
  /** wallet-adapter signMessage. */
  signMessage: (msg: Uint8Array) => Promise<Uint8Array>;
}

/** Sign `revealSignMessage(launchId, commitment)` with the wallet and seal the preimage to the relayer. */
export async function buildAutoRevealEnvelope(a: AutoRevealArgs): Promise<SealedRevealEnvelope> {
  const signature = await a.signMessage(revealSignMessage(a.launchId, a.prepared.commitmentHex));
  return sealReveal({
    launchId: a.launchId,
    bidder: a.prepared.bidder,
    commitmentHex: a.prepared.commitmentHex,
    relayerPubkeyB64: a.relayerPubkeyB64,
    plaintext: a.prepared.plaintext,
    signature,
  });
}
