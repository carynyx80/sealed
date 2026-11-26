import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { Base58Schema, QUOTE_ASSETS, QuoteAssetSymbolSchema, type WithdrawalStatus } from "@sealed/shared";
import { sendError, zodDetails, type AppContext } from "../context.js";
import { RateLimiter } from "../offchain/auth/rateLimit.js";
import { toAtoms } from "../offchain/custody/chain.js";
import type { CustodyRuntime } from "../offchain/custody/index.js";
import { ledgerErrorCode } from "../offchain/custody/ledgerPort.js";
import { CustodyError } from "../offchain/custody/withdrawals.js";
import type { PrivacyRuntime } from "../offchain/privacy/service.js";

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

const TestCreditSchema = z.object({
  wallet: Base58Schema,
  asset: QuoteAssetSymbolSchema,
  amount: z.number().positive(),
  /** Idempotency reference (a repeat POST with the same reference is a no-op). */
  reference: z.string().min(4).max(120),
});
const TestClockSchema = z.object({ advanceSec: z.number().int().min(1).max(30 * 86_400) });

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Admin routes, gated by header `x-admin-token` == ADMIN_TOKEN (constant-time compare). Disabled if unset. */
export async function adminRoutes(app: FastifyInstance, ctx: AppContext, custody: CustodyRuntime, privacy?: PrivacyRuntime) {
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

  /** Privacy Ring operator view (probe detail, registration). */
  app.get("/api/admin/privacy", { preHandler: requireAdmin }, async (_req, reply) => {
    if (!privacy || !privacy.config.enabled) return reply.code(503).send({ enabled: false, reason: privacy?.reason ?? "Private deposits and withdrawals are turned off on this deployment." });
    await privacy.refresh();
    return privacy.adminStatus();
  });

  /** Register the company shielded address in the User Registry (company wallet pays rent + fee; 409 without SOL). */
  app.post("/api/admin/privacy/register", { bodyLimit: SMALL_BODY, preHandler: requireAdmin }, async (_req, reply) => {
    if (!privacy || !privacy.config.enabled) return reply.code(503).send({ enabled: false, reason: privacy?.reason ?? "Private deposits and withdrawals are turned off on this deployment." });
    const r = await privacy.register();
    return reply.code(r.code).send(r.body);
  });

  app.get<{ Querystring: { status?: string } }>("/api/admin/withdrawals", { preHandler: requireAdmin }, async (req, reply) => {
    const s = req.query.status;
    if (s && !(STATUSES as readonly string[]).includes(s)) return sendError(reply, 400, `status must be one of ${STATUSES.join(",")}`);
    const statuses: WithdrawalStatus[] = s ? [s as WithdrawalStatus] : ["pending_approval", "queued", "sending"];
    const rows = await custody.repo.listWithdrawalsByStatus(statuses, 200);
    const status = await custody.payoutStatus();
    return {
      withdrawals: rows.map((w) => ({ ...custody.withdrawals.dto(w), wallet: w.wallet, usdValue: w.usdValue, attempts: w.attempts })),
      payoutsEnabled: status.enabled,
      payoutsReason: status.reason,
      ...(status.feePayer ? { feePayer: status.feePayer } : {}),
    };
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

  /** Ledger invariant report (balanced txs, stored == Σ entries, no negative user accounts) + liabilities per asset. */
  app.get("/api/admin/ledger/verify", { preHandler: requireAdmin }, async (_req, reply) => {
    const ledger = ctx.offchain?.ledger;
    if (!ledger) return sendError(reply, 503, "ledger unavailable");
    const report = await ledger.verify();
    const liabilities: Record<string, string> = {};
    for (const a of custody.assets) liabilities[a.symbol] = (await ledger.liabilities(a.symbol)).toString(); // atoms
    return { ...report, liabilities };
  });

  // ---------------- test-only hooks (env-gated, never on mainnet; see custody/config.ts) ----------------
  if (custody.config.testCredit) {
    app.log.warn("admin: ENABLE_TEST_CREDIT is on — POST /api/admin/test-credit can mint unbacked balances (devnet/test only)");
    /** Credit a wallet's available balance without an on-chain deposit (company_custody → user_available). */
    app.post("/api/admin/test-credit", { bodyLimit: SMALL_BODY, preHandler: requireAdmin }, async (req, reply) => {
      const p = TestCreditSchema.safeParse(req.body ?? {});
      if (!p.success) return sendError(reply, 400, "invalid test credit", zodDetails(p.error));
      if (!custody.ledger) return sendError(reply, 503, "ledger unavailable");
      const atoms = toAtoms(p.data.amount, QUOTE_ASSETS[p.data.asset].decimals);
      if (atoms <= 0n) return sendError(reply, 400, "amount too small");
      try {
        const r = await custody.ledger.credit(p.data.wallet, p.data.asset, atoms, `testcredit:${p.data.reference}`, { type: "test_credit", reference: p.data.reference });
        req.log.warn({ wallet: p.data.wallet, asset: p.data.asset, atoms: atoms.toString(), replayed: r.replayed }, "admin: TEST credit");
        return { ok: true, wallet: p.data.wallet, asset: p.data.asset, amount: p.data.amount, txId: r.txId, replayed: r.replayed };
      } catch (e) {
        const code = ledgerErrorCode(e);
        if (code) return sendError(reply, code === "IDEMPOTENCY_CONFLICT" ? 409 : 400, (e as Error).message);
        throw e;
      }
    });
  }

  const engine = ctx.offchain?.engine;
  if (custody.config.testClock && engine) {
    app.log.warn("admin: ENABLE_TEST_CLOCK is on — POST /api/admin/test-clock can fast-forward auction windows (test only)");
    let offsetMs = 0;
    const base = engine.deps.nowMs;
    engine.deps.nowMs = () => base() + offsetMs;
    /** Fast-forward the offchain engine clock (commit/reveal windows, drips, anti-snipe); the scheduler picks it up. */
    app.post("/api/admin/test-clock", { bodyLimit: SMALL_BODY, preHandler: requireAdmin }, async (req, reply) => {
      const p = TestClockSchema.safeParse(req.body ?? {});
      if (!p.success) return sendError(reply, 400, "invalid test clock", zodDetails(p.error));
      offsetMs += p.data.advanceSec * 1000;
      return { nowMs: engine.deps.nowMs(), offsetSec: offsetMs / 1000 };
    });
  }
}
