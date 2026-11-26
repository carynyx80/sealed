import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrivacyStatusResponse } from "@sealed/shared";
import { sendError, zodDetails, type AppContext } from "../context.js";
import { HeliusPrivacyService, SPR_RPC_METHODS } from "../services/heliusPrivacy.js";

const RpcBody = z.object({
  method: z.enum(SPR_RPC_METHODS),
  params: z.record(z.unknown()).default({}),
});

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

export async function privacyRoutes(app: FastifyInstance, ctx: AppContext, service = new HeliusPrivacyService(ctx.cfg)) {
  const allow = limiter(120);

  app.get("/api/privacy/status", async (): Promise<PrivacyStatusResponse> => service.status());

  app.post("/api/privacy/rpc", { bodyLimit: 32 * 1024 }, async (req, reply) => {
    const parsed = RpcBody.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(reply, 400, `invalid privacy rpc request (allowed methods: ${SPR_RPC_METHODS.join(", ")})`, zodDetails(parsed.error));
    if (!allow(req.ip)) return sendError(reply, 429, "privacy rpc rate limit exceeded");
    const r = await service.call(parsed.data.method, parsed.data.params);
    reply.header("cache-control", "no-store");
    return reply.code(r.status).send(r.body);
  });
}
