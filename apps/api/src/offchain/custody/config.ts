import { COMPANY_WALLET, type ExecutionMode, type Network } from "@sealed/shared";
import type { AppConfig } from "../../config.js";

/**
 * Custody-specific env (read here so config.ts stays shared/stable). Secrets are kept only in this object and
 * are never logged or returned by any route.
 *
 *   COMPANY_WALLET             expected company wallet pubkey (defaults to the shared constant)
 *   COMPANY_WALLET_SECRET_KEY  base58 (64-byte or 32-byte seed) or JSON byte array; absent → payouts disabled
 *   ADMIN_TOKEN                shared secret for /api/admin/* (header `x-admin-token`); absent → admin disabled
 *   EXECUTION_MODE             offchain (default) | onchain
 *   DEPOSIT_CONFIRMATIONS      "finalized" (default) or an integer N of confirmed-slot depth
 *   SIWS_DOMAIN                domain shown in the sign-in message (default "sealed.app")
 *   CUSTODY_WORKERS            run DepositWatcher / PayoutWorker (default: follows WORKERS_ENABLED)
 *   DEPOSIT_POLL_MS / PAYOUT_POLL_MS
 */
export interface CustodyConfig {
  companyWallet: string;
  companySecretKey?: string;
  adminToken?: string;
  mode: ExecutionMode;
  /** "finalized" or minimum confirmed-slot depth. */
  depositConfirmations: "finalized" | number;
  siwsDomain: string;
  network: Network;
  /** Helius (or explicit) JSON-RPC url used by custody. Contains the API key — never log it. */
  rpcUrl?: string;
  depositPollMs: number;
  payoutPollMs: number;
  workers: boolean;
}

const nonEmpty = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : undefined);

/** Helius RPC derived from HELIUS_API_KEY (preferred for custody), else the app's SOLANA_RPC_URL. */
export function custodyRpcUrl(network: Network, heliusApiKey?: string, fallback?: string): string | undefined {
  if (heliusApiKey && (network === "mainnet" || network === "devnet")) {
    return `https://${network}.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}`;
  }
  return fallback;
}

export function loadCustodyConfig(cfg: AppConfig, env: Record<string, string | undefined> = process.env, overrides: Partial<CustodyConfig> = {}): CustodyConfig {
  const confRaw = nonEmpty(env.DEPOSIT_CONFIRMATIONS)?.toLowerCase();
  let depositConfirmations: CustodyConfig["depositConfirmations"] = "finalized";
  if (confRaw && confRaw !== "finalized") {
    const n = Number(confRaw);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error("Invalid environment: DEPOSIT_CONFIRMATIONS must be 'finalized' or an integer 1..1000");
    depositConfirmations = n;
  }
  const mode = (cfg.executionMode ?? nonEmpty(env.EXECUTION_MODE) ?? "offchain") as ExecutionMode;
  if (mode !== "offchain" && mode !== "onchain") throw new Error("Invalid environment: EXECUTION_MODE must be offchain|onchain");
  const workersEnv = nonEmpty(env.CUSTODY_WORKERS);
  return {
    companyWallet: nonEmpty(env.COMPANY_WALLET) ?? COMPANY_WALLET,
    companySecretKey: nonEmpty(env.COMPANY_WALLET_SECRET_KEY),
    adminToken: nonEmpty(env.ADMIN_TOKEN),
    mode,
    depositConfirmations,
    siwsDomain: nonEmpty(env.SIWS_DOMAIN) ?? "sealed.app",
    network: cfg.network,
    rpcUrl: custodyRpcUrl(cfg.network, cfg.heliusApiKey, cfg.rpcUrl),
    depositPollMs: Number(nonEmpty(env.DEPOSIT_POLL_MS) ?? 15_000),
    payoutPollMs: Number(nonEmpty(env.PAYOUT_POLL_MS) ?? 10_000),
    workers: workersEnv ? ["1", "true", "yes", "on"].includes(workersEnv.toLowerCase()) : cfg.workersEnabled && !cfg.isDemo,
    ...overrides,
  };
}
