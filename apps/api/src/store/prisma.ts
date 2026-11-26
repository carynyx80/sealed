import type { Prisma, PrismaClient, Launch as LaunchRow } from "@prisma/client";
import type {
  BuybackEvent,
  CreditLedgerEntry,
  CreditState,
  HolderReward,
  LaunchStatus,
  LaunchSummary,
  MarketState,
  Network,
  PricePoint,
  ProtocolStats,
  QuoteAssetSymbol,
  SealedRevealEnvelope,
  Trade,
  VaultState,
} from "@sealed/shared";
import { QUOTE_ASSETS, STOCK_QUOTE_ASSETS } from "@sealed/shared";
import { aggregateDaily } from "./daily.js";
import { bucketChart, nowSec, publicLaunch, sortLaunches, statusesFor, type BidCommitInput, type ChartInterval, type LaunchFilter, type Store, type StoredReveal } from "./types.js";

/** Postgres-backed store (selected when DATABASE_URL is set). Populated by the indexer from on-chain state. */
export class PrismaStore implements Store {
  readonly kind = "postgres" as const;
  private db!: PrismaClient;
  private jsonNull: unknown = null;

  constructor(private url: string, private network: Network, private isDemo: boolean) {}

  async init(): Promise<void> {
    type Mod = { PrismaClient: typeof PrismaClient; Prisma: { JsonNull: unknown } };
    const raw = (await import("@prisma/client")) as unknown as Partial<Mod> & { default?: Mod };
    const mod = (raw.PrismaClient ? raw : raw.default!) as Mod;
    const Ctor = mod.PrismaClient;
    this.jsonNull = mod.Prisma.JsonNull;
    this.db = new Ctor({ datasources: { db: { url: this.url } } });
    await this.db.$connect();
  }

  async close(): Promise<void> {
    await this.db?.$disconnect();
  }

  private where(filter: LaunchFilter): Prisma.LaunchWhereInput {
    const w: Prisma.LaunchWhereInput = {};
    const statuses = statusesFor(filter.status);
    if (statuses) w.status = { in: statuses };
    const q = filter.quote;
    if (q && q !== "all") w.quoteAsset = q === "stocks" ? { in: STOCK_QUOTE_ASSETS.map((s) => s.symbol) } : q;
    return w;
  }

  async listLaunches(filter: LaunchFilter) {
    const where = this.where(filter);
    const [rows, total] = await Promise.all([this.db.launch.findMany({ where, take: 500, orderBy: { createdTs: "desc" } }), this.db.launch.count({ where })]);
    const launches = rows.map(toDto).sort(sortLaunches).slice(0, filter.limit).map(publicLaunch);
    return { launches, total };
  }

  async getLaunch(idOrMint: string) {
    const row = await this.db.launch.findFirst({ where: { OR: [{ id: idOrMint }, { mint: idOrMint }] } });
    return row ? publicLaunch(toDto(row)) : null;
  }

  async upsertLaunch(l: LaunchSummary): Promise<void> {
    const data = fromDto(l, this.jsonNull);
    await this.db.launch.upsert({ where: { id: l.id }, create: data, update: data });
  }

  async dueDrips(now: number) {
    const rows = await this.db.launch.findMany({ where: { status: { in: ["live", "flywheel"] }, nextDripTs: { gt: 0, lte: now } }, take: 50 });
    return rows.map(toDto).map(publicLaunch);
  }

  private async resolveId(idOrMint: string): Promise<string | null> {
    const row = await this.db.launch.findFirst({ where: { OR: [{ id: idOrMint }, { mint: idOrMint }] }, select: { id: true } });
    return row?.id ?? null;
  }

  async getTrades(launchId: string, limit: number): Promise<Trade[]> {
    const id = await this.resolveId(launchId);
    if (!id) return [];
    const rows = await this.db.trade.findMany({ where: { launchId: id }, orderBy: { ts: "desc" }, take: limit });
    return rows.map((t) => ({ ...t, side: t.side as Trade["side"] }));
  }

  async addTrade(t: Trade): Promise<void> {
    await this.db.trade.upsert({ where: { id: t.id }, create: t, update: {} });
  }

  async getChart(launchId: string, interval: ChartInterval): Promise<PricePoint[]> {
    const id = await this.resolveId(launchId);
    if (!id) return [];
    const since = nowSec() - (interval === "1h" ? 14 * 86400 : interval === "5m" ? 2 * 86400 : 6 * 3600);
    const rows = await this.db.trade.findMany({ where: { launchId: id, ts: { gte: since } }, orderBy: { ts: "asc" }, select: { ts: true, price: true, amountQuote: true } });
    return bucketChart(rows.map((r) => ({ ts: r.ts, price: r.price, volume: r.amountQuote })), interval);
  }

  async listBuybacks(opts: { launchId?: string; limit: number }): Promise<BuybackEvent[]> {
    const id = opts.launchId ? await this.resolveId(opts.launchId) : undefined;
    const rows = await this.db.buybackEvent.findMany({ where: id ? { launchId: id } : {}, orderBy: { ts: "desc" }, take: opts.limit });
    return rows.map((r) => ({ ...r, quoteAsset: r.quoteAsset as QuoteAssetSymbol }));
  }

  async addBuyback(e: BuybackEvent): Promise<void> {
    await this.db.buybackEvent.upsert({ where: { id: e.id }, create: e, update: {} });
  }

  async listLedger(opts: { launchId?: string; limit: number }): Promise<CreditLedgerEntry[]> {
    const id = opts.launchId ? await this.resolveId(opts.launchId) : undefined;
    const rows = await this.db.creditLedger.findMany({ where: id ? { launchId: id } : {}, orderBy: { ts: "desc" }, take: opts.limit });
    return rows.map((r) => ({ ...r, kind: r.kind as CreditLedgerEntry["kind"], quoteAsset: r.quoteAsset as QuoteAssetSymbol }));
  }

  async addLedger(e: CreditLedgerEntry): Promise<void> {
    await this.db.creditLedger.upsert({ where: { id: e.id }, create: e, update: {} });
  }

  async getStats(): Promise<ProtocolStats> {
    const rows = (await this.db.launch.findMany()).map(toDto);
    let vol = 0, fees = 0, active = 0, deployed = 0, repaid = 0, burned = 0, holder = 0;
    let live = 0, vaults = 0, fly = 0;
    for (const l of rows) {
      const px = QUOTE_ASSETS[l.quoteAsset]?.demoUsdPrice ?? 0;
      if (l.status === "commit" || l.status === "reveal") live++;
      if (l.status === "live") vaults++;
      if (l.status === "flywheel") fly++;
      if (l.credit && l.vault) {
        vol += (l.credit.feesCollected / 0.01) * px;
        fees += l.credit.feesCollected * px;
        active += l.vault.balance * px;
        deployed += l.credit.creditLine * px;
        repaid += l.credit.repaid * px;
        burned += l.vault.quoteSpent * px;
        holder += l.credit.holderPayouts * px;
      }
    }
    const snipers = await this.db.trade.count({ where: { isSniper: true } });
    const stored = await this.db.protocolStats.findUnique({ where: { id: 1 } });
    const outstanding = deployed - repaid;
    const stats: ProtocolStats = {
      totalVolumeUsd: vol, totalFeesUsd: fees, activeBuybackCreditUsd: active, totalCreditDeployedUsd: deployed, totalCreditRepaidUsd: repaid,
      solvencyRatio: stored?.solvencyRatio ?? (outstanding > 0 ? Math.min(99, deployed / outstanding) : 99),
      totalTokensBurnedUsd: burned, platformTokensBurned: stored?.platformTokensBurned ?? 0, holderPayoutsUsd: holder,
      liveAuctions: live, activeVaults: vaults, graduatedFlywheels: fly, snipersBlocked: Math.max(snipers, stored?.snipersBlocked ?? 0),
      network: this.network, isDemo: this.isDemo, updatedTs: nowSec(),
    };
    return stats;
  }

  async getDailyRevenue(days: number) {
    const since = nowSec() - days * 86400;
    const [ledger, buybacks] = await Promise.all([
      this.db.creditLedger.findMany({ where: { ts: { gte: since } } }),
      this.db.buybackEvent.findMany({ where: { ts: { gte: since } } }),
    ]);
    return aggregateDaily(
      ledger.map((r) => ({ ...r, kind: r.kind as CreditLedgerEntry["kind"], quoteAsset: r.quoteAsset as QuoteAssetSymbol })),
      buybacks.map((r) => ({ ...r, quoteAsset: r.quoteAsset as QuoteAssetSymbol })),
      days,
      nowSec(),
    );
  }

  async getHolderReward(launch: LaunchSummary, wallet: string): Promise<HolderReward> {
    const row = await this.db.holderReward.findUnique({ where: { launchId_wallet: { launchId: launch.id, wallet } } });
    if (row) return { ...row, quoteAsset: row.quoteAsset as QuoteAssetSymbol };
    const sniper = await this.db.trade.count({ where: { launchId: launch.id, wallet, isSniper: true } });
    return { launchId: launch.id, wallet, staked: 0, claimable: 0, claimed: 0, quoteAsset: launch.quoteAsset, eligible: sniper === 0 };
  }

  async recordBidCommit(input: BidCommitInput): Promise<LaunchSummary> {
    const existing = await this.db.bid.findUnique({ where: { launchId_bidder: { launchId: input.launchId, bidder: input.bidder } } });
    await this.db.bid.upsert({
      where: { launchId_bidder: { launchId: input.launchId, bidder: input.bidder } },
      create: { launchId: input.launchId, bidder: input.bidder, commitment: input.commitment.toLowerCase(), deposit: input.deposit },
      update: { commitment: input.commitment.toLowerCase(), deposit: input.deposit },
    });
    const row = await this.db.launch.update({
      where: { id: input.launchId },
      data: { bidCount: { increment: 1 }, escrowedWallets: { increment: existing ? 0 : 1 }, totalEscrowed: { increment: input.deposit } },
    });
    return publicLaunch(toDto(row));
  }

  async markBidRevealed(launchId: string, bidder: string): Promise<LaunchSummary | null> {
    const res = await this.db.bid.updateMany({ where: { launchId, bidder, revealed: false }, data: { revealed: true } });
    const row = res.count
      ? await this.db.launch.update({ where: { id: launchId }, data: { revealedCount: { increment: 1 } } })
      : await this.db.launch.findUnique({ where: { id: launchId } });
    return row ? publicLaunch(toDto(row)) : null;
  }

  async saveReveal(env: SealedRevealEnvelope): Promise<StoredReveal> {
    const { version: _v, ...fields } = env;
    const row = await this.db.revealPayload.upsert({
      where: { launchId_bidder: { launchId: env.launchId, bidder: env.bidder } },
      create: fields,
      update: { ...fields, status: "pending", attempts: 0, lastError: null, txSignature: null },
    });
    return toReveal(row);
  }

  async listPendingReveals(): Promise<StoredReveal[]> {
    const rows = await this.db.revealPayload.findMany({ where: { status: "pending" }, take: 500 });
    return rows.map(toReveal);
  }

  async updateReveal(id: string, patch: Partial<Pick<StoredReveal, "status" | "attempts" | "txSignature" | "lastError">>): Promise<void> {
    await this.db.revealPayload.update({ where: { id }, data: { ...patch, submittedAt: patch.status === "submitted" ? new Date() : undefined } });
  }
}

function toReveal(r: { id: string; launchId: string; bidder: string; commitment: string; relayerPubkey: string; ephemeralPubkey: string; nonce: string; ciphertext: string; signature: string; status: string; attempts: number; txSignature: string | null; lastError: string | null; createdAt: Date }): StoredReveal {
  return {
    version: 1, id: r.id, launchId: r.launchId, bidder: r.bidder, commitment: r.commitment, relayerPubkey: r.relayerPubkey, ephemeralPubkey: r.ephemeralPubkey,
    nonce: r.nonce, ciphertext: r.ciphertext, signature: r.signature, status: r.status as StoredReveal["status"], attempts: r.attempts,
    txSignature: r.txSignature, lastError: r.lastError, createdTs: Math.floor(r.createdAt.getTime() / 1000),
  };
}

function toDto(r: LaunchRow): LaunchSummary {
  return {
    id: r.id, mint: r.mint, name: r.name, ticker: r.ticker, description: r.description, imageUri: r.imageUri, creator: r.creator,
    creatorAllocationBps: r.creatorAllocationBps, totalSupply: r.totalSupply, quoteAsset: r.quoteAsset as QuoteAssetSymbol,
    creditTier: r.creditTier as LaunchSummary["creditTier"], status: r.status as LaunchStatus, createdTs: r.createdTs,
    auction: {
      commitStartTs: r.commitStartTs, commitEndTs: r.commitEndTs, revealEndTs: r.revealEndTs, bidCount: r.bidCount, revealedCount: r.revealedCount,
      escrowedWallets: r.escrowedWallets, totalEscrowed: r.totalEscrowed, floorPrice: r.floorPrice, tickSize: r.tickSize, tokensForSale: r.tokensForSale,
      targetRaise: r.targetRaise, clearingCap: r.clearingCap, clearingPrice: r.clearingPrice, totalRaised: r.totalRaised,
    },
    market: (r.market as unknown as MarketState | null) ?? null,
    vault: (r.vault as unknown as VaultState | null) ?? null,
    credit: (r.credit as unknown as CreditState | null) ?? null,
    network: r.network as Network, isDemo: r.isDemo,
  };
}

function fromDto(l: LaunchSummary, jsonNull: unknown): Prisma.LaunchCreateInput {
  const a = l.auction;
  const json = (v: unknown) => (v == null ? (jsonNull as Prisma.InputJsonValue) : (v as Prisma.InputJsonValue));
  return {
    id: l.id, mint: l.mint, name: l.name, ticker: l.ticker, description: l.description, imageUri: l.imageUri, creator: l.creator,
    creatorAllocationBps: l.creatorAllocationBps, totalSupply: l.totalSupply, quoteAsset: l.quoteAsset, creditTier: l.creditTier, status: l.status,
    createdTs: l.createdTs, network: l.network, isDemo: l.isDemo,
    commitStartTs: a.commitStartTs, commitEndTs: a.commitEndTs, revealEndTs: a.revealEndTs, bidCount: a.bidCount, revealedCount: a.revealedCount,
    escrowedWallets: a.escrowedWallets, totalEscrowed: a.totalEscrowed, floorPrice: a.floorPrice, tickSize: a.tickSize, tokensForSale: a.tokensForSale,
    targetRaise: a.targetRaise, clearingCap: a.clearingCap, clearingPrice: a.clearingPrice, totalRaised: a.totalRaised,
    market: json(l.market), vault: json(l.vault), credit: json(l.credit), nextDripTs: l.vault?.nextDripTs ?? null,
  };
}
