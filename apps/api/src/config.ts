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
  IDL_PATH: optStr,
  DEMO_TICK_MS: z.coerce.number().int().positive().default(1000),
  WORKERS_ENABLED: z.preprocess(emptyToUndef, boolish.default(true)),
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
  const isDemo = e.DEMO_MODE ?? !e.SOLANA_RPC_URL;
  const cors = e.CORS_ORIGIN.trim();
  const corsOrigin: AppConfig["corsOrigin"] = cors === "*" ? true : cors.includes(",") ? cors.split(",").map((s) => s.trim()).filter(Boolean) : cors;
  return {
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
    version: "0.1.0",
    ...overrides,
  };
}
