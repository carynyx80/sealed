import type { FastifyInstance } from "fastify";
import type { ProtocolStats } from "@sealed/shared";
import { cached } from "../cache/index.js";
import type { AppContext } from "../context.js";

export function getStatsCached(ctx: AppContext): Promise<ProtocolStats> {
  return cached(ctx.cache, "stats", 2, () => ctx.store.getStats());
}

export async function statsRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/stats", async (): Promise<ProtocolStats> => getStatsCached(ctx));
}
