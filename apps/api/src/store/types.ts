import type {
  BuybackEvent,
  CreditLedgerEntry,
  HolderReward,
  LaunchStatus,
  LaunchSummary,
  PricePoint,
  ProtocolStats,
  QuoteAssetSymbol,
  RevenueResponse,
  SealedRevealEnvelope,
  Trade,
} from "@sealed/shared";
import { STOCK_QUOTE_ASSETS } from "@sealed/shared";

export interface LaunchFilter {
  status?: LaunchStatus | "auctions" | "vaults" | "graduated";
  quote?: QuoteAssetSymbol | "stocks" | "all";
  limit: number;
}

export type ChartInterval = "1m" | "5m" | "1h";

export interface StoredReveal extends SealedRevealEnvelope {
  id: string;
  status: "pending" | "submitted" | "failed";
  attempts: number;
  txSignature: string | null;
  lastError: string | null;
  createdTs: number;
}

export interface BidCommitInput {
  launchId: string;
  bidder: string;
  commitment: string;
  deposit: number;
}

/** Persistence boundary. MemoryStore (demo world) and PrismaStore (Postgres) implement it. */
export interface Store {
  readonly kind: "memory" | "postgres";
  init(): Promise<void>;
  close(): Promise<void>;

  listLaunches(filter: LaunchFilter): Promise<{ launches: LaunchSummary[]; total: number }>;
  getLaunch(idOrMint: string): Promise<LaunchSummary | null>;
  upsertLaunch(launch: LaunchSummary): Promise<void>;
  /** Launches whose buyback drip is due (vault.nextDripTs > 0 && ≤ now). */
  dueDrips(nowSec: number): Promise<LaunchSummary[]>;

  getTrades(launchId: string, limit: number): Promise<Trade[]>;
  addTrade(trade: Trade): Promise<void>;
  getChart(launchId: string, interval: ChartInterval): Promise<PricePoint[]>;

  listBuybacks(opts: { launchId?: string; limit: number }): Promise<BuybackEvent[]>;
  addBuyback(evt: BuybackEvent): Promise<void>;
  listLedger(opts: { launchId?: string; limit: number }): Promise<CreditLedgerEntry[]>;
  addLedger(entry: CreditLedgerEntry): Promise<void>;

  getStats(): Promise<ProtocolStats>;
  getDailyRevenue(days: number): Promise<RevenueResponse["daily"]>;
  getHolderReward(launch: LaunchSummary, wallet: string): Promise<HolderReward>;

  /** Private: commitment + deposit only. Returns updated public launch aggregates. */
  recordBidCommit(input: BidCommitInput): Promise<LaunchSummary>;
  /** Mark one bid revealed; returns updated launch. */
  markBidRevealed(launchId: string, bidder: string): Promise<LaunchSummary | null>;

  saveReveal(env: SealedRevealEnvelope): Promise<StoredReveal>;
  listPendingReveals(): Promise<StoredReveal[]>;
  updateReveal(id: string, patch: Partial<Pick<StoredReveal, "status" | "attempts" | "txSignature" | "lastError">>): Promise<void>;
}

const STOCKS = new Set<string>(STOCK_QUOTE_ASSETS.map((q) => q.symbol));

export function statusesFor(status: LaunchFilter["status"]): LaunchStatus[] | null {
  if (!status) return null;
  if (status === "auctions") return ["commit", "reveal", "clearing"];
  if (status === "vaults") return ["live"];
  if (status === "graduated") return ["flywheel"];
  return [status];
}

export function matchesFilter(l: LaunchSummary, filter: LaunchFilter): boolean {
  const statuses = statusesFor(filter.status);
  if (statuses && !statuses.includes(l.status)) return false;
  const q = filter.quote;
  if (q && q !== "all") {
    if (q === "stocks") {
      if (!STOCKS.has(l.quoteAsset)) return false;
    } else if (l.quoteAsset !== q) return false;
  }
  return true;
}

/** Live auctions first (soonest deadline), then vaults by volume, then flywheels, then everything else. */
export function sortLaunches(a: LaunchSummary, b: LaunchSummary): number {
  const rank = (l: LaunchSummary) => ({ commit: 0, reveal: 0, clearing: 1, live: 2, flywheel: 3, failed: 4 })[l.status];
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return deadline(a) - deadline(b);
  return (b.market?.volume24h ?? 0) - (a.market?.volume24h ?? 0) || b.createdTs - a.createdTs;
}

function deadline(l: LaunchSummary) {
  return l.status === "reveal" ? l.auction.revealEndTs : l.auction.commitEndTs;
}

/**
 * Privacy invariant: never return anything beyond public aggregates for launches still in commit/reveal.
 * LaunchSummary carries no per-bid data; this additionally blanks clearing results until the auction clears.
 */
export function publicLaunch(l: LaunchSummary): LaunchSummary {
  const copy: LaunchSummary = structuredClone(l);
  if (copy.status === "commit" || copy.status === "reveal" || copy.status === "clearing") {
    copy.auction.clearingPrice = null;
    copy.auction.totalRaised = null;
  }
  return copy;
}

/** Bucket raw price points into the requested interval (OHLC-close style). */
export function bucketChart(points: PricePoint[], interval: ChartInterval): PricePoint[] {
  const size = interval === "1h" ? 3600 : interval === "5m" ? 300 : 60;
  const out: PricePoint[] = [];
  for (const p of points) {
    const b = Math.floor(p.ts / size) * size;
    const last = out[out.length - 1];
    if (last && last.ts === b) {
      last.price = p.price;
      last.volume += p.volume;
    } else out.push({ ts: b, price: p.price, volume: p.volume });
  }
  return out;
}

export const nowSec = () => Math.floor(Date.now() / 1000);
