import type { FastifyBaseLogger } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { CREDIT_TIERS, ONCHAIN_STATUS, QUOTE_ASSETS, demoImage, quoteAssetByMint, type LaunchStatus, type LaunchSummary, type QuoteAssetSymbol } from "@sealed/shared";
import type { AppContext } from "../context.js";
import { getConnection, loadAnchor, loadIdl, type AnchorModule } from "../services/solana.js";
import { nowSec } from "../store/index.js";

/** Read a decoded Anchor field by snake_case or camelCase name. */
function f(obj: Record<string, unknown>, snake: string): unknown {
  if (snake in obj) return obj[snake];
  const camel = snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return obj[camel];
}
function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "object" && v && "toString" in v) return Number((v as { toString(): string }).toString());
  return Number(v);
}
function pk(v: unknown): string {
  if (v instanceof PublicKey) return v.toBase58();
  if (v && typeof v === "object" && "toBase58" in v) return (v as PublicKey).toBase58();
  return String(v ?? "");
}
function onchainStatus(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object") {
    const k = Object.keys(v)[0]?.toLowerCase();
    const map: Record<string, number> = { open: 0, cleared: 1, failed: 2, live: 3, flywheel: 4 };
    if (k && k in map) return map[k]!;
  }
  return 0;
}

export function mapStatus(code: number, commitEnd: number, revealEnd: number, now: number): LaunchStatus {
  switch (code) {
    case ONCHAIN_STATUS.Open:
      return now < commitEnd ? "commit" : now < revealEnd ? "reveal" : "clearing";
    case ONCHAIN_STATUS.Cleared:
      return "clearing";
    case ONCHAIN_STATUS.Failed:
      return "failed";
    case ONCHAIN_STATUS.Live:
      return "live";
    case ONCHAIN_STATUS.Flywheel:
      return "flywheel";
    default:
      return "commit";
  }
}

/** Decoded LaunchAccount (+ optional Pool) → LaunchSummary DTO in UI units. */
export function launchFromAccount(
  address: string,
  acc: Record<string, unknown>,
  pool: Record<string, unknown> | null,
  prev: LaunchSummary | null,
  network: LaunchSummary["network"],
  now = nowSec(),
): LaunchSummary {
  const quoteMint = pk(f(acc, "quote_mint"));
  const qa = quoteAssetByMint(quoteMint, network);
  const symbol: QuoteAssetSymbol = qa?.symbol ?? prev?.quoteAsset ?? "SOL";
  const qd = 10 ** (qa?.decimals ?? QUOTE_ASSETS[symbol].decimals);
  const td = 1e6;
  const q = (k: string) => num(f(acc, k)) / qd;
  const commitEnd = num(f(acc, "commit_end_ts"));
  const revealEnd = num(f(acc, "reveal_end_ts"));
  const status = mapStatus(onchainStatus(f(acc, "status")), commitEnd, revealEnd, now);
  const graduated = status === "live" || status === "flywheel";
  const totalSupply = num(f(acc, "total_supply")) / td;
  const creditBps = num(f(acc, "credit_bps"));
  const tier = (Object.entries(CREDIT_TIERS).find(([, v]) => v === creditBps)?.[0] ?? "standard") as LaunchSummary["creditTier"];
  const mint = pk(f(acc, "token_mint"));
  const creditLine = q("credit_line");
  const outstanding = q("credit_outstanding");
  const repaid = Math.max(0, creditLine - outstanding);
  const dripCount = num(f(acc, "drip_count"));
  const dripsExecuted = num(f(acc, "drips_executed"));
  const vaultInitial = q("vault_initial");
  const tokensBurned = num(f(acc, "tokens_burned")) / td;

  let price = prev?.market?.price ?? q("clearing_price");
  if (pool) {
    const qr = num(f(pool, "quote_reserve")) / qd;
    const tr = num(f(pool, "token_reserve")) / td;
    if (tr > 0) price = qr / tr;
  }
  const quoteSpent = vaultInitial && dripCount ? (vaultInitial * Math.min(dripsExecuted, dripCount)) / dripCount : prev?.vault?.quoteSpent ?? 0;

  return {
    id: address,
    mint,
    name: prev?.name ?? `Launch ${mint.slice(0, 4)}`,
    ticker: prev?.ticker ?? mint.slice(0, 4).toUpperCase(),
    description: prev?.description ?? "",
    imageUri: prev?.imageUri ?? demoImage(mint.slice(0, 2), 40),
    creator: pk(f(acc, "creator")),
    creatorAllocationBps: totalSupply > 0 ? Math.round(((num(f(acc, "creator_allocation")) / td) / totalSupply) * 10_000) : 0,
    totalSupply,
    quoteAsset: symbol,
    creditTier: tier,
    status,
    createdTs: prev?.createdTs ?? num(f(acc, "commit_start_ts")),
    auction: {
      commitStartTs: num(f(acc, "commit_start_ts")),
      commitEndTs: commitEnd,
      revealEndTs: revealEnd,
      bidCount: num(f(acc, "bid_count")),
      revealedCount: num(f(acc, "revealed_count")),
      escrowedWallets: prev?.auction.escrowedWallets ?? num(f(acc, "bid_count")),
      totalEscrowed: q("total_escrowed"),
      floorPrice: q("floor_price"),
      tickSize: q("tick_size"),
      tokensForSale: num(f(acc, "tokens_for_sale")) / td,
      targetRaise: q("target_raise"),
      clearingCap: q("clearing_cap"),
      clearingPrice: status === "commit" || status === "reveal" ? null : q("clearing_price") || null,
      totalRaised: status === "commit" || status === "reveal" ? null : q("total_raised") || null,
    },
    market: graduated
      ? {
          price,
          priceUsd: price * QUOTE_ASSETS[symbol].demoUsdPrice,
          change24hPct: prev?.market?.change24hPct ?? 0,
          volume24h: prev?.market?.volume24h ?? q("fees_collected") / 0.01,
          liquidityQuote: pool ? (num(f(pool, "quote_reserve")) / qd) * 2 : prev?.market?.liquidityQuote ?? 0,
          marketCapQuote: price * totalSupply,
          holders: prev?.market?.holders ?? 0,
          graduationSlot: num(f(acc, "graduation_slot")),
          graduatedTs: num(f(acc, "graduated_ts")),
        }
      : null,
    vault: graduated
      ? {
          creditLine,
          balance: Math.max(0, vaultInitial - quoteSpent),
          dripAmount: dripCount ? vaultInitial / dripCount : 0,
          dripIntervalSec: num(f(acc, "drip_interval_sec")),
          nextDripTs: num(f(acc, "next_drip_ts")),
          dripsExecuted,
          dripsTotal: dripCount,
          tokensBurned,
          quoteSpent,
        }
      : null,
    credit: graduated
      ? {
          creditLine,
          repaid,
          repaidPct: creditLine > 0 ? Math.min(100, (repaid / creditLine) * 100) : 100,
          phase: status === "flywheel" ? "flywheel" : "repaying",
          feesCollected: q("fees_collected"),
          holderPayouts: prev?.credit?.holderPayouts ?? 0,
          platformBurnQuote: prev?.credit?.platformBurnQuote ?? 0,
          treasury: prev?.credit?.treasury ?? 0,
        }
      : null,
    network,
    isDemo: false,
  };
}

/**
 * On-chain indexer (Helius / any RPC). Polls getProgramAccounts for LaunchAccount + Pool, decodes with the
 * Anchor IDL (loaded at runtime from programs/sealed-launchpad/idl), upserts into the store and publishes
 * WS events on changes. Subscribes to program logs to trigger fast re-syncs. Degrades to a no-op if the
 * RPC or IDL is unavailable.
 */
export async function startIndexer(ctx: AppContext, log: FastifyBaseLogger, pollMs = 20_000): Promise<() => void> {
  if (ctx.cfg.isDemo) return () => undefined;
  const conn = getConnection(ctx.cfg);
  if (!conn) {
    log.warn("indexer: SOLANA_RPC_URL not set — indexer disabled");
    return () => undefined;
  }
  const idl = loadIdl(ctx.cfg);
  if (!idl) {
    log.warn("indexer: IDL not found (programs/sealed-launchpad/idl/sealed_launchpad.json) — indexer disabled");
    return () => undefined;
  }
  let anchor: AnchorModule;
  let coder: AnchorModule;
  try {
    anchor = await loadAnchor();
    coder = new anchor.BorshAccountsCoder(idl);
  } catch (err) {
    log.error({ err }, "indexer: failed to build Anchor coder — indexer disabled");
    return () => undefined;
  }
  const pid = new PublicKey(ctx.cfg.programId);
  const accountName = (want: string): string | null => {
    const accs = (idl.accounts as Array<{ name: string }> | undefined) ?? [];
    return accs.find((a) => a.name.toLowerCase() === want.toLowerCase())?.name ?? null;
  };
  const launchName = accountName("LaunchAccount");
  const poolName = accountName("Pool");
  if (!launchName) {
    log.warn("indexer: IDL has no LaunchAccount — indexer disabled");
    return () => undefined;
  }

  const fetchAll = async (name: string) => {
    const m = coder.memcmp(name) as { offset?: number; bytes: string };
    const res = await conn.getProgramAccounts(pid, { filters: [{ memcmp: { offset: m.offset ?? 0, bytes: m.bytes } }] });
    const out: Array<{ address: string; data: Record<string, unknown> }> = [];
    for (const r of res) {
      try {
        out.push({ address: r.pubkey.toBase58(), data: coder.decode(name, r.account.data) as Record<string, unknown> });
      } catch {
        /* skip undecodable */
      }
    }
    return out;
  };

  let syncing = false;
  const sync = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const launches = await fetchAll(launchName);
      const pools = poolName ? await fetchAll(poolName) : [];
      const poolByLaunch = new Map(pools.map((p) => [pk(f(p.data, "launch")), p.data]));
      for (const { address, data } of launches) {
        const prev = await ctx.store.getLaunch(address);
        const next = launchFromAccount(address, data, poolByLaunch.get(address) ?? null, prev, ctx.cfg.network);
        await ctx.store.upsertLaunch(next);
        if (!prev) ctx.bus.publish({ type: "launch.created", data: next });
        else {
          if (prev.status !== next.status) ctx.bus.publish({ type: "auction.phase_changed", data: { launchId: next.id, from: prev.status, to: next.status } });
          if (prev.auction.bidCount !== next.auction.bidCount)
            ctx.bus.publish({ type: "auction.bid_committed", data: { launchId: next.id, bidCount: next.auction.bidCount, escrowedWallets: next.auction.escrowedWallets, totalEscrowed: next.auction.totalEscrowed } });
          if (prev.auction.revealedCount !== next.auction.revealedCount)
            ctx.bus.publish({ type: "auction.bid_revealed", data: { launchId: next.id, revealedCount: next.auction.revealedCount, bidCount: next.auction.bidCount } });
          if (prev.status !== "flywheel" && next.status === "flywheel") ctx.bus.publish({ type: "credit.flywheel_activated", data: { launchId: next.id, ts: nowSec() } });
          if (next.auction.clearingPrice != null && prev.auction.clearingPrice == null)
            ctx.bus.publish({ type: "auction.cleared", data: { launchId: next.id, clearingPrice: next.auction.clearingPrice, totalRaised: next.auction.totalRaised ?? 0, winners: next.auction.revealedCount } });
          if (JSON.stringify(prev) !== JSON.stringify(next)) ctx.bus.publish({ type: "launch.updated", data: next });
        }
        if (next.credit && next.credit.feesCollected > (prev?.credit?.feesCollected ?? 0)) await ctx.cache.enqueue("keeper", { kind: "distribute", launchId: next.id });
      }
      await ctx.cache.bump("launches");
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err }, "indexer: sync failed");
    } finally {
      syncing = false;
    }
  };

  let debounce: NodeJS.Timeout | null = null;
  let subId: number | null = null;
  try {
    subId = conn.onLogs(pid, () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        void sync();
      }, 1500);
    });
  } catch (err) {
    log.warn({ err }, "indexer: onLogs subscription failed; polling only");
  }
  void sync();
  const t = setInterval(() => void sync(), pollMs);
  t.unref();
  log.info({ programId: pid.toBase58() }, "indexer: started");
  return () => {
    clearInterval(t);
    if (debounce) clearTimeout(debounce);
    if (subId != null) conn.removeOnLogsListener(subId).catch(() => undefined);
  };
}
