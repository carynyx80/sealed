import type { Network, PrivacyStatusResponse } from "@sealed/shared";
import type { AppConfig } from "../config.js";

/**
 * Server-side client for the Helius Solana Privacy Rings (SPR) indexer. The browser never sees HELIUS_API_KEY:
 * it POSTs {method, params} to /api/privacy/rpc and we forward to
 *   https://{network}.helius-rpc.com/v1/spr/{method}?api-key=…     (docs: https://www.helius.dev/docs/privacy/endpoints.md)
 * Only the JSON-RPC methods documented at https://www.helius.dev/docs/api-reference/privacy/llms.txt are forwarded.
 * Mirrors packages/defi/src/privacy (the API does not depend on @sealed/defi).
 */

export const SPR_RPC_METHODS = [
  "getEncryptedUtxosByTags",
  "getShieldedTransactionsByTags",
  "getShieldedTransactionsBySignature",
  "getShieldedTransactionsByNullifiers",
  "getMerkleProofs",
  "getNonInclusionProofs",
  "getNullifierQueueElements",
  "getUserRecords",
] as const;
export type SprRpcMethod = (typeof SPR_RPC_METHODS)[number];
export const isSprRpcMethod = (m: unknown): m is SprRpcMethod => typeof m === "string" && (SPR_RPC_METHODS as readonly string[]).includes(m);

/** Solana Privacy Program (same id on mainnet + devnet): https://www.helius.dev/docs/privacy/addresses.md */
export const SPR_PRIVACY_PROGRAM = "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW";
export const SIMULATED_RING_ID = "simulated-default-ring";

export const ESCROW_UNSUPPORTED_REASON =
  "Program escrow cannot receive confidential transfers yet: needs the commit_bid_shielded upgrade (docs/PRIVACY.md).";

export interface SprRpcResult {
  status: number;
  body: unknown;
}

export type FetchFn = typeof fetch;

export class HeliusPrivacyService {
  private statusCache: { at: number; value: PrivacyStatusResponse } | null = null;

  constructor(
    private readonly cfg: Pick<AppConfig, "network" | "heliusApiKey" | "isDemo">,
    private readonly fetchFn: FetchFn = fetch,
    private readonly statusTtlMs = 60_000,
  ) {}

  get network(): Network {
    return this.cfg.network;
  }

  /** Real Helius endpoint usable from this API (key configured + hosted network). */
  get proxyEnabled(): boolean {
    return !!this.cfg.heliusApiKey && (this.cfg.network === "mainnet" || this.cfg.network === "devnet");
  }

  private url(method: SprRpcMethod): string {
    return `https://${this.cfg.network}.helius-rpc.com/v1/spr/${method}?api-key=${encodeURIComponent(this.cfg.heliusApiKey ?? "")}`;
  }

  /** Strip the API key from anything that might be echoed back to a client. */
  redact(s: string): string {
    const k = this.cfg.heliusApiKey;
    let out = s.replace(/api-key=[^&\s"']+/gi, "api-key=***");
    if (k) out = out.split(k).join("***");
    return out;
  }

  async call(method: SprRpcMethod, params: Record<string, unknown>, timeoutMs = 10_000): Promise<SprRpcResult> {
    if (!this.proxyEnabled) return { status: 503, body: { error: { code: -32601, message: "Helius Privacy RPC proxy disabled (no HELIUS_API_KEY or unsupported network)" } } };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(this.url(method), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "sealed", method, params }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(this.redact(text));
      } catch {
        body = { error: { code: -32700, message: `upstream returned non-JSON (HTTP ${res.status})` } };
      }
      return { status: res.ok ? 200 : res.status >= 500 ? 502 : res.status, body };
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      return { status: aborted ? 504 : 502, body: { error: { code: -32000, message: aborted ? "Helius privacy RPC timed out" : this.redact(`Helius privacy RPC unreachable: ${(e as Error).message}`) } } };
    } finally {
      clearTimeout(t);
    }
  }

  async status(): Promise<PrivacyStatusResponse> {
    const network = this.cfg.network;
    if (this.cfg.isDemo) {
      return { available: true, network, simulated: true, ringId: SIMULATED_RING_ID, escrowFunding: true, reason: "Demo mode: simulated Privacy Ring (no real funds)" };
    }
    if (network === "localnet") return { available: false, network, simulated: false, escrowFunding: false, reason: "Helius Privacy Rings are not hosted on localnet" };
    if (!this.cfg.heliusApiKey) return { available: false, network, simulated: false, escrowFunding: false, reason: "HELIUS_API_KEY not configured" };
    if (this.statusCache && Date.now() - this.statusCache.at < this.statusTtlMs) return this.statusCache.value;

    // Liveness probe with the cheapest documented read (getUserRecords for one key).
    const r = await this.call("getUserRecords", { owners: [SPR_PRIVACY_PROGRAM] }, 5_000);
    const err = (r.body as { error?: { message?: string } } | null)?.error;
    const value: PrivacyStatusResponse =
      r.status === 200 && !err
        ? { available: true, network, simulated: false, ringId: SPR_PRIVACY_PROGRAM, escrowFunding: false, reason: ESCROW_UNSUPPORTED_REASON }
        : { available: false, network, simulated: false, ringId: SPR_PRIVACY_PROGRAM, escrowFunding: false, reason: err?.message ?? `Helius privacy RPC returned HTTP ${r.status}` };
    this.statusCache = { at: Date.now(), value };
    return value;
  }
}
