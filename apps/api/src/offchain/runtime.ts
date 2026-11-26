import type { FastifyBaseLogger } from "fastify";
import { MIN_COMMIT_DURATION_SEC_DEVNET, MIN_COMMIT_DURATION_SEC_MAINNET } from "@sealed/shared";
import type { Cache } from "../cache/index.js";
import type { AppConfig } from "../config.js";
import type { EventBus } from "../events.js";
import type { RelayerKeys } from "../services/solana.js";
import { U64_MAX } from "./engine/common.js";
import { OffchainEngine } from "./engine/index.js";
import { Ledger, setDefaultLedger } from "./ledger.js";
import { MemoryRepo } from "./repo/memory.js";
import type { OffchainRepo } from "./repo/types.js";

export interface OffchainRuntime {
  repo: OffchainRepo;
  ledger: Ledger;
  engine: OffchainEngine;
}

export interface RuntimeOptions {
  cfg: AppConfig;
  bus: EventBus;
  cache: Cache;
  relayer: RelayerKeys;
  log: FastifyBaseLogger;
  /** Inject a repo (tests). */
  repo?: OffchainRepo;
  nowMs?: () => number;
}

/**
 * Build the offchain ledger/engine. Postgres when DATABASE_URL is set; memory only off-mainnet.
 * - NETWORK=mainnet + EXECUTION_MODE=offchain + no DATABASE_URL → throws (refuse to start).
 * - DATABASE_URL set but unreachable / schema not pushed: devnet → memory fallback (warn); mainnet → returns
 *   null so the API still boots (read-only demo/indexer routes), and trade routes answer 503.
 */
export async function createOffchainRuntime(o: RuntimeOptions): Promise<OffchainRuntime | null> {
  const { cfg, log } = o;
  const mainnet = cfg.network === "mainnet";
  if (mainnet && !cfg.databaseUrl && !o.repo) {
    throw new Error("EXECUTION_MODE=offchain on mainnet requires DATABASE_URL (the in-memory ledger is devnet/demo only)");
  }
  let repo: OffchainRepo | null = o.repo ?? null;
  if (!repo && cfg.databaseUrl) {
    try {
      const { PrismaRepo } = await import("./repo/prisma.js");
      const r = new PrismaRepo(cfg.databaseUrl);
      await r.init();
      repo = r;
      log.info("offchain ledger: postgres");
    } catch (err) {
      if (mainnet) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, "offchain ledger: postgres unavailable on mainnet — trading DISABLED until the DB/schema is ready");
        return null;
      }
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "offchain ledger: postgres unavailable — falling back to in-memory ledger (devnet only)");
    }
  }
  if (!repo) {
    repo = new MemoryRepo();
    await repo.init();
    if (!o.repo) log.info("offchain ledger: memory");
  }
  const ledger = new Ledger(repo);
  setDefaultLedger(ledger);
  const engine = new OffchainEngine({
    repo,
    ledger,
    bus: o.bus,
    cache: o.cache,
    network: cfg.network,
    relayerBox: o.relayer.box,
    relayerBoxPubB64: o.relayer.boxPubkeyB64,
    maxCreditPerLaunch: U64_MAX,
    minCommitSec: mainnet ? MIN_COMMIT_DURATION_SEC_MAINNET : MIN_COMMIT_DURATION_SEC_DEVNET,
    nowMs: o.nowMs ?? (() => Date.now()),
    log,
  });
  return { repo, ledger, engine };
}

/** Phase scheduler worker: commit→reveal→clear→graduate→live→flywheel, auto-reveals, drips, fee distribution. */
export function startOffchainScheduler(engine: OffchainEngine, log: FastifyBaseLogger, intervalMs: number): () => void {
  let running = false;
  const loop = async () => {
    if (running) return;
    running = true;
    try {
      await engine.tick();
    } catch (err) {
      log.warn({ err }, "offchain scheduler: tick failed");
    } finally {
      running = false;
    }
  };
  const t = setInterval(loop, intervalMs);
  t.unref();
  log.info({ intervalMs }, "offchain scheduler: started");
  return () => clearInterval(t);
}
