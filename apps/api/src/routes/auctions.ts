import type { FastifyInstance } from "fastify";
import { Keypair } from "@solana/web3.js";
import { DemoBidInputSchema, type AuctionResponse } from "@sealed/shared";
import { sendError, zodDetails, type AppContext } from "../context.js";
import { nowSec } from "../store/index.js";

/**
 * Sealed auctions. Responses carry ONLY public aggregates (bid count, escrowed wallets, total escrowed,
 * revealed count). Individual commitments, deposits, prices and sizes are never returned before clearing.
 */
export async function auctionRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Params: { id: string } }>("/api/auctions/:id", async (req, reply) => {
    const launch = await ctx.store.getLaunch(req.params.id);
    if (!launch) return sendError(reply, 404, "auction not found");
    const res: AuctionResponse = { launch, serverTimeTs: nowSec() };
    return res;
  });

  app.post<{ Params: { id: string } }>("/api/auctions/:id/demo-bid", async (req, reply) => {
    if (!ctx.cfg.isDemo) return sendError(reply, 403, "demo-bid is only available in demo mode; submit commit_bid on-chain");
    const parsed = DemoBidInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(reply, 400, "invalid bid", zodDetails(parsed.error));
    const launch = await ctx.store.getLaunch(req.params.id);
    if (!launch) return sendError(reply, 404, "auction not found");
    if (launch.status !== "commit" || nowSec() >= launch.auction.commitEndTs) return sendError(reply, 409, "commit window closed", { status: launch.status });

    const updated = await ctx.store.recordBidCommit({
      launchId: launch.id,
      bidder: parsed.data.wallet ?? Keypair.generate().publicKey.toBase58(),
      commitment: parsed.data.commitment,
      deposit: parsed.data.deposit,
    });
    await ctx.cache.bump("launches");
    const a = updated.auction;
    ctx.bus.publish({ type: "auction.bid_committed", data: { launchId: updated.id, bidCount: a.bidCount, escrowedWallets: a.escrowedWallets, totalEscrowed: a.totalEscrowed } });
    const res: AuctionResponse = { launch: updated, serverTimeTs: nowSec() };
    return res;
  });
}
