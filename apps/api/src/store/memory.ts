import { createHash, randomUUID } from "node:crypto";
import {
  createDemoWorld,
  demoStats,
  tickDemoWorld,
  type BuybackEvent,
  type CreditLedgerEntry,
  type DemoEvent,
  type DemoWorld,
  type HolderReward,
  type LaunchSummary,
  type Network,
  type PricePoint,
  type ProtocolStats,
  type SealedRevealEnvelope,
  type Trade,
  type WsEvent,
} from "@sealed/shared";
import type { EventBus } from "../events.js";
import { aggregateDaily, syntheticDaily } from "./daily.js";
import {
  bucketChart,
  matchesFilter,
  nowSec,
  publicLaunch,
  sortLaunches,
  type BidCommitInput,
  type ChartInterval,
  type LaunchFilter,
  type Store,
  type StoredReveal,
} from "./types.js";

interface PrivateBid {
  bidder: string;
  commitment: string;
  deposit: number;
  revealed: boolean;
}

export interface MemoryStoreOptions {
  isDemo: boolean;
  network: Network;
  bus: EventBus;
  tickMs?: number;
  /** Disable the 1s ticker (tests drive ticks manually). */
  autoTick?: boolean;
}

/**
 * In-memory store. In demo mode it is driven by the shared deterministic demo world, ticking every second and
 * publishing the resulting events. In non-demo mode without DATABASE_URL it starts empty and is filled by the indexer.
 */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  readonly world: DemoWorld;
  private bids = new Map<string, Map<string, PrivateBid>>(); // launchId → bidder → bid (never served)
  private reveals = new Map<string, StoredReveal>();
  private rewards = new Map<string, HolderReward>();
  private timer: NodeJS.Timeout | null = null;
  private snipers = new Set<string>();

  constructor(private opts: MemoryStoreOptions) {
    const now = nowSec();
    this.world = opts.isDemo
      ? createDemoWorld(now)
      : { launches: [], trades: {}, charts: {}, buybacks: [], ledger: [], rngState: 1, lastTickTs: now };
    if (!opts.isDemo) this.world.launches.forEach((l) => (l.network = opts.network));
  }

  async init(): Promise<void> {
    if (this.opts.isDemo && this.opts.autoTick !== false) {
      this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? 1000);
      this.timer.unref();
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Advance the demo world and publish mapped WS events. */
  tick(now = nowSec()): void {
    if (!this.opts.isDemo) return;
    let events: DemoEvent[];
    try {
      events = tickDemoWorld(this.world, now);
    } catch {
      return;
    }
    for (const ev of events) for (const w of mapDemoEvent(ev)) this.opts.bus.publish(w);
  }

  private find(idOrMint: string): LaunchSummary | undefined {
    return this.world.launches.find((l) => l.id === idOrMint || l.mint === idOrMint);
  }

  async listLaunches(filter: LaunchFilter) {
    const all = this.world.launches.filter((l) => matchesFilter(l, filter)).sort(sortLaunches);
    return { launches: all.slice(0, filter.limit).map(publicLaunch), total: all.length };
  }

  async getLaunch(idOrMint: string) {
    const l = this.find(idOrMint);
    return l ? publicLaunch(l) : null;
  }

  async upsertLaunch(launch: LaunchSummary): Promise<void> {
    const i = this.world.launches.findIndex((l) => l.id === launch.id);
    if (i >= 0) this.world.launches[i] = launch;
    else this.world.launches.push(launch);
  }

  async dueDrips(now: number) {
    return this.world.launches
      .filter((l) => (l.status === "live" || l.status === "flywheel") && l.vault && l.vault.nextDripTs > 0 && l.vault.nextDripTs <= now)
      .map(publicLaunch);
  }

  async getTrades(launchId: string, limit: number): Promise<Trade[]> {
    const l = this.find(launchId);
    if (!l) return [];
    return (this.world.trades[l.id] ?? []).slice(0, limit);
  }

  async addTrade(trade: Trade): Promise<void> {
    const list = this.world.trades[trade.launchId] ?? (this.world.trades[trade.launchId] = []);
    if (list.some((t) => t.id === trade.id)) return;
    list.unshift(trade);
    if (list.length > 200) list.length = 200;
    if (trade.isSniper) this.snipers.add(`${trade.launchId}:${trade.wallet}`);
  }

  async getChart(launchId: string, interval: ChartInterval): Promise<PricePoint[]> {
    const l = this.find(launchId);
    if (!l) return [];
    return bucketChart(this.world.charts[l.id] ?? [], interval);
  }

  async listBuybacks(opts: { launchId?: string; limit: number }): Promise<BuybackEvent[]> {
    const id = opts.launchId ? this.find(opts.launchId)?.id ?? opts.launchId : undefined;
    return this.world.buybacks.filter((b) => !id || b.launchId === id).slice(0, opts.limit);
  }

  async addBuyback(evt: BuybackEvent): Promise<void> {
    if (this.world.buybacks.some((b) => b.id === evt.id)) return;
    this.world.buybacks.unshift(evt);
    this.world.buybacks.sort((a, b) => b.ts - a.ts);
    if (this.world.buybacks.length > 500) this.world.buybacks.length = 500;
  }

  async listLedger(opts: { launchId?: string; limit: number }): Promise<CreditLedgerEntry[]> {
    const id = opts.launchId ? this.find(opts.launchId)?.id ?? opts.launchId : undefined;
    return this.world.ledger.filter((e) => !id || e.launchId === id).slice(0, opts.limit);
  }

  async addLedger(entry: CreditLedgerEntry): Promise<void> {
    if (this.world.ledger.some((e) => e.id === entry.id)) return;
    this.world.ledger.unshift(entry);
    this.world.ledger.sort((a, b) => b.ts - a.ts);
    if (this.world.ledger.length > 1000) this.world.ledger.length = 1000;
  }

  async getStats(): Promise<ProtocolStats> {
    const s = demoStats(this.world, nowSec());
    if (!this.opts.isDemo) {
      s.isDemo = false;
      s.network = this.opts.network;
      s.snipersBlocked = this.snipers.size;
    }
    return s;
  }

  async getDailyRevenue(days: number) {
    const now = nowSec();
    if (this.opts.isDemo) return syntheticDaily(await this.getStats(), days, now);
    return aggregateDaily(this.world.ledger, this.world.buybacks, days, now);
  }

  async getHolderReward(launch: LaunchSummary, wallet: string): Promise<HolderReward> {
    const key = `${launch.id}:${wallet}`;
    const existing = this.rewards.get(key);
    if (existing) return { ...existing };
    const sniper = this.snipers.has(key);
    if (!this.opts.isDemo || !launch.credit) {
      return { launchId: launch.id, wallet, staked: 0, claimable: 0, claimed: 0, quoteAsset: launch.quoteAsset, eligible: !sniper };
    }
    // Demo: deterministic per-wallet position so the Rewards panel has something to show.
    const h = createHash("sha256").update(key).digest();
    const share = (h.readUInt32BE(0) / 0xffffffff) * 0.004; // up to 0.4% of supply staked
    const eligible = h[4]! % 17 !== 0 && !sniper;
    const staked = Math.round(launch.totalSupply * share);
    const pool = launch.credit.holderPayouts;
    const claimed = eligible ? pool * share * 0.6 : 0;
    const claimable = eligible ? pool * share * 0.4 + (launch.credit.phase === "flywheel" ? (h[5]! / 255) * 0.02 * pool * share * 10 : 0) : 0;
    return { launchId: launch.id, wallet, staked, claimable, claimed, quoteAsset: launch.quoteAsset, eligible };
  }

  async recordBidCommit(input: BidCommitInput): Promise<LaunchSummary> {
    const l = this.find(input.launchId);
    if (!l) throw new Error("launch not found");
    const m = this.bids.get(l.id) ?? new Map<string, PrivateBid>();
    this.bids.set(l.id, m);
    const isNewWallet = !m.has(input.bidder);
    m.set(input.bidder, { bidder: input.bidder, commitment: input.commitment.toLowerCase(), deposit: input.deposit, revealed: false });
    l.auction.bidCount += 1;
    if (isNewWallet) l.auction.escrowedWallets += 1;
    l.auction.totalEscrowed += input.deposit;
    return publicLaunch(l);
  }

  async markBidRevealed(launchId: string, bidder: string): Promise<LaunchSummary | null> {
    const l = this.find(launchId);
    if (!l) return null;
    const bid = this.bids.get(l.id)?.get(bidder);
    if (bid && !bid.revealed) bid.revealed = true;
    l.auction.revealedCount = Math.min(l.auction.bidCount, l.auction.revealedCount + 1);
    return publicLaunch(l);
  }

  async saveReveal(env: SealedRevealEnvelope): Promise<StoredReveal> {
    const dup = [...this.reveals.values()].find((r) => r.launchId === env.launchId && r.bidder === env.bidder);
    const rec: StoredReveal = { ...env, id: dup?.id ?? randomUUID(), status: "pending", attempts: 0, txSignature: null, lastError: null, createdTs: nowSec() };
    this.reveals.set(rec.id, rec);
    return rec;
  }

  async listPendingReveals(): Promise<StoredReveal[]> {
    return [...this.reveals.values()].filter((r) => r.status === "pending");
  }

  async updateReveal(id: string, patch: Partial<Pick<StoredReveal, "status" | "attempts" | "txSignature" | "lastError">>): Promise<void> {
    const r = this.reveals.get(id);
    if (r) Object.assign(r, patch);
  }
}

/** Map shared demo-world events to the WS protocol. */
export function mapDemoEvent(ev: DemoEvent): WsEvent[] {
  switch (ev.kind) {
    case "trade":
      return [{ type: "trade", data: ev.trade }];
    case "drip":
      return [
        { type: "vault.drip", data: { ...ev.event, nextDripTs: ev.launch.vault?.nextDripTs ?? 0, vaultBalance: ev.launch.vault?.balance ?? 0 } },
        { type: "launch.updated", data: publicLaunch(ev.launch) },
      ];
    case "ledger":
      return [{ type: "credit.ledger", data: { ...ev.entry, repaidPct: ev.launch.credit?.repaidPct ?? 0 } }];
    case "phase":
      return [
        { type: "auction.phase_changed", data: { launchId: ev.launch.id, from: ev.from, to: ev.launch.status } },
        { type: "launch.updated", data: publicLaunch(ev.launch) },
      ];
    case "bid":
      return [
        {
          type: "auction.bid_committed",
          data: { launchId: ev.launch.id, bidCount: ev.launch.auction.bidCount, escrowedWallets: ev.launch.auction.escrowedWallets, totalEscrowed: ev.launch.auction.totalEscrowed },
        },
      ];
    case "flywheel":
      return [
        { type: "credit.flywheel_activated", data: { launchId: ev.launch.id, ts: Math.floor(Date.now() / 1000) } },
        { type: "launch.updated", data: publicLaunch(ev.launch) },
      ];
    default:
      return [];
  }
}
