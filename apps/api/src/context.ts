import type { FastifyReply } from "fastify";
import type { ZodError } from "zod";
import type { Cache } from "./cache/index.js";
import type { AppConfig } from "./config.js";
import type { EventBus } from "./events.js";
import type { RelayerKeys } from "./services/solana.js";
import type { Store } from "./store/index.js";
import type { OffchainRuntime } from "./offchain/runtime.js";

export interface AppContext {
  cfg: AppConfig;
  store: Store;
  cache: Cache;
  bus: EventBus;
  relayer: RelayerKeys;
  startedAt: number;
  /** Offchain custodial ledger + engine (EXECUTION_MODE=offchain). null when unavailable (e.g. mainnet DB down). */
  offchain?: OffchainRuntime | null;
}

export function sendError(reply: FastifyReply, code: number, error: string, details?: unknown) {
  return reply.code(code).send(details === undefined ? { error } : { error, details });
}

export function zodDetails(err: ZodError) {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}
