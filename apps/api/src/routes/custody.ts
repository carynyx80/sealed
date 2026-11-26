import type { FastifyInstance } from "fastify";
import type { CustodyInfoResponse } from "@sealed/shared";
import type { AppContext } from "../context.js";
import type { CustodyRuntime } from "../offchain/custody/index.js";

/**
 * Public: GET /api/custody/info — company wallet, payout status (payoutsEnabled is false while the signer is missing
 * OR the company wallet lacks SOL for fees; payoutsReason says why), fee-payer health and proof of reserves (cached 30s).
 */
export async function custodyRoutes(app: FastifyInstance, _ctx: AppContext, custody: CustodyRuntime) {
  app.get("/api/custody/info", async (_req, reply): Promise<CustodyInfoResponse> => {
    reply.header("cache-control", "public, max-age=15");
    const [status, proofOfReserves] = await Promise.all([custody.payoutStatus(), custody.reserves.proofOfReserves()]);
    return {
      companyWallet: custody.config.companyWallet,
      network: custody.config.network,
      mode: custody.config.mode,
      payoutsEnabled: status.enabled,
      payoutsReason: status.reason,
      ...(status.feePayer ? { feePayer: status.feePayer } : {}),
      proofOfReserves,
    };
  });
}
