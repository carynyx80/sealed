import type { FastifyInstance } from "fastify";
import { AuthNonceRequestSchema, AuthVerifyRequestSchema, type AuthNonceResponse, type AuthVerifyResponse } from "@sealed/shared";
import { sendError, zodDetails, type AppContext } from "../context.js";
import { RateLimiter } from "../offchain/auth/rateLimit.js";
import { attachAuth, bearerToken, requireAuth } from "../offchain/auth/requireAuth.js";
import { AuthError } from "../offchain/auth/siws.js";
import type { CustodyRuntime } from "../offchain/custody/index.js";

const SMALL_BODY = 4 * 1024;

/** SIWS sign-in: POST /api/auth/nonce → sign `message` → POST /api/auth/verify → Bearer session token (7d). */
export async function authRoutes(app: FastifyInstance, _ctx: AppContext, custody: CustodyRuntime) {
  attachAuth(app, custody.auth);
  const nonceIp = new RateLimiter(30);
  const nonceWallet = new RateLimiter(10);
  const verifyIp = new RateLimiter(30);

  app.post(
    "/api/auth/nonce",
    { bodyLimit: SMALL_BODY },
    async (req, reply): Promise<AuthNonceResponse | unknown> => {
      const p = AuthNonceRequestSchema.safeParse(req.body ?? {});
      if (!p.success) return sendError(reply, 400, "invalid nonce request", zodDetails(p.error));
      if (!nonceIp.hit(req.ip) || !nonceWallet.hit(p.data.wallet)) return sendError(reply, 429, "too many sign-in attempts, slow down");
      try {
        reply.header("cache-control", "no-store");
        return await custody.auth.issueNonce(p.data.wallet);
      } catch (e) {
        if (e instanceof AuthError) return sendError(reply, e.statusCode, e.message);
        throw e;
      }
    },
  );

  app.post(
    "/api/auth/verify",
    { bodyLimit: SMALL_BODY },
    async (req, reply): Promise<AuthVerifyResponse | unknown> => {
      const p = AuthVerifyRequestSchema.safeParse(req.body ?? {});
      if (!p.success) return sendError(reply, 400, "invalid verify request", zodDetails(p.error));
      if (!verifyIp.hit(req.ip)) return sendError(reply, 429, "too many sign-in attempts, slow down");
      try {
        const out = await custody.auth.verify(p.data.wallet, p.data.nonce, p.data.signature);
        reply.header("cache-control", "no-store");
        req.log.info({ wallet: out.wallet }, "auth: signed in");
        return out;
      } catch (e) {
        if (e instanceof AuthError) return sendError(reply, e.statusCode, e.message);
        throw e;
      }
    },
  );

  app.post("/api/auth/logout", { bodyLimit: SMALL_BODY, preHandler: requireAuth }, async (req) => {
    const token = bearerToken(req);
    if (token) await custody.auth.logout(token);
    return { ok: true };
  });

  app.get("/api/auth/session", { preHandler: requireAuth }, async (req) => ({ wallet: req.wallet }));
}
