import type { BuybackEvent, CreditLedgerEntry, HolderReward, LaunchSummary, ProtocolStats, SealedRevealEnvelope, Trade } from "@sealed/shared";
import { matchesFilter, nowSec, publicLaunch, sortLaunches, type BidCommitInput, type ChartInterval, type LaunchFilter, type Store, type StoredReveal } from "../store/types.js";
import { EngineError } from "./engine/common.js";
import type { OffchainEngine } from "./engine/index.js";

/**
 * Read model that keeps every existing GET route + WS snapshot working across three sources:
 *   1. the in-memory DEMO world (when DEMO_MODE=true) — always present in demo mode, even when the primary store
 *      is Postgres (otherwise an empty DB hides the demo lobby), flagged isDemo=true;
 *   2. the primary store (Postgres or memory; on-chain indexer data);
 *   3. real OFFCHAIN launches from the ledger engine, flagged isDemo=false.
 * Writes from the on-chain indexer go to the primary store; offchain launches are written only by the engine.
 */
export class CompositeStore implements Store {
  constructor(
    private base: Store,
    private demo: Store | null,
    private engine: OffchainEngine | null,
  ) {}

  get kind() {
    return this.base.kind;
  }

  async init() {
    await this.demo?.init();
  }
  async close() {
    await this.demo?.close().catch(() => undefined);
    await this.base.close();
  }

  private sources(): Store[] {
    return this.demo ? [this.demo, this.base] : [this.base];
  }

  /** Which source owns a launch id/mint. */
  private async owner(idOrMint: string): Promise<{ kind: "offchain" } | { kind: "store"; store: Store; launch: LaunchSummary } | null> {
    if (this.engine && (await this.engine.isOffchain(idOrMint))) return { kind: "offchain" };
    for (const s of this.sources()) {
      const l = await s.getLaunch(idOrMint);
      if (l) return { kind: "store", store: s, launch: l };
    }
    return null;
  }

  async listLaunches(filter: LaunchFilter) {
    const parts = await Promise.all(this.sources().map((s) => s.listLaunches({ ...filter, limit: 200 })));
    let all = parts.flatMap((p) => p.launches);
    let total = parts.reduce((a, p) => a + p.total, 0);
    if (this.engine) {
      const off = (await this.engine.listSummaries()).filter((l) => matchesFilter(l, filter));
      all = all.concat(off);
      total += off.length;
    }
    const seen = new Set<string>();
    all = all.filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
    return { launches: all.sort(sortLaunches).slice(0, filter.limit).map(publicLaunch), total };
  }

  async getLaunch(idOrMint: string) {
    if (this.engine) {
      const s = await this.engine.getSummary(idOrMint);
      if (s) return publicLaunch(s);
    }
    for (const s of this.sources()) {
      const l = await s.getLaunch(idOrMint);
      if (l) return l;
    }
    return null;
  }

  upsertLaunch(launch: LaunchSummary) {
    return this.base.upsertLaunch(launch);
  }
  dueDrips(now: number) {
    return this.base.dueDrips(now);
  }

  async getTrades(launchId: string, limit: number): Promise<Trade[]> {
    const o = await this.owner(launchId);
    if (!o) return [];
    return o.kind === "offchain" ? this.engine!.getTrades(launchId, limit) : o.store.getTrades(o.launch.id, limit);
  }
  addTrade(trade: Trade) {
    return this.base.addTrade(trade);
  }
  async getChart(launchId: string, interval: ChartInterval) {
    const o = await this.owner(launchId);
    if (!o) return [];
    return o.kind === "offchain" ? this.engine!.getChart(launchId, interval) : o.store.getChart(o.launch.id, interval);
  }

  async listBuybacks(opts: { launchId?: string; limit: number }): Promise<BuybackEvent[]> {
    if (opts.launchId) {
      const o = await this.owner(opts.launchId);
      if (!o) return [];
      return o.kind === "offchain" ? this.engine!.listBuybacks(opts) : o.store.listBuybacks({ ...opts, launchId: o.launch.id });
    }
    const parts = await Promise.all([...this.sources().map((s) => s.listBuybacks(opts)), this.engine ? this.engine.listBuybacks(opts) : Promise.resolve([])]);
    return parts.flat().sort((a, b) => b.ts - a.ts).slice(0, opts.limit);
  }
  addBuyback(evt: BuybackEvent) {
    return this.base.addBuyback(evt);
  }
  async listLedger(opts: { launchId?: string; limit: number }): Promise<CreditLedgerEntry[]> {
    if (opts.launchId) {
      const o = await this.owner(opts.launchId);
      if (!o) return [];
      return o.kind === "offchain" ? this.engine!.listLedger(opts) : o.store.listLedger({ ...opts, launchId: o.launch.id });
    }
    const parts = await Promise.all([...this.sources().map((s) => s.listLedger(opts)), this.engine ? this.engine.listLedger(opts) : Promise.resolve([])]);
    return parts.flat().sort((a, b) => b.ts - a.ts).slice(0, opts.limit);
  }
  addLedger(entry: CreditLedgerEntry) {
    return this.base.addLedger(entry);
  }

  async getStats(): Promise<ProtocolStats> {
    const s = await (this.demo ?? this.base).getStats();
    if (!this.engine) return s;
    const d = await this.engine.statsDelta();
    return {
      ...s,
      totalVolumeUsd: s.totalVolumeUsd + d.totalVolumeUsd,
      totalFeesUsd: s.totalFeesUsd + d.totalFeesUsd,
      activeBuybackCreditUsd: s.activeBuybackCreditUsd + d.activeBuybackCreditUsd,
      totalCreditDeployedUsd: s.totalCreditDeployedUsd + d.totalCreditDeployedUsd,
      totalCreditRepaidUsd: s.totalCreditRepaidUsd + d.totalCreditRepaidUsd,
      totalTokensBurnedUsd: s.totalTokensBurnedUsd + d.totalTokensBurnedUsd,
      holderPayoutsUsd: s.holderPayoutsUsd + d.holderPayoutsUsd,
      liveAuctions: s.liveAuctions + d.liveAuctions,
      activeVaults: s.activeVaults + d.activeVaults,
      graduatedFlywheels: s.graduatedFlywheels + d.graduatedFlywheels,
      snipersBlocked: s.snipersBlocked + d.snipersBlocked,
      updatedTs: nowSec(),
    };
  }
  getDailyRevenue(days: number) {
    return (this.demo ?? this.base).getDailyRevenue(days);
  }
  async getHolderReward(launch: LaunchSummary, wallet: string): Promise<HolderReward> {
    if (this.engine) {
      const r = await this.engine.holderReward(launch.id, wallet);
      if (r) return r;
    }
    const o = await this.owner(launch.id);
    return (o && o.kind === "store" ? o.store : this.base).getHolderReward(launch, wallet);
  }

  async recordBidCommit(input: BidCommitInput) {
    const o = await this.owner(input.launchId);
    if (!o) throw new EngineError(404, "launch not found");
    if (o.kind === "offchain") throw new EngineError(409, "offchain launch: commit via POST /api/trade/commit");
    return o.store.recordBidCommit(input);
  }
  async markBidRevealed(launchId: string, bidder: string) {
    const o = await this.owner(launchId);
    if (!o || o.kind === "offchain") return null;
    return o.store.markBidRevealed(launchId, bidder);
  }

  async saveReveal(env: SealedRevealEnvelope): Promise<StoredReveal> {
    const o = await this.owner(env.launchId);
    if (o?.kind === "offchain") {
      const bid = await this.engine!.attachSealedReveal(env);
      return { ...env, id: bid.id, status: "pending", attempts: 0, txSignature: null, lastError: null, createdTs: nowSec() };
    }
    return (o?.kind === "store" ? o.store : this.base).saveReveal(env);
  }
  async listPendingReveals() {
    return (await Promise.all(this.sources().map((s) => s.listPendingReveals()))).flat();
  }
  async updateReveal(id: string, patch: Parameters<Store["updateReveal"]>[1]) {
    for (const s of this.sources()) await s.updateReveal(id, patch);
  }
}
