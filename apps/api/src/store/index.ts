import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import type { EventBus } from "../events.js";
import { MemoryStore } from "./memory.js";
import type { Store } from "./types.js";

export * from "./types.js";
export { MemoryStore } from "./memory.js";

/** Postgres when DATABASE_URL is set (falls back to memory if the connection fails), otherwise in-memory. */
export async function createStore(cfg: AppConfig, bus: EventBus, log: FastifyBaseLogger): Promise<Store> {
  if (cfg.databaseUrl) {
    try {
      const { PrismaStore } = await import("./prisma.js");
      const store = new PrismaStore(cfg.databaseUrl, cfg.network, cfg.isDemo);
      await store.init();
      log.info("store: postgres");
      return store;
    } catch (err) {
      log.error({ err }, "store: postgres unavailable, falling back to memory");
    }
  }
  const store = new MemoryStore({ isDemo: cfg.isDemo, network: cfg.network, bus, tickMs: cfg.demoTickMs });
  await store.init();
  log.info({ demo: cfg.isDemo }, "store: memory");
  return store;
}
