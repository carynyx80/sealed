import type { Network } from "@sealed/shared";

/**
 * Privacy Ring env (custodial private deposits / payouts). Secrets are never stored here.
 *
 *   PRIVACY_RING_ENABLED          "true" turns the feature on (default OFF). Off → every private route answers
 *                                 503 {enabled:false, reason} and nothing touches the SDK or the chain.
 *   SPR_INDEXER_URL / SPR_PROVER_URL  optional overrides; default = the Helius RPC root's `/v1/spr` namespace
 *                                 (derived by the SDK from https://{network}.helius-rpc.com/?api-key=HELIUS_API_KEY)
 *   PRIVACY_POLL_MS               private deposit watcher interval (default 20000)
 *   PRIVACY_REPROBE_MS            ring availability / registration re-check interval (default 300000)
 *   PRIVACY_MIN_SOL / PRIVACY_MIN_USDC  smallest private deposit credited (default 0.001 SOL / 1 USDC)
 *   PRIVACY_PRIORITY_FEE_LAMPORTS optional whole-transaction priority fee for ring transactions
 */
export interface PrivacyConfig {
  enabled: boolean;
  network: Network;
  indexerUrl?: string;
  proverUrl?: string;
  pollMs: number;
  reprobeMs: number;
  minAmount: { SOL: number; USDC: number };
  priorityFeeLamports?: bigint;
}

const nonEmpty = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : undefined);
const truthy = (v: string | undefined) => ["1", "true", "yes", "on"].includes((nonEmpty(v) ?? "").toLowerCase());
const num = (v: string | undefined, d: number, min: number) => {
  const n = Number(nonEmpty(v) ?? d);
  return Number.isFinite(n) && n >= min ? n : d;
};

export function loadPrivacyConfig(network: Network, env: Record<string, string | undefined> = process.env, overrides: Partial<PrivacyConfig> = {}): PrivacyConfig {
  const fee = nonEmpty(env.PRIVACY_PRIORITY_FEE_LAMPORTS);
  return {
    enabled: truthy(env.PRIVACY_RING_ENABLED),
    network,
    indexerUrl: nonEmpty(env.SPR_INDEXER_URL),
    proverUrl: nonEmpty(env.SPR_PROVER_URL),
    pollMs: num(env.PRIVACY_POLL_MS, 20_000, 1_000),
    reprobeMs: num(env.PRIVACY_REPROBE_MS, 300_000, 5_000),
    minAmount: { SOL: num(env.PRIVACY_MIN_SOL, 0.001, 0), USDC: num(env.PRIVACY_MIN_USDC, 1, 0) },
    ...(fee && /^\d{1,12}$/.test(fee) ? { priorityFeeLamports: BigInt(fee) } : {}),
    ...overrides,
  };
}
