import type { FastifyInstance } from "fastify";
import type { RelayerPubkeyResponse } from "@sealed/shared";
import { sendError, type AppContext } from "../context.js";
import { validateEnvelope } from "../workers/revealRelayer.js";

export async function relayerRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/relayer/pubkey", async (): Promise<RelayerPubkeyResponse> => ({
    pubkey: ctx.relayer.boxPubkeyB64,
    relayerAddress: ctx.relayer.payer.publicKey.toBase58(),
  }));

  app.post("/api/relayer/reveals", async (req, reply) => {
    const check = await validateEnvelope(ctx, req.body);
    if (!check.ok) return sendError(reply, check.code, check.error, check.details);
    const rec = await ctx.store.saveReveal(check.env);
    return { accepted: true as const, id: rec.id };
  });
}
