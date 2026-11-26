import {
  QUOTE_ASSETS,
  isQuoteAssetSymbol,
  type BalanceRow,
  type BuybackEvent,
  type CreateLaunchInput,
  type CreditLedgerEntry,
  type HolderReward,
  type LaunchSummary,
  type PricePoint,
  type QuoteAssetSymbol,
  type SealedRevealEnvelope,
  type Trade,
  type AssetId,
} from "@sealed/shared";
import { bucketChart, type ChartInterval } from "../../store/types.js";
import { assetDecimals, fromAtoms } from "../ledger.js";
import type { LaunchRow } from "../repo/types.js";
import { attachSealedReveal, claim, commitBid, revealBid, runAutoReveals, type CommitInput, type RevealInput } from "./auction.js";
import { executeDrip } from "./buyback.js";
import { clearAndGraduate } from "./clearing.js";
import { invalidate, nowS, publish, type EngineDeps } from "./common.js";
import { distributeFees } from "./fees.js";
import { buybackFromTx, createLaunch, creditEntriesFromTx, toSummary, tradeFromTx } from "./launches.js";
import { swap, type SwapInput } from "./pool.js";
import { claimRewards, holderReward, stake } from "./rewards.js";

export interface OffchainStatsDelta {
  liveAuctions: number;
  activeVaults: number;
  graduatedFlywheels: number;
  snipersBlocked: number;
  totalVolumeUsd: number;
  totalFeesUsd: number;
  activeBuybackCreditUsd: number;
  totalCreditDeployedUsd: number;
  totalCreditRepaidUsd: number;
  holderPayoutsUsd: number;
  totalTokensBurnedUsd: number;
}

/** Offchain custodial execution engine: write paths (trade routes, scheduler) + read model (existing DTOs). */
export class OffchainEngine {
  constructor(readonly deps: EngineDeps) {}

  // ---------------------------------------------------------------- writes
  createLaunch(input: CreateLaunchInput, creator: string) {
    return createLaunch(this.deps, input, creator);
  }
  commitBid(wallet: string, input: CommitInput) {
    return commitBid(this.deps, wallet, input);
  }
  revealBid(wallet: string, input: RevealInput) {
    return revealBid(this.deps, wallet, input);
  }
  attachSealedReveal(env: SealedRevealEnvelope) {
    return attachSealedReveal(this.deps, env);
  }
  claim(wallet: string, launchId: string) {
    return claim(this.deps, wallet, launchId);
  }
  swap(wallet: string, input: SwapInput, idemKey: string) {
    return swap(this.deps, wallet, input, idemKey);
  }
  stake(wallet: string, launchId: string, amount: number, idemKey: string) {
    return stake(this.deps, wallet, launchId, amount, idemKey);
  }
  claimRewards(wallet: string, launchId: string) {
    return claimRewards(this.deps, wallet, launchId);
  }
  executeDrip(launchId: string) {
    return executeDrip(this.deps, launchId);
  }
  distributeFees(launchId: string) {
    return distributeFees(this.deps, launchId);
  }
  clearAndGraduate(launchId: string) {
    return clearAndGraduate(this.deps, launchId);
  }

  /**
   * One scheduler pass: commit→reveal (then auto-reveals), reveal→clear→graduate, drips when due, fee distribution.
   * Every step is idempotent (deterministic ledger keys + status guards under row locks), so overlapping passes
   * from several API replicas are safe.
   */
  async tick(): Promise<void> {
    const d = this.deps;
    const launches = await d.repo.read.listLaunches(["commit", "reveal", "live", "flywheel"]);
    for (const l of launches) {
      try {
        const now = nowS(d);
        if (l.status === "commit" && now >= l.commitEndTs) {
          const moved = await d.repo.tx(async (t) => {
            const cur = await t.getLaunch(l.id, true);
            if (!cur || cur.status !== "commit") return null;
            await t.updateLaunch(l.id, { status: "reveal" });
            return { ...cur, status: "reveal" as const };
          });
          if (moved) {
            await invalidate(d);
            publish(d, [
              { type: "auction.phase_changed", data: { launchId: l.id, from: "commit", to: "reveal" } },
              { type: "launch.updated", data: await toSummary(d, moved) },
            ]);
          }
        }
        if (l.status === "commit" || l.status === "reveal") {
          await runAutoReveals(d, l.id);
          if (now >= l.revealEndTs) await clearAndGraduate(d, l.id);
        } else {
          if (l.nextDripTs > 0 && now >= l.nextDripTs) await executeDrip(d, l.id);
          await distributeFees(d, l.id);
        }
      } catch (err) {
        d.log?.warn({ launch: l.id, err: err instanceof Error ? err.message : String(err) }, "offchain: tick step failed");
      }
    }
  }

  // ---------------------------------------------------------------- reads (map into existing DTOs)
  getRow(idOrMint: string) {
    return this.deps.repo.read.getLaunch(idOrMint);
  }
  async getSummary(idOrMint: string): Promise<LaunchSummary | null> {
    const l = await this.getRow(idOrMint);
    return l ? toSummary(this.deps, l) : null;
  }
  async listSummaries(): Promise<LaunchSummary[]> {
    const rows = await this.deps.repo.read.listLaunches();
    return Promise.all(rows.map((l) => toSummary(this.deps, l)));
  }
  async getTrades(idOrMint: string, limit: number): Promise<Trade[]> {
    const l = await this.getRow(idOrMint);
    if (!l) return [];
    const txs = await this.deps.repo.read.listTxs({ launchId: l.id, kinds: ["swap", "drip"], limit });
    return txs.map((t) => tradeFromTx(l, t));
  }
  async getChart(idOrMint: string, interval: ChartInterval): Promise<PricePoint[]> {
    const trades = await this.getTrades(idOrMint, 2_000);
    const pts = trades.reverse().map((t) => ({ ts: t.ts, price: t.price, volume: t.amountQuote }));
    return bucketChart(pts, interval);
  }
  private async rowMap(): Promise<Map<string, LaunchRow>> {
    return new Map((await this.deps.repo.read.listLaunches()).map((l) => [l.id, l]));
  }
  async listBuybacks(opts: { launchId?: string; limit: number }): Promise<BuybackEvent[]> {
    const rows = await this.rowMap();
    const id = opts.launchId ? (await this.getRow(opts.launchId))?.id : undefined;
    if (opts.launchId && !id) return [];
    const txs = await this.deps.repo.read.listTxs({ launchId: id, kinds: ["drip"], limit: opts.limit });
    return txs.filter((t) => t.launchId && rows.has(t.launchId)).map((t) => buybackFromTx(rows.get(t.launchId!)!, t));
  }
  async listLedger(opts: { launchId?: string; limit: number }): Promise<CreditLedgerEntry[]> {
    const rows = await this.rowMap();
    const id = opts.launchId ? (await this.getRow(opts.launchId))?.id : undefined;
    if (opts.launchId && !id) return [];
    const txs = await this.deps.repo.read.listTxs({ launchId: id, kinds: ["graduate", "distribute"], limit: opts.limit });
    return txs.filter((t) => t.launchId && rows.has(t.launchId)).flatMap((t) => creditEntriesFromTx(rows.get(t.launchId!)!, t)).slice(0, opts.limit);
  }
  async holderReward(idOrMint: string, wallet: string): Promise<HolderReward | null> {
    const l = await this.getRow(idOrMint);
    return l ? holderReward(this.deps, l, wallet) : null;
  }
  async isOffchain(idOrMint: string): Promise<boolean> {
    return !!(await this.getRow(idOrMint));
  }

  async statsDelta(): Promise<OffchainStatsDelta> {
    const rows = await this.deps.repo.read.listLaunches();
    const s: OffchainStatsDelta = {
      liveAuctions: 0, activeVaults: 0, graduatedFlywheels: 0, snipersBlocked: 0, totalVolumeUsd: 0, totalFeesUsd: 0,
      activeBuybackCreditUsd: 0, totalCreditDeployedUsd: 0, totalCreditRepaidUsd: 0, holderPayoutsUsd: 0, totalTokensBurnedUsd: 0,
    };
    for (const l of rows) {
      if (l.status === "commit" || l.status === "reveal" || l.status === "clearing") s.liveAuctions++;
      if (l.status === "live") s.activeVaults++;
      if (l.status === "flywheel") s.graduatedFlywheels++;
      const qa = QUOTE_ASSETS[l.quoteAsset as QuoteAssetSymbol];
      const usd = (v: bigint) => fromAtoms(v, qa.decimals) * qa.demoUsdPrice;
      s.totalVolumeUsd += usd(l.volumeQuote);
      s.totalFeesUsd += usd(l.feesCollected);
      s.activeBuybackCreditUsd += usd(l.creditOutstanding);
      s.totalCreditDeployedUsd += usd(l.creditLine);
      s.totalCreditRepaidUsd += usd(l.creditRepaid);
      s.holderPayoutsUsd += usd(l.holderPayouts);
      s.totalTokensBurnedUsd += usd(l.vaultQuoteSpent);
    }
    s.snipersBlocked = (await this.deps.repo.read.listSnipers({})).length;
    return s;
  }

  // ---------------------------------------------------------------- account helpers (custody routes)
  async accountBalances(wallet: string): Promise<BalanceRow[]> {
    const bals = await this.deps.ledger.balances(wallet);
    const out: BalanceRow[] = [];
    for (const b of bals) {
      const dec = assetDecimals(b.asset);
      let symbol = b.asset;
      let launchId: string | undefined;
      if (b.asset.startsWith("tok:")) {
        launchId = b.asset.slice(4);
        symbol = (await this.getRow(launchId))?.ticker ?? symbol;
      } else if (!isQuoteAssetSymbol(b.asset)) continue;
      out.push({ asset: b.asset as AssetId, symbol, available: fromAtoms(b.available, dec), locked: fromAtoms(b.locked + b.staked, dec), ...(launchId ? { launchId } : {}) });
    }
    return out;
  }
  async sniperFlags(wallet: string): Promise<string[]> {
    return (await this.deps.repo.read.listSnipers({ wallet })).map((s) => s.launchId);
  }
}
