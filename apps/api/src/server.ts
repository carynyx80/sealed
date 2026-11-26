import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCache, type Cache } from "./cache/index.js";
import { loadConfig, type AppConfig } from "./config.js";
import { sendError, type AppContext } from "./context.js";
import { EventBus } from "./events.js";
import { auctionRoutes } from "./routes/auctions.js";
import { healthRoutes } from "./routes/health.js";
import { launchRoutes } from "./routes/launches.js";
import { llmsRoutes } from "./routes/llms.js";
import { privacyRoutes } from "./routes/privacy.js";
import { relayerRoutes } from "./routes/relayer.js";
import { revenueRoutes } from "./routes/revenue.js";
import { rewardRoutes } from "./routes/rewards.js";
import { statsRoutes } from "./routes/stats.js";
import { vaultRoutes } from "./routes/vaults.js";
import { loadRelayerKeys } from "./services/solana.js";
import { createStore, type Store } from "./store/index.js";
import { startBuybackKeeper } from "./workers/buybackKeeper.js";
import { startIndexer } from "./workers/indexer.js";
import { startRevealRelayer } from "./workers/revealRelayer.js";
import { WsHub, registerWs } from "./ws/hub.js";

export interface BuildOptions {
  config?: AppConfig;
  /** Inject a store (tests). */
  store?: Store;
  cache?: Cache;
  logger?: boolean | object;
  /** Start background workers (relayer / indexer / keeper). Defaults to cfg.workersEnabled. */
  workers?: boolean;
}

export type App = FastifyInstance & { ctx: AppContext; hub: WsHub };

export async function buildServer(opts: BuildOptions = {}): Promise<App> {
  const cfg = opts.config ?? loadConfig();
  const pretty = cfg.nodeEnv === "development" && process.stdout.isTTY;
  const logger =
    opts.logger ?? (pretty ? { level: cfg.logLevel, transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } } : { level: cfg.logLevel });
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 256 * 1024 });

  const bus = new EventBus();
  const store = opts.store ?? (await createStore(cfg, bus, app.log));
  const cache = opts.cache ?? (await createCache(cfg.redisUrl, app.log));
  const relayer = loadRelayerKeys(cfg);
  if (relayer.ephemeral && !cfg.isDemo) app.log.warn("relayer: RELAYER_BOX_SEED / RELAYER_SECRET_KEY not set — using ephemeral keys (reveals will not survive restarts)");
  const ctx: AppContext = { cfg, store, cache, bus, relayer, startedAt: Date.now() };
  const hub = new WsHub(ctx, app.log);

  await app.register(cors, { origin: cfg.corsOrigin, methods: ["GET", "POST", "OPTIONS"] });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (code >= 500) app.log.error({ err }, "request failed");
    return sendError(reply, code, code >= 500 ? "internal error" : err.message);
  });
  app.setNotFoundHandler((req, reply) => sendError(reply, 404, `route not found: ${req.method} ${req.url.split("?")[0]}`));

  app.get("/", async () => ({ name: "sealed-launchpad-api", docs: "/llms.txt", health: "/api/health", ws: "/ws" }));
  await healthRoutes(app, ctx);
  await statsRoutes(app, ctx);
  await launchRoutes(app, ctx);
  await auctionRoutes(app, ctx);
  await vaultRoutes(app, ctx);
  await rewardRoutes(app, ctx);
  await revenueRoutes(app, ctx);
  await relayerRoutes(app, ctx);
  await privacyRoutes(app, ctx);
  await llmsRoutes(app, ctx);
  await registerWs(app, hub);

  hub.start();
  const stops: Array<() => void> = [];
  if (opts.workers ?? cfg.workersEnabled) {
    stops.push(startRevealRelayer(ctx, app.log));
    stops.push(startBuybackKeeper(ctx, app.log));
    startIndexer(ctx, app.log).then((s) => stops.push(s)).catch((err) => app.log.error({ err }, "indexer failed to start"));
  }

  app.addHook("onClose", async () => {
    stops.forEach((s) => s());
    hub.stop();
    await store.close().catch(() => undefined);
    await cache.close().catch(() => undefined);
  });

  return Object.assign(app, { ctx, hub }) as App;
}

async function main() {
  const cfg = loadConfig();
  const app = await buildServer({ config: cfg });
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down");
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await app.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => app.log.error({ err }, "unhandled rejection"));
  await app.listen({ port: cfg.port, host: cfg.host });
  app.log.info({ demo: cfg.isDemo, network: cfg.network, db: app.ctx.store.kind, cache: app.ctx.cache.kind }, "sealed-launchpad api ready");
}

const isEntry = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
