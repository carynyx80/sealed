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
import { tradeRoutes } from "./routes/trade.js";
import { accountRoutes } from "./routes/account.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { custodyRoutes } from "./routes/custody.js";
import { rpcProxyRoutes, type RpcProxyOptions } from "./routes/rpc.js";
import { buildCustody, type CustodyDeps, type CustodyRuntime } from "./offchain/custody/index.js";
import { CompositeStore } from "./offchain/readModel.js";
import { createOffchainRuntime, startOffchainScheduler } from "./offchain/runtime.js";
import { MemoryStore } from "./store/index.js";
import type { OffchainRepo } from "./offchain/repo/types.js";

export interface BuildOptions {
  config?: AppConfig;
  /** Inject a store (tests). */
  store?: Store;
  cache?: Cache;
  logger?: boolean | object;
  /** Start background workers (relayer / indexer / keeper). Defaults to cfg.workersEnabled. */
  workers?: boolean;
  /** Custody overrides (tests: mock RPC / repo / keys). */
  custody?: CustodyDeps;
  /** Inject the offchain ledger repo (tests: in-memory ledger, also on NETWORK=mainnet). */
  offchainRepo?: OffchainRepo;
  /** RPC proxy overrides (tests: mocked upstream). */
  rpcProxy?: RpcProxyOptions;
}

export type App = FastifyInstance & { ctx: AppContext; hub: WsHub; custody: CustodyRuntime };

export async function buildServer(opts: BuildOptions = {}): Promise<App> {
  const cfg = opts.config ?? loadConfig();
  const pretty = cfg.nodeEnv === "development" && process.stdout.isTTY;
  const logger =
    opts.logger ?? (pretty ? { level: cfg.logLevel, transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } } : { level: cfg.logLevel });
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 256 * 1024 });

  for (const msg of cfg.startupErrors ?? []) app.log.error(`CONFIG ERROR: ${msg}`);
  if (cfg.network === "mainnet") app.log.warn({ demo: cfg.isDemo, mode: cfg.executionMode }, "MAINNET: real funds — demo world disabled, test hooks disabled, live prices for withdrawal limits");
  const bus = new EventBus();
  const baseStore = opts.store ?? (await createStore(cfg, bus, app.log));
  const cache = opts.cache ?? (await createCache(cfg.redisUrl, app.log));
  const relayer = loadRelayerKeys(cfg);
  // Offchain custodial engine + composite read model (demo world ∪ primary store ∪ offchain launches).
  const offchain = cfg.executionMode === "offchain" ? await createOffchainRuntime({ cfg, bus, cache, relayer, log: app.log, repo: opts.offchainRepo }) : null;
  const demoStore = cfg.isDemo && cfg.network !== "mainnet" && baseStore.kind !== "memory" ? new MemoryStore({ isDemo: true, network: cfg.network, bus, tickMs: cfg.demoTickMs }) : null;
  const store: Store = offchain || demoStore ? new CompositeStore(baseStore, demoStore, offchain?.engine ?? null) : baseStore;
  if (store !== baseStore) await store.init();
  if (relayer.ephemeral && !cfg.isDemo) app.log.warn("relayer: RELAYER_BOX_SEED / RELAYER_SECRET_KEY not set — using ephemeral keys (reveals will not survive restarts)");
  const ctx: AppContext = { cfg, store, cache, bus, relayer, startedAt: Date.now(), offchain };
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
  const custody = await buildCustody(cfg, ctx.offchain?.ledger ?? null, app.log, opts.custody);
  await authRoutes(app, ctx, custody);
  await accountRoutes(app, ctx, custody);
  await custodyRoutes(app, ctx, custody);
  await adminRoutes(app, ctx, custody);
  await tradeRoutes(app, ctx);
  await rpcProxyRoutes(app, ctx, opts.rpcProxy);
  await registerWs(app, hub);

  hub.start();
  const stops: Array<() => void> = [];
  if (opts.workers ?? cfg.workersEnabled) {
    stops.push(startRevealRelayer(ctx, app.log));
    stops.push(startBuybackKeeper(ctx, app.log));
    if (custody.config.workers) stops.push(custody.start());
    if (offchain) stops.push(startOffchainScheduler(offchain.engine, app.log, cfg.offchainTickMs));
    startIndexer(ctx, app.log).then((s) => stops.push(s)).catch((err) => app.log.error({ err }, "indexer failed to start"));
  }

  app.addHook("onClose", async () => {
    stops.forEach((s) => s());
    await custody.close();
    hub.stop();
    await store.close().catch(() => undefined);
    await offchain?.repo.close().catch(() => undefined);
    await cache.close().catch(() => undefined);
  });

  return Object.assign(app, { ctx, hub, custody }) as App;
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
