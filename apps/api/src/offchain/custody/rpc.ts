/**
 * Minimal Solana JSON-RPC client for custody (Helius endpoint). Deliberately fetch-based (not web3 Connection)
 * so tests can inject a mock and so the API key in the URL can never leak into error messages / logs.
 * Retries transient failures (network, timeout, 429, 5xx) with exponential backoff + jitter.
 */

export type Commitment = "processed" | "confirmed" | "finalized";

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown | null;
  memo: string | null;
  blockTime: number | null;
  confirmationStatus?: Commitment | null;
}
export interface SignatureStatus {
  slot: number;
  confirmations: number | null;
  err: unknown | null;
  confirmationStatus: Commitment | null;
}

/** jsonParsed getTransaction result (subset we rely on). */
export interface ParsedInstruction {
  programId: string;
  program?: string;
  parsed?: unknown;
  accounts?: string[];
  data?: string;
  stackHeight?: number | null;
}
export interface ParsedTransaction {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown | null;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    innerInstructions?: { index: number; instructions: ParsedInstruction[] }[] | null;
    logMessages?: string[] | null;
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: { pubkey: string; signer: boolean; writable: boolean; source?: string }[];
      instructions: ParsedInstruction[];
      recentBlockhash?: string;
    };
  };
}
export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount?: number | null; uiAmountString?: string };
}

export interface SolanaRpc {
  getSignaturesForAddress(address: string, opts: { limit?: number; before?: string; until?: string; commitment?: Commitment }): Promise<SignatureInfo[]>;
  getTransaction(signature: string, commitment: Commitment): Promise<ParsedTransaction | null>;
  getSlot(commitment: Commitment): Promise<number>;
  getBalance(address: string, commitment?: Commitment): Promise<bigint>;
  /** Raw token amount of a token account; null if the account does not exist. */
  getTokenAccountBalance(address: string, commitment?: Commitment): Promise<bigint | null>;
  getAccountExists(address: string, commitment?: Commitment): Promise<boolean>;
  getLatestBlockhash(commitment?: Commitment): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getBlockHeight(commitment?: Commitment): Promise<number>;
  sendRawTransaction(base64Tx: string): Promise<string>;
  getSignatureStatuses(signatures: string[]): Promise<(SignatureStatus | null)[]>;
}

export class RpcError extends Error {
  constructor(message: string, public readonly code?: number, public readonly retriable = false, public readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

export type FetchFn = typeof fetch;

export interface HttpRpcOptions {
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpSolanaRpc implements SolanaRpc {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private id = 0;

  /** `url` may contain an API key: it is never included in thrown errors. */
  constructor(private readonly url: string, opts: HttpRpcOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 12_000;
    this.retries = opts.retries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 400;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.once<T>(method, params);
      } catch (e) {
        last = e;
        const retriable = e instanceof RpcError ? e.retriable : true;
        if (!retriable || attempt === this.retries) break;
        const delay = this.baseDelayMs * 2 ** attempt * (0.75 + Math.random() * 0.5);
        await this.sleep(Math.min(delay, 10_000));
      }
    }
    if (last instanceof RpcError) throw last;
    throw new RpcError(`rpc ${method} failed: ${redact((last as Error)?.message ?? String(last))}`, undefined, true);
  }

  private async once<T>(method: string, params: unknown[]): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: ctrl.signal,
      });
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      throw new RpcError(aborted ? `rpc ${method} timed out` : `rpc ${method} unreachable: ${redact((e as Error)?.message ?? "")}`, undefined, true);
    } finally {
      clearTimeout(t);
    }
    if (res.status === 429 || res.status >= 500) throw new RpcError(`rpc ${method} HTTP ${res.status}`, res.status, true);
    let body: { result?: T; error?: { code: number; message: string; data?: unknown } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new RpcError(`rpc ${method} returned non-JSON (HTTP ${res.status})`, res.status, res.status >= 500);
    }
    if (!res.ok && !body?.error) throw new RpcError(`rpc ${method} HTTP ${res.status}`, res.status, false);
    if (body.error) {
      // -32005 node behind / -32004 block not available / -32007 slot skipped → transient
      const transient = [-32005, -32004, -32014, -32016].includes(body.error.code);
      throw new RpcError(`rpc ${method}: ${redact(body.error.message)}`, body.error.code, transient, body.error.data);
    }
    return body.result as T;
  }

  getSignaturesForAddress(address: string, opts: { limit?: number; before?: string; until?: string; commitment?: Commitment }) {
    const o: Record<string, unknown> = { limit: opts.limit ?? 100, commitment: opts.commitment ?? "finalized" };
    if (opts.before) o.before = opts.before;
    if (opts.until) o.until = opts.until;
    return this.call<SignatureInfo[]>("getSignaturesForAddress", [address, o]);
  }
  getTransaction(signature: string, commitment: Commitment) {
    return this.call<ParsedTransaction | null>("getTransaction", [signature, { encoding: "jsonParsed", commitment, maxSupportedTransactionVersion: 0 }]);
  }
  getSlot(commitment: Commitment) {
    return this.call<number>("getSlot", [{ commitment }]);
  }
  async getBalance(address: string, commitment: Commitment = "confirmed") {
    const r = await this.call<{ value: number }>("getBalance", [address, { commitment }]);
    return BigInt(r.value);
  }
  async getTokenAccountBalance(address: string, commitment: Commitment = "confirmed") {
    try {
      const r = await this.call<{ value: { amount: string } }>("getTokenAccountBalance", [address, { commitment }]);
      return BigInt(r.value.amount);
    } catch (e) {
      if (e instanceof RpcError && !e.retriable && /could not find account|invalid param/i.test(e.message)) return null;
      throw e;
    }
  }
  async getAccountExists(address: string, commitment: Commitment = "confirmed") {
    const r = await this.call<{ value: unknown | null }>("getAccountInfo", [address, { commitment, encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    return r.value != null;
  }
  async getLatestBlockhash(commitment: Commitment = "confirmed") {
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment }]);
    return r.value;
  }
  getBlockHeight(commitment: Commitment = "confirmed") {
    return this.call<number>("getBlockHeight", [{ commitment }]);
  }
  /** Not retried here: the payout worker reconciles by signature instead (never blind-resend). */
  async sendRawTransaction(base64Tx: string) {
    return this.once<string>("sendTransaction", [base64Tx, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 }]);
  }
  async getSignatureStatuses(signatures: string[]) {
    const r = await this.call<{ value: (SignatureStatus | null)[] }>("getSignatureStatuses", [signatures, { searchTransactionHistory: true }]);
    return r.value;
  }
}

/** Strip API keys from any string before logging / returning it. */
export function redact(s: string): string {
  return s.replace(/api-key=[^&\s"']+/gi, "api-key=***").replace(/https?:\/\/[^\s"']*helius-rpc\.com[^\s"']*/gi, "https://<helius-rpc>");
}
