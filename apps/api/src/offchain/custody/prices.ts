import type { FastifyBaseLogger } from "fastify";
import { QUOTE_ASSETS, QUOTE_ASSET_MAINNET, type Network, type QuoteAssetSymbol } from "@sealed/shared";
import { redact, type FetchFn } from "./rpc.js";

/**
 * USD prices for withdrawal limits (WITHDRAWAL_LIMITS are USD).
 *
 *  - devnet / localnet: static demo prices from quoteAssets.ts (StaticPriceService).
 *  - mainnet: LivePriceService — Jupiter Price API v3 (`GET <base>?ids=<mint,…>` →
 *    `{ "<mint>": { usdPrice, blockId, decimals, … } }`), falling back to Helius DAS `getAsset`
 *    (`token_info.price_info.price_per_token`) when a Helius RPC is configured. Each fetch has a timeout; results
 *    are cached for 60s; a cached price older than 5 min is STALE and never used. No fresh price → `null`, and the
 *    caller must route the withdrawal to manual approval (fail safe: never auto-approve on an unknown price).
 */

export interface PriceQuote {
  usd: number;
  /** ms epoch when the price was fetched from its source. */
  asOfMs: number;
  source: string;
}

export interface PriceService {
  readonly live: boolean;
  /** Fresh USD price, or null when none is available within the staleness limit. Never throws. */
  usdPrice(symbol: QuoteAssetSymbol): Promise<PriceQuote | null>;
  /** Last known price regardless of age (for recording an approximate usdValue on a pending row). Never throws. */
  lastKnown(symbol: QuoteAssetSymbol): PriceQuote | null;
}

/** A price source returns USD prices for the requested mints it knows (missing/invalid mints omitted). */
export interface PriceSource {
  name: string;
  fetchPrices(mints: string[], signal: AbortSignal): Promise<Map<string, number>>;
}

export const PRICE_CACHE_TTL_MS = 60_000;
export const PRICE_MAX_AGE_MS = 5 * 60_000;
export const PRICE_FETCH_TIMEOUT_MS = 4_000;

export class StaticPriceService implements PriceService {
  readonly live = false;
  constructor(private readonly now: () => number = Date.now) {}
  async usdPrice(symbol: QuoteAssetSymbol): Promise<PriceQuote | null> {
    return this.lastKnown(symbol);
  }
  lastKnown(symbol: QuoteAssetSymbol): PriceQuote | null {
    const p = QUOTE_ASSETS[symbol]?.demoUsdPrice;
    return p ? { usd: p, asOfMs: this.now(), source: "demo" } : null;
  }
}

const validPrice = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1e9 ? n : null;
};

/** Jupiter Price API v3. */
export function jupiterPriceSource(baseUrl: string, opts: { apiKey?: string; fetchFn?: FetchFn } = {}): PriceSource {
  const f = opts.fetchFn ?? fetch;
  return {
    name: "jupiter",
    async fetchPrices(mints, signal) {
      const url = `${baseUrl}?ids=${mints.map(encodeURIComponent).join(",")}`;
      const res = await f(url, { headers: { accept: "application/json", ...(opts.apiKey ? { "x-api-key": opts.apiKey } : {}) }, signal });
      if (!res.ok) throw new Error(`jupiter price HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, { usdPrice?: unknown } | null> | null;
      const out = new Map<string, number>();
      if (!body || typeof body !== "object") return out;
      for (const m of mints) {
        const p = validPrice(body[m]?.usdPrice);
        if (p !== null) out.set(m, p);
      }
      return out;
    },
  };
}

/** Helius DAS getAsset price_info (fallback). `rpcUrl` contains the API key — never logged (errors are redacted). */
export function heliusPriceSource(rpcUrl: string, opts: { fetchFn?: FetchFn } = {}): PriceSource {
  const f = opts.fetchFn ?? fetch;
  return {
    name: "helius",
    async fetchPrices(mints, signal) {
      const out = new Map<string, number>();
      await Promise.all(
        mints.map(async (m, i) => {
          const res = await f(rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "getAsset", params: { id: m } }),
            signal,
          });
          if (!res.ok) throw new Error(`helius getAsset HTTP ${res.status}`);
          const body = (await res.json()) as { result?: { token_info?: { price_info?: { price_per_token?: unknown; currency?: string } } } };
          const pi = body.result?.token_info?.price_info;
          const p = validPrice(pi?.price_per_token);
          if (p !== null && (!pi?.currency || pi.currency === "USDC" || pi.currency === "USD")) out.set(m, p);
        }),
      );
      return out;
    },
  };
}

interface CacheEntry {
  usd: number;
  at: number;
  source: string;
}

export class LivePriceService implements PriceService {
  readonly live = true;
  private cache = new Map<QuoteAssetSymbol, CacheEntry>();
  private inflight: Promise<void> | null = null;
  private readonly mints: Map<QuoteAssetSymbol, string>;

  constructor(
    private readonly sources: PriceSource[],
    symbols: { symbol: QuoteAssetSymbol; mint: string }[],
    private readonly log?: FastifyBaseLogger,
    private readonly opts: { ttlMs?: number; maxAgeMs?: number; timeoutMs?: number; now?: () => number } = {},
  ) {
    this.mints = new Map(symbols.map((s) => [s.symbol, s.mint]));
  }

  private get now() {
    return this.opts.now ?? Date.now;
  }

  lastKnown(symbol: QuoteAssetSymbol): PriceQuote | null {
    const c = this.cache.get(symbol);
    return c ? { usd: c.usd, asOfMs: c.at, source: c.source } : null;
  }

  async usdPrice(symbol: QuoteAssetSymbol): Promise<PriceQuote | null> {
    if (!this.mints.has(symbol)) return null;
    const ttl = this.opts.ttlMs ?? PRICE_CACHE_TTL_MS;
    const maxAge = this.opts.maxAgeMs ?? PRICE_MAX_AGE_MS;
    const c = this.cache.get(symbol);
    if (!c || this.now() - c.at >= ttl) await this.refresh();
    const e = this.cache.get(symbol);
    if (!e || this.now() - e.at > maxAge) return null; // missing or stale → caller fails safe
    return { usd: e.usd, asOfMs: e.at, source: e.source };
  }

  /** One refresh at a time for all mints; tries sources in order until every mint is priced. Never throws. */
  private refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    let pending = [...this.mints.entries()];
    for (const src of this.sources) {
      if (pending.length === 0) break;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? PRICE_FETCH_TIMEOUT_MS);
      try {
        const got = await Promise.race([
          src.fetchPrices(pending.map(([, m]) => m), ctrl.signal),
          new Promise<never>((_, rej) => ctrl.signal.addEventListener("abort", () => rej(new Error("timeout")), { once: true })),
        ]);
        const at = this.now();
        for (const [sym, mint] of pending) {
          const p = got.get(mint);
          if (p !== undefined) this.cache.set(sym, { usd: p, at, source: src.name });
        }
        pending = pending.filter(([, m]) => !got.has(m));
      } catch (err) {
        this.log?.warn({ source: src.name, err: redact((err as Error)?.message ?? String(err)) }, "custody: price fetch failed");
      } finally {
        clearTimeout(timer);
      }
    }
    if (pending.length > 0) this.log?.warn({ unpriced: pending.map(([s]) => s) }, "custody: no live price for some assets");
  }
}

/** Mainnet → live prices for enabled assets; elsewhere → demo prices. */
export function createPriceService(
  network: Network,
  o: { jupiterPriceApiUrl: string; jupiterApiKey?: string; heliusRpcUrl?: string; fetchFn?: FetchFn; log?: FastifyBaseLogger },
): PriceService {
  if (network !== "mainnet") return new StaticPriceService();
  const symbols = (Object.keys(QUOTE_ASSET_MAINNET) as QuoteAssetSymbol[])
    .filter((s) => QUOTE_ASSET_MAINNET[s].enabled && QUOTE_ASSET_MAINNET[s].mint)
    .map((s) => ({ symbol: s, mint: QUOTE_ASSET_MAINNET[s].mint! }));
  const sources = [jupiterPriceSource(o.jupiterPriceApiUrl, { apiKey: o.jupiterApiKey, fetchFn: o.fetchFn })];
  if (o.heliusRpcUrl && /helius-rpc\.com/.test(o.heliusRpcUrl)) sources.push(heliusPriceSource(o.heliusRpcUrl, { fetchFn: o.fetchFn }));
  return new LivePriceService(sources, symbols, o.log);
}
