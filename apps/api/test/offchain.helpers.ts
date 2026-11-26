import type { App } from "../src/server.js";
import type { AuthService } from "../src/offchain/auth/siws.js";

/**
 * Test-only session resolver: `Authorization: Bearer dev_<wallet>` → session for <wallet>.
 * (Production uses custody-agent's SIWS AuthService; requireAuth only depends on `app.sealedAuth.resolve`.)
 */
export function installDevAuth(app: App) {
  const stub = {
    resolve: async (token: string) => (token.startsWith("dev_") ? { wallet: token.slice(4), expiresAt: new Date(Date.now() + 3_600_000) } : null),
  } as unknown as AuthService;
  (app as unknown as { sealedAuth?: AuthService }).sealedAuth = stub;
}

export const bearer = (wallet: string) => ({ authorization: `Bearer dev_${wallet}` });
