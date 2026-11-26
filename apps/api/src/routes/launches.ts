import type { FastifyInstance } from "fastify";
import { Keypair } from "@solana/web3.js";
import { z } from "zod";
import {
  CREDIT_TIERS,
  CreateLaunchInputSchema,
  ListLaunchesQuerySchema,
  MAX_COMMIT_DURATION_SEC,
  MIN_COMMIT_DURATION_SEC_MAINNET,
  QUOTE_ASSETS,
  demoImage,
  isQuoteAssetEnabled,
  pdas,
  quoteAssetDisabledReason,
  programId,
  type ChartResponse,
  type CreateLaunchInput,
  type LaunchListResponse,
  type LaunchSummary,
  type TradesResponse,
} from "@sealed/shared";
import { cached } from "../cache/index.js";
import { sendError, zodDetails, type AppContext } from "../context.js";
import { nowSec, publicLaunch } from "../store/index.js";
import { requireAuth } from "../offchain/auth/requireAuth.js";
import { validateTokenImageUri } from "./uploads.js";

const CreateLaunchBody = CreateLaunchInputSchema.superRefine((v, c) => {
  if (v.clearingCap < v.targetRaise) c.addIssue({ code: z.ZodIssueCode.custom, path: ["clearingCap"], message: "clearingCap must be ≥ targetRaise" });
  if (v.tickSize > v.floorPrice * 10) c.addIssue({ code: z.ZodIssueCode.custom, path: ["tickSize"], message: "tickSize unreasonably large vs floorPrice" });
});

const TradesQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const ChartQuery = z.object({ interval: z.enum(["1m", "5m", "1h"]).default("5m") });

export function buildDemoLaunch(input: CreateLaunchInput, network: LaunchSummary["network"], now = nowSec()): LaunchSummary {
  const mint = Keypair.generate().publicKey;
  const [launchPda] = pdas.launch(mint, programId());
  const tokensForSale = Math.floor((input.totalSupply * input.auctionSupplyBps) / 10_000);
  const hue = [...input.ticker].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
  return {
    id: launchPda.toBase58(),
    mint: mint.toBase58(),
    name: input.name,
    ticker: input.ticker,
    description: input.description,
    imageUri: input.imageUri || demoImage(input.ticker, hue),
    creator: input.creator ?? Keypair.generate().publicKey.toBase58(),
    creatorAllocationBps: input.creatorAllocationBps,
    totalSupply: input.totalSupply,
    quoteAsset: input.quoteAsset,
    creditTier: input.creditTier,
    status: "commit",
    createdTs: now,
    auction: {
      commitStartTs: now,
      commitEndTs: now + input.commitDurationSec,
      revealEndTs: now + input.commitDurationSec + input.revealDurationSec,
      bidCount: 0,
      revealedCount: 0,
      escrowedWallets: 0,
      totalEscrowed: 0,
      floorPrice: input.floorPrice,
      tickSize: input.tickSize,
      tokensForSale,
      targetRaise: input.targetRaise,
      clearingCap: input.clearingCap,
      clearingPrice: null,
      totalRaised: null,
    },
    market: null,
    vault: null,
    credit: null,
    network,
    isDemo: true,
  };
}

export async function launchRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/launches", async (req, reply) => {
    const q = ListLaunchesQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, "invalid query", zodDetails(q.error));
    const key = await ctx.cache.nsKey("launches", JSON.stringify(q.data));
    const res: LaunchListResponse = await cached(ctx.cache, key, 1, () => ctx.store.listLaunches(q.data));
    return res;
  });

  app.get<{ Params: { id: string } }>("/api/launches/:id", async (req, reply) => {
    const l = await ctx.store.getLaunch(req.params.id);
    if (!l) return sendError(reply, 404, "launch not found");
    return l;
  });

  app.get<{ Params: { id: string } }>("/api/launches/:id/trades", async (req, reply) => {
    const q = TradesQuery.safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, "invalid query", zodDetails(q.error));
    const l = await ctx.store.getLaunch(req.params.id);
    if (!l) return sendError(reply, 404, "launch not found");
    const res: TradesResponse = { trades: await ctx.store.getTrades(l.id, q.data.limit) };
    return res;
  });

  app.get<{ Params: { id: string } }>("/api/launches/:id/chart", async (req, reply) => {
    const q = ChartQuery.safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, "invalid query", zodDetails(q.error));
    const l = await ctx.store.getLaunch(req.params.id);
    if (!l) return sendError(reply, 404, "launch not found");
    const res: ChartResponse = { points: await ctx.store.getChart(l.id, q.data.interval) };
    return res;
  });

  app.post("/api/launches", async (req, reply) => {
    const parsed = CreateLaunchBody.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(reply, 400, "invalid launch input", zodDetails(parsed.error));
    const input = parsed.data;

    // MAINNET server-side rules (independent of execution mode): commit window 15–30 min, enabled quote assets only.
    if (ctx.cfg.network === "mainnet") {
      if (input.commitDurationSec < MIN_COMMIT_DURATION_SEC_MAINNET || input.commitDurationSec > MAX_COMMIT_DURATION_SEC) {
        return sendError(reply, 400, `commitDurationSec must be within [${MIN_COMMIT_DURATION_SEC_MAINNET}, ${MAX_COMMIT_DURATION_SEC}] on mainnet`);
      }
      if (!isQuoteAssetEnabled(input.quoteAsset, "mainnet")) {
        return sendError(reply, 400, quoteAssetDisabledReason(input.quoteAsset, "mainnet") ?? `${input.quoteAsset} is not enabled on mainnet`);
      }
    }

    // OFFCHAIN mode: a signed-in creator creates a real custodial launch (creator = session wallet, ≤2% enforced).
    // Unauthenticated requests keep the demo behaviour in DEMO_MODE.
    if (ctx.cfg.executionMode === "offchain" && (req.headers.authorization || !ctx.cfg.isDemo)) {
      const engine = ctx.offchain?.engine;
      if (!engine) return sendError(reply, 503, "offchain ledger unavailable");
      const wallet = await requireAuth(req, reply);
      if (!wallet || reply.sent) return reply;
      const imageErr = await validateTokenImageUri(ctx, req, input.imageUri, wallet);
      if (imageErr) return sendError(reply, 400, imageErr);
      const row = await engine.createLaunch(input, wallet);
      const summary = await engine.getSummary(row.id);
      return reply.code(200).send(publicLaunch(summary!));
    }

    const imageErr = await validateTokenImageUri(ctx, req, input.imageUri);
    if (imageErr) return sendError(reply, 400, imageErr);

    if (!ctx.cfg.isDemo) {
      const atoms = (v: number) => BigInt(Math.round(v * 10 ** QUOTE_ASSETS[input.quoteAsset].decimals)).toString();
      return sendError(reply, 501, "sign client-side", {
        message: "Non-demo launches are created by the creator's wallet. Build and sign the create_launch transaction client-side.",
        programId: ctx.cfg.programId,
        instruction: "create_launch",
        args: {
          name: input.name,
          ticker: input.ticker,
          uri: input.metadataUri,
          total_supply: (BigInt(input.totalSupply) * 1_000_000n).toString(),
          creator_allocation_bps: input.creatorAllocationBps,
          auction_supply_bps: input.auctionSupplyBps,
          credit_bps: CREDIT_TIERS[input.creditTier],
          commit_duration_sec: input.commitDurationSec,
          reveal_duration_sec: input.revealDurationSec,
          floor_price: atoms(input.floorPrice),
          tick_size: atoms(input.tickSize),
          target_raise: atoms(input.targetRaise),
          clearing_cap: atoms(input.clearingCap),
        },
      });
    }

    const launch = buildDemoLaunch(input, ctx.cfg.network);
    await ctx.store.upsertLaunch(launch);
    await ctx.cache.bump("launches");
    await ctx.cache.del("stats");
    const pub = publicLaunch(launch);
    ctx.bus.publish({ type: "launch.created", data: pub });
    return reply.code(200).send(pub);
  });
}
