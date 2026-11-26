import { z } from "zod";
import { PROGRAM_ID, type Network } from "@sealed/shared";

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())));

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optStr = z.preprocess(emptyToUndef, z.string().optional());

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  DEMO_MODE: z.preprocess(emptyToUndef, boolish.optional()),
  DATABASE_URL: optStr,
  REDIS_URL: optStr,
  SOLANA_RPC_URL: optStr,
  SOLANA_WS_URL: optStr,
  HELIUS_API_KEY: optStr,
  NETWORK: z.preprocess(emptyToUndef, z.enum(["mainnet", "devnet", "localnet"]).default("devnet")),
  PROGRAM_ID: z.preprocess(emptyToUndef, z.string().default(PROGRAM_ID)),
  RELAYER_SECRET_KEY: optStr,
  RELAYER_BOX_SEED: z.preprocess(emptyToUndef, z.string().regex(/^[0-9a-fA-F]{64}$/, "RELAYER_BOX_SEED must be 32-byte hex").optional()),
  KEEPER_SECRET_KEY: optStr,
  CORS_ORIGIN: z.preprocess(emptyToUndef, z.string().default("*")),
  JUPITER_API_URL: z.preprocess(emptyToUndef, z.string().default("https://quote-api.jup.ag/v6")),
  /** Jupiter Price API v3 base (mainnet withdrawal-limit pricing). `?ids=<mints>` is appended. */
  JUPITER_PRICE_API_URL: z.preprocess(emptyToUndef, z.string().url().default("https://lite-api.jup.ag/price/v3")),
  /** Optional Jupiter API key (sent as x-api-key; needed for api.jup.ag, not for lite-api). */
  JUPITER_API_KEY: optStr,
  IDL_PATH: optStr,
  DEMO_TICK_MS: z.coerce.number().int().positive().default(1000),
  WORKERS_ENABLED: z.preprocess(emptyToUndef, boolish.default(true)),
  EXECUTION_MODE: z.preprocess(emptyToUndef, z.enum(["offchain", "onchain"]).default("offchain")),
  OFFCHAIN_TICK_MS: z.coerce.number().int().positive().default(2000),
  /** Public base URL of this API (absolute image URLs). Default: derived from the request (x-forwarded-proto/host). */
  PUBLIC_API_URL: z.preprocess(emptyToUndef, z.string().url().optional()),
  /** Token image uploads allowed per wallet per hour. */
  UPLOAD_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(20),
});

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  logLevel: string;
  isDemo: boolean;
  databaseUrl?: string;
  redisUrl?: string;
  rpcUrl?: string;
  wsUrl?: string;
  heliusApiKey?: string;
  network: Network;
  programId: string;
  relayerSecretKey?: string;
  relayerBoxSeed?: string;
  keeperSecretKey?: string;
  corsOrigin: string | string[] | boolean;
  jupiterApiUrl: string;
  idlPath?: string;
  demoTickMs: number;
  workersEnabled: boolean;
  /** offchain (default): custodial ledger engine; onchain: Anchor program (non-custodial). */
  executionMode: "offchain" | "onchain";
  offchainTickMs: number;
  jupiterPriceApiUrl: string;
  jupiterApiKey?: string;
  /** Public API origin (no trailing slash) used for absolute upload URLs; undefined → derived per request. */
  publicApiUrl?: string;
  uploadRateLimitPerHour: number;
  /**
   * Configuration problems detected at load time that were corrected fail-safe (e.g. DEMO_MODE forced off on
   * mainnet). buildServer logs each one at ERROR level on startup.
   */
  startupErrors: string[];
  version: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${msg}`);
  }
  const e = parsed.data;
  let rpcUrl = e.SOLANA_RPC_URL;
  if (!rpcUrl && e.HELIUS_API_KEY) {
    rpcUrl = `https://${e.NETWORK === "mainnet" ? "mainnet" : "devnet"}.helius-rpc.com/?api-key=${e.HELIUS_API_KEY}`;
  }
  const startupErrors: string[] = [];
  let isDemo = e.DEMO_MODE ?? !e.SOLANA_RPC_URL;
  // MAINNET GUARD: the demo world (simulated launches, demo bids, demo ticker) must never run next to real funds.
  // DEMO_MODE=true (or the implicit demo default when SOLANA_RPC_URL is unset) is FORCED OFF on mainnet.
  if (e.NETWORK === "mainnet" && isDemo) {
    isDemo = false;
    if (e.DEMO_MODE === true) startupErrors.push("NETWORK=mainnet with DEMO_MODE=true is not allowed — DEMO_MODE has been FORCED OFF. Remove DEMO_MODE from the mainnet environment.");
  }
  const cors = e.CORS_ORIGIN.trim();
  const corsOrigin: AppConfig["corsOrigin"] = cors === "*" ? true : cors.includes(",") ? cors.split(",").map((s) => s.trim()).filter(Boolean) : cors;
  const out: AppConfig = {
    port: e.PORT,
    host: e.HOST,
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    isDemo,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    rpcUrl,
    wsUrl: e.SOLANA_WS_URL,
    heliusApiKey: e.HELIUS_API_KEY,
    network: e.NETWORK,
    programId: e.PROGRAM_ID,
    relayerSecretKey: e.RELAYER_SECRET_KEY,
    relayerBoxSeed: e.RELAYER_BOX_SEED,
    keeperSecretKey: e.KEEPER_SECRET_KEY,
    corsOrigin,
    jupiterApiUrl: e.JUPITER_API_URL.replace(/\/$/, ""),
    idlPath: e.IDL_PATH,
    demoTickMs: e.DEMO_TICK_MS,
    workersEnabled: e.WORKERS_ENABLED,
    executionMode: e.EXECUTION_MODE,
    offchainTickMs: e.OFFCHAIN_TICK_MS,
    jupiterPriceApiUrl: e.JUPITER_PRICE_API_URL.replace(/\/$/, ""),
    jupiterApiKey: e.JUPITER_API_KEY,
    publicApiUrl: e.PUBLIC_API_URL ? new URL(e.PUBLIC_API_URL).origin : undefined,
    uploadRateLimitPerHour: e.UPLOAD_RATE_LIMIT_PER_HOUR,
    startupErrors,
    version: "0.1.0",
    ...overrides,
  };
  // Overrides cannot re-enable demo on mainnet either.
  if (out.network === "mainnet" && out.isDemo) {
    out.isDemo = false;
    out.startupErrors = [...out.startupErrors, "isDemo override ignored on mainnet — demo mode FORCED OFF."];
  }
  return out;
}
