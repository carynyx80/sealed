import { VersionedTransaction, type PublicKey } from "@solana/web3.js";
import type { Network } from "@sealed/shared";

/**
 * Jupiter v6 Swap API client (quote + swap).
 *
 * Per-network behaviour:
 *  - mainnet: real Jupiter routing. Used for (a) quote-asset conversion (e.g. SOL → NVDAx before bidding/buying)
 *    and (b) once a graduated token is indexed by Jupiter, routing that token (Jupiter will route through any
 *    aggregatable venue; the canonical venue for our tokens is still the program's internal pool).
 *  - devnet / localnet: Jupiter has no devnet liquidity. Every call throws `JupiterUnavailableError`, and callers
 *    MUST fall back to the program's internal CPMM `swap` instruction (see `selectSwapVenue`).
 *
 * Endpoints: the v6 API is served at `https://lite-api.jup.ag/swap/v1` (free tier, same request/response shape
 * as the legacy `https://quote-api.jup.ag/v6`) and `https://api.jup.ag/swap/v1` (keyed). Override with
 * `baseUrl` or env NEXT_PUBLIC_JUPITER_API_URL / JUPITER_API_URL.
 */

export const JUPITER_ENDPOINTS = {
  lite: "https://lite-api.jup.ag/swap/v1",
  pro: "https://api.jup.ag/swap/v1",
  legacyV6: "https://quote-api.jup.ag/v6",
} as const;

const env: Record<string, string | undefined> = typeof process !== "undefined" && process.env ? process.env : {};
export const DEFAULT_JUPITER_BASE_URL: string =
  (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_JUPITER_API_URL : undefined) ?? env.JUPITER_API_URL ?? JUPITER_ENDPOINTS.lite;

export const DEFAULT_JUPITER_TIMEOUT_MS = 8_000;

export class JupiterUnavailableError extends Error {
  constructor(public readonly network: Network) {
    super(`Jupiter routing is mainnet-only (network=${network}); use the internal pool swap instead`);
    this.name = "JupiterUnavailableError";
  }
}

export class JupiterApiError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: unknown) {
    super(message);
    this.name = "JupiterApiError";
  }
}

export interface JupiterRoutePlanStep {
  swapInfo: { ammKey: string; label?: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string; feeAmount?: string; feeMint?: string };
  percent: number;
}

/** Response of GET /quote (v6 shape). Amounts are atom strings. */
export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: "ExactIn" | "ExactOut";
  slippageBps: number;
  priceImpactPct: string;
  routePlan: JupiterRoutePlanStep[];
  contextSlot?: number;
  timeTaken?: number;
  [k: string]: unknown;
}

export interface JupiterClientOptions {
  network: Network;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface GetQuoteParams {
  inputMint: string;
  outputMint: string;
  /** Atoms of input (ExactIn) or output (ExactOut). */
  amount: bigint;
  slippageBps?: number;
  swapMode?: "ExactIn" | "ExactOut";
  onlyDirectRoutes?: boolean;
  restrictIntermediateTokens?: boolean;
  maxAccounts?: number;
}

export interface BuildSwapTxParams {
  quote: JupiterQuoteResponse;
  userPublicKey: PublicKey | string;
  wrapAndUnwrapSol?: boolean;
  /** Lamports, or "auto". */
  prioritizationFeeLamports?: number | "auto";
  dynamicComputeUnitLimit?: boolean;
}

export interface BuiltJupiterSwap {
  transaction: VersionedTransaction;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
}

export function isJupiterNetwork(network: Network): boolean {
  return network === "mainnet";
}

export function assertMainnet(network: Network): void {
  if (!isJupiterNetwork(network)) throw new JupiterUnavailableError(network);
}

export type SwapVenue = "jupiter" | "internal-pool";

/**
 * Which venue to use for a trade.
 *  - Launch token ↔ its quote asset: ALWAYS the internal pool (fee routing + anti-snipe are enforced there).
 *  - Quote-asset conversion (e.g. USDC → TSLAx): Jupiter on mainnet; not possible on devnet (use the mock
 *    faucet mints directly), so devnet returns "internal-pool" meaning "no conversion leg; trade the pool directly".
 */
export function selectSwapVenue(network: Network, leg: "launch-token" | "quote-conversion" = "launch-token"): SwapVenue {
  if (leg === "launch-token") return "internal-pool";
  return isJupiterNetwork(network) ? "jupiter" : "internal-pool";
}

async function fetchWithTimeout(f: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await f(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new JupiterApiError(`Jupiter request timed out after ${timeoutMs}ms`);
    throw new JupiterApiError(`Jupiter request failed: ${(e as Error)?.message ?? String(e)}`);
  } finally {
    clearTimeout(t);
  }
}

function decodeBase64(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export class JupiterClient {
  readonly network: Network;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly apiKey?: string;
  private readonly f: typeof fetch;

  constructor(opts: JupiterClientOptions) {
    this.network = opts.network;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_JUPITER_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_JUPITER_TIMEOUT_MS;
    this.apiKey = opts.apiKey;
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get available(): boolean {
    return isJupiterNetwork(this.network);
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json" };
    if (json) h["content-type"] = "application/json";
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    return h;
  }

  async getQuote(p: GetQuoteParams): Promise<JupiterQuoteResponse> {
    assertMainnet(this.network);
    if (p.amount <= 0n) throw new JupiterApiError("amount must be > 0");
    const q = new URLSearchParams({
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: p.amount.toString(),
      slippageBps: String(p.slippageBps ?? 50),
      swapMode: p.swapMode ?? "ExactIn",
    });
    if (p.onlyDirectRoutes) q.set("onlyDirectRoutes", "true");
    if (p.restrictIntermediateTokens ?? true) q.set("restrictIntermediateTokens", "true");
    if (p.maxAccounts) q.set("maxAccounts", String(p.maxAccounts));
    const res = await fetchWithTimeout(this.f, `${this.baseUrl}/quote?${q}`, { headers: this.headers() }, this.timeoutMs);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || (body as { error?: string }).error) {
      throw new JupiterApiError((body as { error?: string })?.error ?? `Jupiter quote failed (${res.status})`, res.status, body);
    }
    return body as JupiterQuoteResponse;
  }

  async buildSwapTx(p: BuildSwapTxParams): Promise<BuiltJupiterSwap> {
    assertMainnet(this.network);
    const payload = {
      quoteResponse: p.quote,
      userPublicKey: typeof p.userPublicKey === "string" ? p.userPublicKey : p.userPublicKey.toBase58(),
      wrapAndUnwrapSol: p.wrapAndUnwrapSol ?? true,
      dynamicComputeUnitLimit: p.dynamicComputeUnitLimit ?? true,
      prioritizationFeeLamports: p.prioritizationFeeLamports ?? "auto",
    };
    const res = await fetchWithTimeout(
      this.f,
      `${this.baseUrl}/swap`,
      { method: "POST", headers: this.headers(true), body: JSON.stringify(payload) },
      this.timeoutMs,
    );
    const body = (await res.json().catch(() => null)) as { swapTransaction?: string; lastValidBlockHeight?: number; prioritizationFeeLamports?: number; error?: string } | null;
    if (!res.ok || !body?.swapTransaction) {
      throw new JupiterApiError(body?.error ?? `Jupiter swap build failed (${res.status})`, res.status, body);
    }
    return {
      transaction: VersionedTransaction.deserialize(decodeBase64(body.swapTransaction)),
      lastValidBlockHeight: body.lastValidBlockHeight ?? 0,
      prioritizationFeeLamports: body.prioritizationFeeLamports,
    };
  }
}

/** Functional wrappers. */
export function getQuote(opts: JupiterClientOptions, p: GetQuoteParams): Promise<JupiterQuoteResponse> {
  return new JupiterClient(opts).getQuote(p);
}

export function buildSwapTx(opts: JupiterClientOptions, p: BuildSwapTxParams): Promise<BuiltJupiterSwap> {
  return new JupiterClient(opts).buildSwapTx(p);
}

/** UI summary of a Jupiter quote. */
export function summarizeJupiterQuote(q: JupiterQuoteResponse): { inAmount: bigint; outAmount: bigint; minOut: bigint; priceImpactPct: number; hops: number; venues: string[] } {
  return {
    inAmount: BigInt(q.inAmount),
    outAmount: BigInt(q.outAmount),
    minOut: BigInt(q.otherAmountThreshold),
    priceImpactPct: Number(q.priceImpactPct) * 100,
    hops: q.routePlan.length,
    venues: q.routePlan.map((s) => s.swapInfo.label ?? s.swapInfo.ammKey),
  };
}
