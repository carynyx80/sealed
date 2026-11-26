import type { FastifyInstance } from "fastify";
import { Base58Schema, type HolderReward } from "@sealed/shared";
import { sendError, type AppContext } from "../context.js";

export async function rewardRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Params: { mint: string; wallet: string } }>("/api/rewards/:mint/:wallet", async (req, reply) => {
    if (!Base58Schema.safeParse(req.params.wallet).success) return sendError(reply, 400, "invalid wallet");
    const launch = await ctx.store.getLaunch(req.params.mint);
    if (!launch) return sendError(reply, 404, "launch not found");
    const res: HolderReward = await ctx.store.getHolderReward(launch, req.params.wallet);
    return res;
  });
}
