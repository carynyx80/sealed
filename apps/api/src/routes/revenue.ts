import type { FastifyInstance } from "fastify";
import type { RevenueResponse } from "@sealed/shared";
import { cached } from "../cache/index.js";
import type { AppContext } from "../context.js";
import { getStatsCached } from "./stats.js";

export async function revenueRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/revenue", async (): Promise<RevenueResponse> =>
    cached(ctx.cache, "revenue", 2, async () => {
      const [stats, recentBuybacks, ledger, daily] = await Promise.all([
        getStatsCached(ctx),
        ctx.store.listBuybacks({ limit: 30 }),
        ctx.store.listLedger({ limit: 50 }),
        ctx.store.getDailyRevenue(14),
      ]);
      return { stats, recentBuybacks, ledger, daily };
    }),
  );
}
