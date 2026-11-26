import type { FastifyBaseLogger } from "fastify";
import { PublicKey } from "@solana/web3.js";
import {
  RevealPlaintextSchema,
  SealedRevealEnvelopeSchema,
  computeCommitment,
  fromHex,
  openReveal,
  pdas,
  programId,
  toHex,
  verifyRevealSignature,
  type RevealPlaintext,
  type SealedRevealEnvelope,
} from "@sealed/shared";
import type { AppContext } from "../context.js";
import { loadProgram } from "../services/solana.js";
import { nowSec, type StoredReveal } from "../store/index.js";

export type EnvelopeCheck =
  | { ok: true; env: SealedRevealEnvelope }
  | { ok: false; code: number; error: string; details?: unknown };

const MAX_ATTEMPTS = 8;

/** Decrypt + verify that the sealed plaintext hashes to the envelope's commitment. */
export function openAndVerify(env: SealedRevealEnvelope, boxSecret: Uint8Array): RevealPlaintext | null {
  const raw = openReveal(env, boxSecret);
  const pt = RevealPlaintextSchema.safeParse(raw);
  if (!pt.success) return null;
  try {
    const c = computeCommitment({ bidder: env.bidder, maxPrice: BigInt(pt.data.maxPrice), bidAmount: BigInt(pt.data.bidAmount), salt: fromHex(pt.data.salt) });
    return toHex(c) === env.commitment.toLowerCase() ? pt.data : null;
  } catch {
    return null;
  }
}

/** Validation for POST /api/relayer/reveals: schema → relayer key → bidder signature → launch window → payload integrity. */
export async function validateEnvelope(ctx: AppContext, body: unknown): Promise<EnvelopeCheck> {
  const parsed = SealedRevealEnvelopeSchema.safeParse(body);
  if (!parsed.success) return { ok: false, code: 400, error: "invalid envelope", details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  const env = { ...parsed.data, commitment: parsed.data.commitment.toLowerCase() };

  if (env.relayerPubkey !== ctx.relayer.boxPubkeyB64) return { ok: false, code: 400, error: "envelope sealed to a different relayer key", details: { expected: ctx.relayer.boxPubkeyB64 } };

  let bidderBytes: Uint8Array;
  try {
    bidderBytes = new PublicKey(env.bidder).toBytes();
  } catch {
    return { ok: false, code: 400, error: "invalid bidder pubkey" };
  }
  let sigOk = false;
  try {
    sigOk = verifyRevealSignature(env, bidderBytes);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, code: 401, error: "invalid signature" };

  const launch = await ctx.store.getLaunch(env.launchId);
  if (!launch) return { ok: false, code: 404, error: "launch not found" };
  if (launch.status !== "commit" && launch.status !== "reveal") return { ok: false, code: 409, error: "auction no longer accepting reveals", details: { status: launch.status } };
  if (nowSec() >= launch.auction.revealEndTs) return { ok: false, code: 409, error: "reveal window closed" };

  // Integrity check up-front so bad payloads are rejected now rather than silently failing at reveal time.
  // The plaintext is discarded immediately and only re-opened once the reveal window opens.
  if (!openAndVerify(env, ctx.relayer.box.secretKey)) return { ok: false, code: 400, error: "payload does not decrypt to the committed bid" };

  return { ok: true, env };
}

/**
 * Auto-reveal relayer. Holds sealed envelopes until the launch's reveal window opens, then
 * decrypts with RELAYER_BOX_SEED, re-verifies the commitment and submits `reveal_bid` paying fees with
 * RELAYER_SECRET_KEY. Demo mode just marks the bid revealed and emits `auction.bid_revealed`.
 */
export function startRevealRelayer(ctx: AppContext, log: FastifyBaseLogger, intervalMs = 2000): () => void {
  let running = false;
  let stopped = false;

  const processOne = async (r: StoredReveal) => {
    const launch = await ctx.store.getLaunch(r.launchId);
    if (!launch) return ctx.store.updateReveal(r.id, { status: "failed", lastError: "launch not found" });
    const now = nowSec();
    if ((now >= launch.auction.revealEndTs && launch.status !== "reveal") || !["commit", "reveal"].includes(launch.status)) {
      return ctx.store.updateReveal(r.id, { status: "failed", lastError: "reveal window missed" });
    }
    const windowOpen = launch.status === "reveal" || now >= launch.auction.commitEndTs;
    if (!windowOpen) return;

    if (ctx.cfg.isDemo) {
      const updated = await ctx.store.markBidRevealed(launch.id, r.bidder);
      await ctx.store.updateReveal(r.id, { status: "submitted", txSignature: "demo" });
      if (updated) ctx.bus.publish({ type: "auction.bid_revealed", data: { launchId: updated.id, revealedCount: updated.auction.revealedCount, bidCount: updated.auction.bidCount } });
      return;
    }

    const pt = openAndVerify(r, ctx.relayer.box.secretKey);
    if (!pt) return ctx.store.updateReveal(r.id, { status: "failed", lastError: "decrypt/commitment mismatch" });
    try {
      const loaded = await loadProgram(ctx.cfg, ctx.relayer.payer);
      if (!loaded) throw new Error("program client unavailable (RPC or IDL missing)");
      const { program, anchor } = loaded;
      const pid = programId(ctx.cfg.programId);
      const launchPk = new PublicKey(launch.id);
      const bidder = new PublicKey(r.bidder);
      const [bid] = pdas.bid(launchPk, bidder, pid);
      const sig: string = await program.methods
        .revealBid(new anchor.BN(pt.maxPrice), new anchor.BN(pt.bidAmount), Array.from(fromHex(pt.salt)))
        .accountsPartial({ payer: ctx.relayer.payer.publicKey, launch: launchPk, bid, bidder })
        .rpc();
      await ctx.store.updateReveal(r.id, { status: "submitted", txSignature: sig, attempts: r.attempts + 1 });
      const updated = await ctx.store.markBidRevealed(launch.id, r.bidder);
      if (updated) ctx.bus.publish({ type: "auction.bid_revealed", data: { launchId: updated.id, revealedCount: updated.auction.revealedCount, bidCount: updated.auction.bidCount } });
      log.info({ launch: launch.id, sig }, "relayer: reveal submitted");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const attempts = r.attempts + 1;
      const already = /AlreadyRevealed/.test(msg);
      await ctx.store.updateReveal(r.id, { attempts, lastError: msg.slice(0, 500), status: already ? "submitted" : attempts >= MAX_ATTEMPTS ? "failed" : "pending" });
      log.warn({ launch: launch.id, err: msg }, "relayer: reveal failed");
    }
  };

  const loop = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const pending = await ctx.store.listPendingReveals();
      for (const r of pending) {
        if (stopped) break;
        await processOne(r).catch((err) => log.warn({ err }, "relayer: process error"));
      }
    } catch (err) {
      log.warn({ err }, "relayer: loop error");
    } finally {
      running = false;
    }
  };

  const t = setInterval(loop, intervalMs);
  t.unref();
  return () => {
    stopped = true;
    clearInterval(t);
  };
}
