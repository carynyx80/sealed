import type { FastifyInstance } from "fastify";
import type { HealthResponse } from "@sealed/shared";
import type { AppContext } from "../context.js";
import { redactRpc } from "../services/solana.js";

export async function healthRoutes(app: FastifyInstance, ctx: AppContext) {
  const handler = async (): Promise<HealthResponse> => ({
    ok: true,
    network: ctx.cfg.network,
    isDemo: ctx.cfg.isDemo,
    db: ctx.store.kind,
    cache: ctx.cache.kind,
    rpc: redactRpc(ctx.cfg.rpcUrl),
    programId: ctx.cfg.programId,
    uptimeSec: Math.floor((Date.now() - ctx.startedAt) / 1000),
    version: ctx.cfg.version,
  });
  app.get("/api/health", handler);
  // Railway / load-balancer convenience
  app.get("/health", handler);
}
