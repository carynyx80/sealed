import type { FastifyBaseLogger } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { pdas, programId } from "@sealed/shared";
import type { AppContext } from "../context.js";
import { keypairFromSecret, loadProgram } from "../services/solana.js";
import { nowSec } from "../store/index.js";

export interface KeeperJob {
  kind: "distribute";
  launchId: string;
}

/**
 * Buyback keeper: polls launches whose `vault.nextDripTs ≤ now` and sends the permissionless
 * `execute_buyback_drip` followed by `distribute_fees`. Also drains `distribute` jobs queued by the indexer.
 * No-op in demo mode (the demo world simulates drips itself).
 */
export function startBuybackKeeper(ctx: AppContext, log: FastifyBaseLogger, intervalMs = 10_000): () => void {
  if (ctx.cfg.isDemo) return () => undefined;
  const keeper = keypairFromSecret(ctx.cfg.keeperSecretKey) ?? keypairFromSecret(ctx.cfg.relayerSecretKey);
  if (!keeper) {
    log.warn("keeper: KEEPER_SECRET_KEY not set — buyback keeper disabled");
    return () => undefined;
  }
  let running = false;
  const inflight = new Set<string>();

  const send = async (launchId: string, withDrip: boolean) => {
    if (inflight.has(launchId)) return;
    inflight.add(launchId);
    try {
      const loaded = await loadProgram(ctx.cfg, keeper);
      if (!loaded) return;
      const { program } = loaded;
      const pid = programId(ctx.cfg.programId);
      const launch = new PublicKey(launchId);
      const common = {
        keeper: keeper.publicKey,
        launch,
        buybackVault: pdas.vault(launch, pid)[0],
        pool: pdas.pool(launch, pid)[0],
        poolQuote: pdas.poolQuote(launch, pid)[0],
        poolToken: pdas.poolToken(launch, pid)[0],
        feeCollector: pdas.feeCollector(launch, pid)[0],
      };
      if (withDrip) {
        try {
          const sig: string = await program.methods.executeBuybackDrip().accountsPartial(common).rpc();
          log.info({ launch: launchId, sig }, "keeper: buyback drip executed");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/DripNotDue|VaultEmpty/.test(msg)) log.warn({ launch: launchId, err: msg }, "keeper: drip failed");
        }
      }
      try {
        const sig: string = await program.methods.distributeFees().accountsPartial(common).rpc();
        log.info({ launch: launchId, sig }, "keeper: fees distributed");
      } catch (err) {
        log.debug({ launch: launchId, err: err instanceof Error ? err.message : String(err) }, "keeper: distribute skipped");
      }
    } catch (err) {
      log.warn({ err }, "keeper: send error");
    } finally {
      inflight.delete(launchId);
    }
  };

  const loop = async () => {
    if (running) return;
    running = true;
    try {
      const due = await ctx.store.dueDrips(nowSec());
      for (const l of due) await send(l.id, true);
      for (let i = 0; i < 20; i++) {
        const job = await ctx.cache.dequeue<KeeperJob>("keeper");
        if (!job) break;
        if (job.kind === "distribute") await send(job.launchId, false);
      }
    } catch (err) {
      log.warn({ err }, "keeper: loop error");
    } finally {
      running = false;
    }
  };

  const t = setInterval(loop, intervalMs);
  t.unref();
  log.info({ keeper: keeper.publicKey.toBase58() }, "keeper: started");
  return () => clearInterval(t);
}
