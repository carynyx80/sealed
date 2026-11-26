import { COMPANY_WALLET, type ExecutionMode, type Network } from "@sealed/shared";
import type { AppConfig } from "../../config.js";

/**
 * Custody-specific env (read here so config.ts stays shared/stable). Secrets are kept only in this object and
 * are never logged or returned by any route.
 *
 *   COMPANY_WALLET             expected company wallet pubkey (defaults to the shared constant)
 *   COMPANY_WALLET_SECRET_KEY  base58 (64-byte or 32-byte seed) or JSON byte array; absent → payouts disabled
 *   ADMIN_TOKEN                shared secret for /api/admin/* (header `x-admin-token`); absent → admin disabled.
 *                              MAINNET without ADMIN_TOKEN: withdrawals are still accepted but EVERY one goes to
 *                              pending_approval (nothing is auto-paid; logged loudly at startup).
 *   EXECUTION_MODE             offchain (default) | onchain
 *   DEPOSIT_CONFIRMATIONS      "finalized" (default; always the default on mainnet) or an integer N of confirmed-slot
 *                              depth (mainnet: N must be ≥ 32, otherwise startup fails)
 *   SIWS_DOMAIN                domain shown in the sign-in message (default "sealed.app")
 *   CUSTODY_WORKERS            run DepositWatcher / PayoutWorker (default: follows WORKERS_ENABLED)
 *   DEPOSIT_POLL_MS / PAYOUT_POLL_MS
 *
 * Test-only hooks (never honoured on NETWORK=mainnet; used by tests/e2e/custody.e2e.test.ts):
 *   ENABLE_TEST_CREDIT         "true" → POST /api/admin/test-credit credits a wallet without an on-chain deposit
 *   ENABLE_TEST_CLOCK          "true" → POST /api/admin/test-clock advances the offchain engine clock
 *                              (also ignored when NODE_ENV=production)
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
  /** mainnet && no ADMIN_TOKEN → every withdrawal is routed to pending_approval (no auto-approval). */
  manualApprovalOnly: boolean;
  /** ENABLE_TEST_CREDIT && network !== mainnet. */
  testCredit: boolean;
  /** ENABLE_TEST_CLOCK && network !== mainnet && NODE_ENV !== production. */
  testClock: boolean;
}

const nonEmpty = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : undefined);
const truthy = (v: string | undefined) => ["1", "true", "yes", "on"].includes((nonEmpty(v) ?? "").toLowerCase());

/** Helius RPC derived from HELIUS_API_KEY (preferred for custody), else the app's SOLANA_RPC_URL. */
export function custodyRpcUrl(network: Network, heliusApiKey?: string, fallback?: string): string | undefined {
  if (heliusApiKey && (network === "mainnet" || network === "devnet")) {
    return `https://${network}.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}`;
  }
  return fallback;
}

/** Smallest numeric DEPOSIT_CONFIRMATIONS accepted on mainnet (≈ finalized depth). */
export const MAINNET_MIN_CONFIRMATIONS = 32;

export function loadCustodyConfig(cfg: AppConfig, env: Record<string, string | undefined> = process.env, overrides: Partial<CustodyConfig> = {}): CustodyConfig {
  const confRaw = nonEmpty(env.DEPOSIT_CONFIRMATIONS)?.toLowerCase();
  let depositConfirmations: CustodyConfig["depositConfirmations"] = "finalized";
  if (confRaw && confRaw !== "finalized") {
    const n = Number(confRaw);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error("Invalid environment: DEPOSIT_CONFIRMATIONS must be 'finalized' or an integer 1..1000");
    if (cfg.network === "mainnet" && n < MAINNET_MIN_CONFIRMATIONS) {
      throw new Error(`Invalid environment: DEPOSIT_CONFIRMATIONS on mainnet must be 'finalized' (default) or ≥ ${MAINNET_MIN_CONFIRMATIONS}`);
    }
    depositConfirmations = n;
  }
  const mode = (cfg.executionMode ?? nonEmpty(env.EXECUTION_MODE) ?? "offchain") as ExecutionMode;
  if (mode !== "offchain" && mode !== "onchain") throw new Error("Invalid environment: EXECUTION_MODE must be offchain|onchain");
  const workersEnv = nonEmpty(env.CUSTODY_WORKERS);
  const adminToken = nonEmpty(env.ADMIN_TOKEN);
  const out: CustodyConfig = {
    companyWallet: nonEmpty(env.COMPANY_WALLET) ?? COMPANY_WALLET,
    companySecretKey: nonEmpty(env.COMPANY_WALLET_SECRET_KEY),
    adminToken,
    mode,
    depositConfirmations,
    siwsDomain: nonEmpty(env.SIWS_DOMAIN) ?? "sealed.app",
    network: cfg.network,
    rpcUrl: custodyRpcUrl(cfg.network, cfg.heliusApiKey, cfg.rpcUrl),
    depositPollMs: Number(nonEmpty(env.DEPOSIT_POLL_MS) ?? 15_000),
    payoutPollMs: Number(nonEmpty(env.PAYOUT_POLL_MS) ?? 10_000),
    workers: workersEnv ? truthy(workersEnv) : cfg.workersEnabled && !cfg.isDemo,
    testCredit: truthy(env.ENABLE_TEST_CREDIT) && cfg.network !== "mainnet",
    testClock: truthy(env.ENABLE_TEST_CLOCK) && cfg.network !== "mainnet" && cfg.nodeEnv !== "production",
    manualApprovalOnly: false,
    ...overrides,
  };
  // Derived AFTER overrides so they can never be switched back on for mainnet.
  if (out.network === "mainnet") {
    out.testCredit = false;
    out.testClock = false;
    if (!out.adminToken) out.manualApprovalOnly = true;
  }
  return out;
}
