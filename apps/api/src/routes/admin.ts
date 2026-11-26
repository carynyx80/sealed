import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { QuoteAssetSymbolSchema, type WithdrawalStatus } from "@sealed/shared";
import { sendError, zodDetails, type AppContext } from "../context.js";
import { RateLimiter } from "../offchain/auth/rateLimit.js";
import { toAtoms } from "../offchain/custody/chain.js";
import type { CustodyRuntime } from "../offchain/custody/index.js";
import { ledgerErrorCode } from "../offchain/custody/ledgerPort.js";
import { CustodyError } from "../offchain/custody/withdrawals.js";

const SMALL_BODY = 4 * 1024;
const STATUSES = ["queued", "pending_approval", "sending", "sent", "failed", "rejected"] as const;

const ActionSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(["approve", "reject"]),
  reason: z.string().max(200).optional(),
});
const SeedSchema = z.object({
  asset: QuoteAssetSymbolSchema,
  amount: z.number().positive(),
  /** Idempotency reference, e.g. the funding tx signature or an ops ticket id (a repeat POST is a no-op). */
  reference: z.string().min(4).max(120),
});

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Admin routes, gated by header `x-admin-token` == ADMIN_TOKEN (constant-time compare). Disabled if unset. */
export async function adminRoutes(app: FastifyInstance, _ctx: AppContext, custody: CustodyRuntime) {
  const failLimit = new RateLimiter(10);
  const expected = custody.config.adminToken ? digest(custody.config.adminToken) : null;

  async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
    if (!expected) return sendError(reply, 503, "admin disabled (ADMIN_TOKEN not configured)");
    const h = req.headers["x-admin-token"];
    const ok = typeof h === "string" && h.length > 0 && h.length <= 512 && timingSafeEqual(digest(h), expected);
    if (!ok) {
      if (!failLimit.hit(req.ip)) return sendError(reply, 429, "too many failed admin attempts");
      req.log.warn({ ip: req.ip }, "admin: rejected token");
      return sendError(reply, 401, "unauthorized");
    }
  }

  app.get<{ Querystring: { status?: string } }>("/api/admin/withdrawals", { preHandler: requireAdmin }, async (req, reply) => {
    const s = req.query.status;
    if (s && !(STATUSES as readonly string[]).includes(s)) return sendError(reply, 400, `status must be one of ${STATUSES.join(",")}`);
    const statuses: WithdrawalStatus[] = s ? [s as WithdrawalStatus] : ["pending_approval", "queued", "sending"];
    const rows = await custody.repo.listWithdrawalsByStatus(statuses, 200);
    return { withdrawals: rows.map((w) => ({ ...custody.withdrawals.dto(w), wallet: w.wallet, usdValue: w.usdValue, attempts: w.attempts })), payoutsEnabled: custody.payouts !== null };
  });

  app.post("/api/admin/withdrawals", { bodyLimit: SMALL_BODY, preHandler: requireAdmin }, async (req, reply) => {
    const p = ActionSchema.safeParse(req.body ?? {});
    if (!p.success) return sendError(reply, 400, "invalid admin action", zodDetails(p.error));
    try {
      const w = p.data.action === "approve"
        ? await custody.withdrawals.approve(p.data.id)
        : await custody.withdrawals.reject(p.data.id, p.data.reason ?? "rejected by admin");
      return custody.withdrawals.dto(w);
    } catch (e) {
      if (e instanceof CustodyError) return sendError(reply, e.statusCode, e.message);
      throw e;
    }
  });

  /** Seed credit_pool:<asset> from company funds already held in the company wallet (recorded in the ledger). */
  app.post("/api/admin/credit-pool/seed", { bodyLimit: SMALL_BODY, preHandler: requireAdmin }, async (req, reply) => {
    const p = SeedSchema.safeParse(req.body ?? {});
    if (!p.success) return sendError(reply, 400, "invalid seed request", zodDetails(p.error));
    if (!custody.ledger) return sendError(reply, 503, "ledger unavailable");
    const asset = custody.assets.find((a) => a.symbol === p.data.asset);
    if (!asset) return sendError(reply, 400, `${p.data.asset} not configured on ${custody.config.network}`);
    const atoms = toAtoms(p.data.amount, asset.decimals);
    if (atoms <= 0n) return sendError(reply, 400, "amount too small");
    try {
      const r = await custody.ledger.creditSystem("credit_pool", asset.symbol, atoms, `seed:credit_pool:${asset.symbol}:${p.data.reference}`, {
        type: "credit_pool_seed", reference: p.data.reference,
      });
      req.log.info({ asset: asset.symbol, atoms: atoms.toString(), replayed: r.replayed }, "admin: credit pool seeded");
      return { ok: true, asset: asset.symbol, amount: p.data.amount, txId: r.txId, replayed: r.replayed };
    } catch (e) {
      const code = ledgerErrorCode(e);
      if (code) return sendError(reply, code === "IDEMPOTENCY_CONFLICT" ? 409 : 400, (e as Error).message);
      throw e;
    }
  });
}
