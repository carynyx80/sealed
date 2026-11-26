import type { FastifyInstance } from "fastify";
import type { VaultResponse } from "@sealed/shared";
import { sendError, type AppContext } from "../context.js";
import { nowSec } from "../store/index.js";

export async function vaultRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Params: { mint: string } }>("/api/vaults/:mint", async (req, reply) => {
    const launch = await ctx.store.getLaunch(req.params.mint);
    if (!launch) return sendError(reply, 404, "vault not found");
    const res: VaultResponse = {
      launch,
      recentBuybacks: await ctx.store.listBuybacks({ launchId: launch.id, limit: 30 }),
      serverTimeTs: nowSec(),
    };
    return res;
  });
}
