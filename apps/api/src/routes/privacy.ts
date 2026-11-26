import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { PRIVACY_ROUTES, PrivacyLinkRequestSchema, PrivateDepositClaimSchema, type PrivacyLinkResponse, type PrivacyLinkStatus, type PrivacyStatusResponse, type PrivacyUnlinkResponse } from "@sealed/shared";
import { sendError, zodDetails, type AppContext } from "../context.js";
import { RateLimiter } from "../offchain/auth/rateLimit.js";
import { requireAuth } from "../offchain/auth/requireAuth.js";
import type { PrivacyRuntime } from "../offchain/privacy/service.js";
import { HeliusPrivacyService, SPR_RPC_METHODS } from "../services/heliusPrivacy.js";
import { sprProxyRoutes } from "./privacySpr.js";

const RpcBody = z.object({
  method: z.enum(SPR_RPC_METHODS),
  params: z.record(z.unknown()).default({}),
});
const SMALL_BODY = 4 * 1024;

/** Tiny fixed-window per-IP limiter for the proxy (the upstream is metered against our key). */
function limiter(perMinute: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || h.reset < now) {
      hits.set(ip, { n: 1, reset: now + 60_000 });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return true;
    }
    h.n++;
    return h.n <= perMinute;
  };
}

/**
 * GET /api/privacy/status (public) and the indexer proxy are always registered. The custodial private routes
 * (deposit-info, deposits, claim) are registered when a PrivacyRuntime is passed; while the feature is off or
 * unavailable they answer 503 {enabled:false, reason} and never touch the SDK.
 */
export async function privacyRoutes(app: FastifyInstance, ctx: AppContext, service = new HeliusPrivacyService(ctx.cfg), privacy?: PrivacyRuntime) {
  const allow = limiter(120);
  const claimLimit = new RateLimiter(10);
  const linkLimit = new RateLimiter(10);

  app.get(PRIVACY_ROUTES.status, async (): Promise<PrivacyStatusResponse> => {
    const base = await service.status();
    if (!privacy) return base;
    privacy.maybeRefresh();
    return { ...base, ...(ctx.cfg.isDemo ? { enabled: false, reason: base.reason } : privacy.statusFields()) };
  });

  app.post(PRIVACY_ROUTES.rpc, { bodyLimit: 32 * 1024 }, async (req, reply) => {
    const parsed = RpcBody.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(reply, 400, `invalid privacy rpc request (allowed methods: ${SPR_RPC_METHODS.join(", ")})`, zodDetails(parsed.error));
    if (!allow(req.ip)) return sendError(reply, 429, "privacy rpc rate limit exceeded");
    const r = await service.call(parsed.data.method, parsed.data.params);
    reply.header("cache-control", "no-store");
    return reply.code(r.status).send(r.body);
  });

  if (!privacy) return;
  await sprProxyRoutes(app, ctx, privacy, privacy.sprFetch);
  const disabled = (reply: FastifyReply) => reply.code(503).header("cache-control", "no-store").send({ enabled: false, reason: privacy.reason ?? "unavailable" });

  app.get(PRIVACY_ROUTES.depositInfo, { preHandler: requireAuth }, async (req, reply) => {
    if (!privacy.enabled) return disabled(reply);
    reply.header("cache-control", "no-store");
    return privacy.depositInfo(req.wallet!);
  });

  app.get(PRIVACY_ROUTES.deposits, { preHandler: requireAuth }, async (req, reply) => {
    if (!privacy.config.enabled) return disabled(reply);
    reply.header("cache-control", "no-store");
    return { deposits: await privacy.listDeposits(req.wallet!) };
  });

  // Private Sealed wallet (burner) link. Gated on the flag only: linking is bookkeeping and works while the ring is
  // briefly unreachable. Errors carry a machine-readable `code`.
  app.get(PRIVACY_ROUTES.link, { preHandler: requireAuth }, async (req, reply): Promise<PrivacyLinkStatus | FastifyReply> => {
    if (!privacy.config.enabled) return disabled(reply);
    reply.header("cache-control", "no-store");
    return privacy.linkStatus(req.wallet!);
  });

  app.post(PRIVACY_ROUTES.link, { bodyLimit: SMALL_BODY, preHandler: requireAuth }, async (req, reply): Promise<PrivacyLinkResponse | FastifyReply> => {
    if (!privacy.config.enabled) return disabled(reply);
    if (!linkLimit.hit(req.wallet!)) return reply.code(429).send({ error: "too many link requests, slow down", code: "rate_limited" });
    const p = PrivacyLinkRequestSchema.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: "invalid link request", code: "invalid_request", details: zodDetails(p.error) });
    const r = await privacy.link(req.wallet!, p.data.burner, p.data.signature);
    reply.header("cache-control", "no-store");
    if (!r.ok) return reply.code(r.status).send({ error: r.error, code: r.code });
    return { linked: true, burner: r.burner };
  });

  app.delete(PRIVACY_ROUTES.link, { preHandler: requireAuth }, async (req, reply): Promise<PrivacyUnlinkResponse | FastifyReply> => {
    if (!privacy.config.enabled) return disabled(reply);
    if (!linkLimit.hit(req.wallet!)) return reply.code(429).send({ error: "too many link requests, slow down", code: "rate_limited" });
    await privacy.unlink(req.wallet!);
    reply.header("cache-control", "no-store");
    return { linked: false };
  });

  app.post(PRIVACY_ROUTES.claimDeposit, { bodyLimit: SMALL_BODY, preHandler: requireAuth }, async (req, reply) => {
    if (!privacy.enabled) return disabled(reply);
    const p = PrivateDepositClaimSchema.safeParse(req.body ?? {});
    if (!p.success) return sendError(reply, 400, "invalid claim", zodDetails(p.error));
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(p.data.signature)) return sendError(reply, 400, "signature must be base58");
    if (!claimLimit.hit(req.wallet!)) return sendError(reply, 429, "too many claims, slow down");
    try {
      return await privacy.claim(req.wallet!, p.data.signature);
    } catch (err) {
      req.log.warn({ err: (err as Error).message?.slice(0, 160) }, "privacy: claim failed");
      return sendError(reply, 503, "Privacy Ring temporarily unreachable, try again shortly");
    }
  });
}
