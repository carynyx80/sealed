import type { FastifyInstance } from "fastify";
import type { CustodyInfoResponse } from "@sealed/shared";
import type { AppContext } from "../context.js";
import type { CustodyRuntime } from "../offchain/custody/index.js";

/** Public: GET /api/custody/info — company wallet, payout status and proof of reserves (cached 30s). */
export async function custodyRoutes(app: FastifyInstance, _ctx: AppContext, custody: CustodyRuntime) {
  app.get("/api/custody/info", async (_req, reply): Promise<CustodyInfoResponse> => {
    reply.header("cache-control", "public, max-age=15");
    return {
      companyWallet: custody.config.companyWallet,
      network: custody.config.network,
      mode: custody.config.mode,
      payoutsEnabled: custody.payouts !== null,
      proofOfReserves: await custody.reserves.proofOfReserves(),
    };
  });
}
