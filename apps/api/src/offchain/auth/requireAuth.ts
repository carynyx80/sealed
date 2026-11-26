import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthService } from "./siws.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Signed-in wallet (set by requireAuth). */
    wallet?: string;
  }
  interface FastifyInstance {
    sealedAuth?: AuthService;
  }
}

/** Attach the session resolver to an app instance (done once in server.ts via registerAuth). */
export function attachAuth(app: FastifyInstance, auth: AuthService): void {
  if (!app.hasDecorator("sealedAuth")) app.decorate("sealedAuth", auth);
  else app.sealedAuth = auth;
}

export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || typeof h !== "string") return null;
  const m = /^Bearer\s+([A-Za-z0-9_\-.~+/=]{16,128})$/.exec(h.trim());
  return m ? m[1]! : null;
}

/**
 * Fastify preHandler (or call inline). Resolves `Authorization: Bearer <token>` to a live session and sets
 * `req.wallet`; otherwise replies 401. Returns the wallet on success, undefined when a reply was sent.
 *
 *   app.get("/x", { preHandler: requireAuth }, handler)
 *   // or: const wallet = await requireAuth(req, reply); if (!wallet) return reply;
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  const auth = req.server.sealedAuth;
  if (!auth) {
    await reply.code(503).send({ error: "auth not configured" });
    return undefined;
  }
  const token = bearerToken(req);
  const session = token ? await auth.resolve(token) : null;
  if (!session) {
    await reply.code(401).header("www-authenticate", "Bearer").send({ error: "unauthorized" });
    return undefined;
  }
  req.wallet = session.wallet;
  return session.wallet;
}
