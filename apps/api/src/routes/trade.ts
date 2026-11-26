import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { Base58Schema, CUSTODY_ROUTES, OffchainCommitBidSchema, OffchainRevealSchema, OffchainSwapSchema } from "@sealed/shared";
import { sendError, zodDetails, type AppContext } from "../context.js";
import { requireAuth } from "../offchain/auth/requireAuth.js";
import type { OffchainEngine } from "../offchain/engine/index.js";

const StakeSchema = z.object({ launchId: Base58Schema, amount: z.number().finite().refine((v) => v !== 0, "amount must be non-zero") });
const IdemHeader = z.string().regex(/^[A-Za-z0-9_\-:.]{8,100}$/);

function idemKey(req: FastifyRequest): string {
  const h = req.headers["idempotency-key"];
  const v = Array.isArray(h) ? h[0] : h;
  return v && IdemHeader.safeParse(v).success ? v : randomUUID();
}

/**
 * Offchain custodial trading (CUSTODY_ROUTES). Every route requires a session (requireAuth → req.wallet); the
 * acting wallet is ALWAYS the authenticated one, never taken from the body.
 */
export async function tradeRoutes(app: FastifyInstance, ctx: AppContext) {
  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<{ engine: OffchainEngine; wallet: string } | null> => {
    const engine = ctx.offchain?.engine;
    if (!engine) {
      await sendError(reply, 503, ctx.cfg.executionMode === "offchain" ? "offchain ledger unavailable" : "EXECUTION_MODE=onchain: trade on-chain");
      return null;
    }
    const wallet = await requireAuth(req, reply);
    if (!wallet || reply.sent) return null;
    return { engine, wallet };
  };

  app.post(CUSTODY_ROUTES.commitBid, async (req, reply) => {
    const g = await guard(req, reply);
    if (!g) return reply;
    const p = OffchainCommitBidSchema.safeParse(req.body ?? {});
    if (!p.success) return sendError(reply, 400, "invalid commit", zodDetails(p.error));
    return g.engine.commitBid(g.wallet, p.data);
  });

  app.post(CUSTODY_ROUTES.reveal, async (req, reply) => {
    const g = await guard(req, reply);
    if (!g) return reply;
    const p = OffchainRevealSchema.safeParse(req.body ?? {});
    if (!p.success) return sendError(reply, 400, "invalid reveal", zodDetails(p.error));
    return g.engine.revealBid(g.wallet, p.data);
  });

  app.post(CUSTODY_ROUTES.swap, async (req, reply) => {
    const g = await guard(req, reply);
    if (!g) return reply;
    const p = OffchainSwapSchema.safeParse(req.body ?? {});
    if (!p.success) return sendError(reply, 400, "invalid swap", zodDetails(p.error));
    return g.engine.swap(g.wallet, p.data, idemKey(req));
  });

  app.post<{ Params: { launchId: string } }>("/api/trade/claim/:launchId", async (req, reply) => {
    const g = await guard(req, reply);
    if (!g) return reply;
    if (!Base58Schema.safeParse(req.params.launchId).success) return sendError(reply, 400, "invalid launchId");
    return g.engine.claim(g.wallet, req.params.launchId);
  });

  app.post(CUSTODY_ROUTES.stake, async (req, reply) => {
    const g = await guard(req, reply);
    if (!g) return reply;
    const p = StakeSchema.safeParse(req.body ?? {});
    if (!p.success) return sendError(reply, 400, "invalid stake", zodDetails(p.error));
    return g.engine.stake(g.wallet, p.data.launchId, p.data.amount, idemKey(req));
  });

  app.post<{ Params: { launchId: string } }>("/api/trade/rewards/:launchId", async (req, reply) => {
    const g = await guard(req, reply);
    if (!g) return reply;
    if (!Base58Schema.safeParse(req.params.launchId).success) return sendError(reply, 400, "invalid launchId");
    return g.engine.claimRewards(g.wallet, req.params.launchId);
  });
}
