/**
 * Jupiter v6 quote + swap transaction builder. Every call has a timeout and returns null on failure —
 * network problems must never crash a worker or request.
 */
export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  [k: string]: unknown;
}

export interface JupiterClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class JupiterClient {
  private base: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(opts: JupiterClientOptions = {}) {
    this.base = (opts.baseUrl ?? "https://quote-api.jup.ag/v6").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T | null> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, { ...init, signal: ctrl.signal });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  /** amount in input-mint atoms. */
  async quote(args: { inputMint: string; outputMint: string; amount: bigint | string; slippageBps?: number; onlyDirectRoutes?: boolean }): Promise<JupiterQuote | null> {
    const q = new URLSearchParams({
      inputMint: args.inputMint,
      outputMint: args.outputMint,
      amount: args.amount.toString(),
      slippageBps: String(args.slippageBps ?? 100),
      onlyDirectRoutes: String(args.onlyDirectRoutes ?? false),
    });
    return this.req<JupiterQuote>(`/quote?${q.toString()}`);
  }

  /** Returns a base64 serialized VersionedTransaction for `userPublicKey` to sign, or null. */
  async buildSwapTx(args: { quote: JupiterQuote; userPublicKey: string; wrapAndUnwrapSol?: boolean; priorityLamports?: number }): Promise<string | null> {
    const body = {
      quoteResponse: args.quote,
      userPublicKey: args.userPublicKey,
      wrapAndUnwrapSol: args.wrapAndUnwrapSol ?? true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: args.priorityLamports ?? "auto",
    };
    const res = await this.req<{ swapTransaction: string }>(`/swap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return res?.swapTransaction ?? null;
  }
}
