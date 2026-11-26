import type { FastifyInstance } from "fastify";
import type { FastifyReply } from "fastify";
import {
  AuthNonceRequestSchema,
  AuthVerifyRequestSchema,
  type AuthErrorCode,
  type AuthErrorResponse,
  type AuthNonceResponse,
  type AuthVerifyResponse,
} from "@sealed/shared";
import { zodDetails, type AppContext } from "../context.js";
import { RateLimiter } from "../offchain/auth/rateLimit.js";
import { attachAuth, bearerToken, requireAuth } from "../offchain/auth/requireAuth.js";
import { AuthError } from "../offchain/auth/siws.js";
import type { CustodyRuntime } from "../offchain/custody/index.js";

const SMALL_BODY = 4 * 1024;
/** verify carries up to a serialized transaction (≤1232 B → ~1.7 KB base64) or a signed message. */
const VERIFY_BODY = 8 * 1024;

/** Every auth failure is `{error, code}` — `code` is stable (AuthErrorCode) so the web can show friendly text. */
function authError(reply: FastifyReply, status: number, code: AuthErrorCode, error: string, details?: unknown) {
  const body: AuthErrorResponse = details === undefined ? { error, code } : { error, code, details };
  return reply.code(status).header("cache-control", "no-store").send(body);
}

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
      if (!p.success) return authError(reply, 400, "malformed", "Invalid wallet address.", zodDetails(p.error));
      if (!nonceIp.hit(req.ip) || !nonceWallet.hit(p.data.wallet)) return authError(reply, 429, "rate_limited", "Too many sign-in attempts, slow down.");
      try {
        const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
        const out = await custody.auth.issueNonce(p.data.wallet, { origin });
        reply.header("cache-control", "no-store");
        return out;
      } catch (e) {
        if (e instanceof AuthError) return authError(reply, e.statusCode, e.code, e.message);
        throw e;
      }
    },
  );

  app.post(
    "/api/auth/verify",
    { bodyLimit: VERIFY_BODY },
    async (req, reply): Promise<AuthVerifyResponse | unknown> => {
      const p = AuthVerifyRequestSchema.safeParse(req.body ?? {});
      if (!p.success) return authError(reply, 400, "malformed", "Invalid sign-in request.", zodDetails(p.error));
      if (!verifyIp.hit(req.ip)) return authError(reply, 429, "rate_limited", "Too many sign-in attempts, slow down.");
      try {
        const out = await custody.auth.verify(p.data);
        reply.header("cache-control", "no-store");
        req.log.info({ wallet: out.wallet }, "auth: signed in");
        return out;
      } catch (e) {
        if (e instanceof AuthError) {
          req.log.info({ code: e.code }, "auth: verify refused");
          return authError(reply, e.statusCode, e.code, e.message);
        }
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
