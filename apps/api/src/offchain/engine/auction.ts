import { PublicKey } from "@solana/web3.js";
import {
  SealedRevealEnvelopeSchema,
  computeCommitment,
  fromHex,
  tickIndex,
  toHex,
  verifyRevealSignature,
  type SealedRevealEnvelope,
} from "@sealed/shared";
import { openAndVerify } from "../../workers/revealRelayer.js";
import { acct, fromAtoms, move, postIn, toAtoms, tokenAsset } from "../ledger.js";
import type { BidRow, Json, LaunchRow } from "../repo/types.js";
import { EngineError, invalidate, nowS, publish, type EngineDeps } from "./common.js";
import { newId, quoteDecimals } from "./launches.js";

function commitOpen(d: EngineDeps, l: LaunchRow) {
  return l.status === "commit" && nowS(d) < l.commitEndTs;
}
function revealOpen(d: EngineDeps, l: LaunchRow) {
  const now = nowS(d);
  return (l.status === "commit" || l.status === "reveal") && now >= l.commitEndTs && now < l.revealEndTs;
}

/** Verify an auto-reveal envelope belongs to (launch, wallet, commitment) and decrypts to the committed bid. */
export function checkEnvelope(d: EngineDeps, raw: unknown, launchId: string, wallet: string, commitment: string): SealedRevealEnvelope {
  const p = SealedRevealEnvelopeSchema.safeParse(raw);
  if (!p.success) throw new EngineError(400, "invalid sealedReveal envelope");
  const env = { ...p.data, commitment: p.data.commitment.toLowerCase() };
  if (env.launchId !== launchId || env.bidder !== wallet || env.commitment !== commitment) throw new EngineError(400, "sealedReveal does not match this bid");
  if (env.relayerPubkey !== d.relayerBoxPubB64) throw new EngineError(400, "envelope sealed to a different relayer key", { expected: d.relayerBoxPubB64 });
  let ok = false;
  try {
    ok = verifyRevealSignature(env, new PublicKey(wallet).toBytes());
  } catch {
    ok = false;
  }
  if (!ok) throw new EngineError(401, "invalid sealedReveal signature");
  if (!openAndVerify(env, d.relayerBox.secretKey)) throw new EngineError(400, "sealedReveal does not decrypt to the committed bid");
  return env;
}

export interface CommitInput {
  launchId: string;
  commitment: string;
  deposit: number;
  sealedReveal?: unknown;
}

/** Lock `deposit` quote from available into this wallet's bid escrow and store the commitment hash only. */
export async function commitBid(d: EngineDeps, wallet: string, input: CommitInput): Promise<{ bidId: string; bidCount: number }> {
  const commitment = input.commitment.toLowerCase();
  const pre = await d.repo.read.getLaunch(input.launchId);
  if (!pre) throw new EngineError(404, "launch not found");
  const env = input.sealedReveal !== undefined && input.sealedReveal !== null ? checkEnvelope(d, input.sealedReveal, pre.id, wallet, commitment) : null;
  const depositAtoms = toAtoms(input.deposit, quoteDecimals(pre));
  if (depositAtoms <= 0n) throw new EngineError(400, "deposit too small");

  const res = await d.repo.tx(async (t) => {
    const l = (await t.getLaunch(pre.id, true))!;
    const existing = await t.getBid(l.id, wallet);
    if (existing) {
      if (existing.commitment === commitment && existing.deposit === depositAtoms) return { bidId: existing.id, bidCount: l.bidCount, l, replay: true };
      throw new EngineError(409, "this wallet already has a sealed bid on this launch");
    }
    if (!commitOpen(d, l)) throw new EngineError(409, "commit window closed", { status: l.status });
    await postIn(t, {
      idempotencyKey: `commit:${l.id}:${wallet}`,
      kind: "bid_commit",
      launchId: l.id,
      meta: { wallet },
      legs: move(acct.available(wallet, l.quoteAsset), acct.bidEscrow(wallet, l.quoteAsset, l.id), depositAtoms),
      createdTs: nowS(d),
    });
    const bid: BidRow = {
      id: newId(),
      launchId: l.id,
      bidder: wallet,
      commitment,
      deposit: depositAtoms,
      createdTs: nowS(d),
      revealed: false,
      maxPrice: null,
      bidAmount: null,
      tick: null,
      sealedReveal: env ? (env as unknown as Json) : null,
      autoReveal: env ? "pending" : null,
      settled: false,
      spent: null,
      tokens: null,
      refund: null,
      slash: null,
      claimed: false,
    };
    await t.insertBid(bid);
    const patch = { bidCount: l.bidCount + 1, totalEscrowed: l.totalEscrowed + depositAtoms };
    await t.updateLaunch(l.id, patch);
    return { bidId: bid.id, bidCount: patch.bidCount, l: { ...l, ...patch }, replay: false };
  });
  if (!res.replay) {
    await invalidate(d);
    const qd = quoteDecimals(res.l);
    publish(d, [{ type: "auction.bid_committed", data: { launchId: res.l.id, bidCount: res.l.bidCount, escrowedWallets: res.l.bidCount, totalEscrowed: fromAtoms(res.l.totalEscrowed, qd) } }]);
  }
  return { bidId: res.bidId, bidCount: res.bidCount };
}

export interface RevealInput {
  launchId: string;
  maxPrice: string;
  bidAmount: string;
  salt: string;
}

export async function revealBid(d: EngineDeps, wallet: string, input: RevealInput): Promise<{ revealed: true }> {
  const maxPrice = BigInt(input.maxPrice);
  const bidAmount = BigInt(input.bidAmount);
  const res = await d.repo.tx(async (t) => {
    const l = await t.getLaunch(input.launchId, true);
    if (!l) throw new EngineError(404, "launch not found");
    const bid = await t.getBid(l.id, wallet);
    if (!bid) throw new EngineError(404, "no sealed bid for this wallet");
    if (bid.revealed) return { l, replay: true };
    if (!revealOpen(d, l)) throw new EngineError(409, "reveal window not open", { status: l.status });
    let c: string;
    try {
      c = toHex(computeCommitment({ bidder: wallet, maxPrice, bidAmount, salt: fromHex(input.salt) }));
    } catch {
      throw new EngineError(400, "invalid reveal preimage");
    }
    if (c !== bid.commitment) throw new EngineError(400, "reveal does not match commitment");
    const tick = tickIndex(l.floorPrice, l.tickSize, maxPrice, l.numTicks);
    if (tick < 0) throw new EngineError(400, "maxPrice is not on the tick grid");
    if (bidAmount <= 0n || bidAmount > bid.deposit) throw new EngineError(400, "bidAmount must be > 0 and ≤ deposit");
    await t.updateBid(bid.id, { revealed: true, maxPrice, bidAmount, tick, autoReveal: bid.autoReveal ? "done" : null });
    const revealedCount = l.revealedCount + 1;
    await t.updateLaunch(l.id, { revealedCount });
    return { l: { ...l, revealedCount }, replay: false };
  });
  if (!res.replay) {
    await invalidate(d);
    publish(d, [{ type: "auction.bid_revealed", data: { launchId: res.l.id, revealedCount: res.l.revealedCount, bidCount: res.l.bidCount } }]);
  }
  return { revealed: true };
}

/** Attach an auto-reveal envelope to an existing commit (POST /api/relayer/reveals for offchain launches). */
export async function attachSealedReveal(d: EngineDeps, env: SealedRevealEnvelope): Promise<BidRow> {
  const l = await d.repo.read.getLaunch(env.launchId);
  if (!l) throw new EngineError(404, "launch not found");
  const checked = checkEnvelope(d, env, l.id, env.bidder, env.commitment.toLowerCase());
  return d.repo.tx(async (t) => {
    const bid = await t.getBid(l.id, env.bidder);
    if (!bid) throw new EngineError(409, "commit the bid first (POST /api/trade/commit), or pass sealedReveal with the commit");
    if (bid.commitment !== checked.commitment) throw new EngineError(400, "envelope commitment does not match the stored bid");
    if (bid.revealed) return bid;
    await t.updateBid(bid.id, { sealedReveal: checked as unknown as Json, autoReveal: "pending" });
    return { ...bid, sealedReveal: checked as unknown as Json, autoReveal: "pending" };
  });
}

/** Relayer: decrypt stored envelopes once the reveal window is open and reveal on the bidder's behalf. */
export async function runAutoReveals(d: EngineDeps, launchId: string): Promise<number> {
  const l = await d.repo.read.getLaunch(launchId);
  if (!l || !revealOpen(d, l)) return 0;
  let n = 0;
  for (const b of await d.repo.read.listBids(l.id)) {
    if (b.revealed || b.autoReveal !== "pending" || !b.sealedReveal) continue;
    const env = SealedRevealEnvelopeSchema.safeParse(b.sealedReveal);
    const pt = env.success ? openAndVerify(env.data, d.relayerBox.secretKey) : null;
    if (!pt) {
      await d.repo.tx((t) => t.updateBid(b.id, { autoReveal: "failed:decrypt" }));
      continue;
    }
    try {
      await revealBid(d, b.bidder, { launchId: l.id, ...pt });
      n++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await d.repo.tx((t) => t.updateBid(b.id, { autoReveal: `failed:${msg.slice(0, 80)}` }));
      d.log?.warn({ launch: l.id, err: msg }, "offchain: auto-reveal failed");
    }
  }
  return n;
}

/** After clearing: refund (deposit − spent, or − slash if unrevealed) and won tokens → available. */
export async function claim(d: EngineDeps, wallet: string, launchId: string): Promise<{ tokens: number; refund: number }> {
  const res = await d.repo.tx(async (t) => {
    const l = await t.getLaunch(launchId, true);
    if (!l) throw new EngineError(404, "launch not found");
    if (!["live", "flywheel", "failed"].includes(l.status)) throw new EngineError(409, "auction not cleared yet", { status: l.status });
    const bid = await t.getBid(l.id, wallet);
    if (!bid) throw new EngineError(404, "no bid for this wallet");
    if (!bid.settled) throw new EngineError(409, "bid not settled");
    if (!bid.claimed) {
      await postIn(t, {
        idempotencyKey: `claim:${l.id}:${wallet}`,
        kind: "claim",
        launchId: l.id,
        meta: { wallet, tokens: (bid.tokens ?? 0n).toString(), refund: (bid.refund ?? 0n).toString() },
        legs: [
          ...move(acct.launch("auction_escrow", l.id, l.quoteAsset), acct.available(wallet, l.quoteAsset), bid.refund ?? 0n),
          ...move(acct.launch("auction_tokens", l.id, tokenAsset(l.id)), acct.available(wallet, tokenAsset(l.id)), bid.tokens ?? 0n),
        ],
        createdTs: nowS(d),
      });
      await t.updateBid(bid.id, { claimed: true });
    }
    return { l, bid };
  });
  return { tokens: fromAtoms(res.bid.tokens ?? 0n, 6), refund: fromAtoms(res.bid.refund ?? 0n, quoteDecimals(res.l)) };
}
