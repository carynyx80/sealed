import { PublicKey } from "@solana/web3.js";
import { QUOTE_ASSETS, QUOTE_ASSET_LIST, isQuoteAssetSymbol, type Network, type QuoteAsset, type QuoteAssetSymbol } from "@sealed/shared";

/**
 * Quote-asset mint resolution.
 *
 * Precedence (highest first):
 *   1. env `QUOTE_MINT_<SYMBOL>_<NETWORK>` or `NEXT_PUBLIC_QUOTE_MINT_<SYMBOL>_<NETWORK>`
 *   2. devnet/localnet: mock mints from `programs/sealed-launchpad/devnet-mints.json` (shape `{ "NVDAx": "<mint>", ... }`)
 *      written by scripts/init-devnet.ts; may also be supplied as JSON in env `NEXT_PUBLIC_DEVNET_MINTS`
 *   3. static registry in @sealed/shared (SOL/USDC everywhere; mainnet stock mints are null until the
 *      operator verifies them and sets env — see MAINNET_QUOTE_CONFIG)
 */

export type DevnetMints = Partial<Record<QuoteAssetSymbol, string>>;

export interface ResolvedQuoteAsset extends QuoteAsset {
  mint: string | null;
  /** Where `mint` came from. */
  source: "env" | "devnet-mints" | "registry" | "unset";
  /** Usable for trading on this network (mint configured). */
  enabled: boolean;
}

/** Parse & validate a devnet-mints.json payload. Unknown symbols and invalid keys are dropped. */
export function parseDevnetMints(json: unknown): DevnetMints {
  const raw = typeof json === "string" ? (JSON.parse(json) as unknown) : json;
  if (!raw || typeof raw !== "object") return {};
  const out: DevnetMints = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const sym = Object.keys(QUOTE_ASSETS).find((s) => s.toLowerCase() === k.toLowerCase());
    if (!sym || !isQuoteAssetSymbol(sym) || typeof v !== "string") continue;
    try {
      new PublicKey(v);
      out[sym] = v;
    } catch {
      /* skip invalid */
    }
  }
  return out;
}

/** Node-only: read devnet-mints.json from disk. Returns {} if the file is missing. */
export async function loadDevnetMintsFromFile(path: string): Promise<DevnetMints> {
  try {
    const spec = "node:fs/promises";
    const fs = (await import(/* webpackIgnore: true */ spec)) as typeof import("node:fs/promises");
    return parseDevnetMints(await fs.readFile(path, "utf8"));
  } catch {
    return {};
  }
}

/** Devnet mints from env `NEXT_PUBLIC_DEVNET_MINTS` / `DEVNET_MINTS` (JSON string). */
export function devnetMintsFromEnv(env: Record<string, string | undefined> = defaultEnv()): DevnetMints {
  const s = env.NEXT_PUBLIC_DEVNET_MINTS ?? env.DEVNET_MINTS;
  if (!s) return {};
  try {
    return parseDevnetMints(s);
  } catch {
    return {};
  }
}

function defaultEnv(): Record<string, string | undefined> {
  if (typeof process === "undefined" || !process.env) return {};
  // Next.js inlines NEXT_PUBLIC_* only on literal access, so read the ones we know explicitly.
  return {
    ...process.env,
    NEXT_PUBLIC_DEVNET_MINTS: process.env.NEXT_PUBLIC_DEVNET_MINTS,
  };
}

export interface ResolveOptions {
  env?: Record<string, string | undefined>;
  devnetMints?: DevnetMints;
}

export function resolveQuoteAsset(symbol: QuoteAssetSymbol, network: Network, opts: ResolveOptions = {}): ResolvedQuoteAsset {
  const env = opts.env ?? defaultEnv();
  const base = QUOTE_ASSETS[symbol];
  const key = `QUOTE_MINT_${symbol.toUpperCase()}_${network.toUpperCase()}`;
  const fromEnv = env[key] ?? env[`NEXT_PUBLIC_${key}`];
  if (fromEnv) return { ...base, mint: fromEnv, source: "env", enabled: true };
  if (network !== "mainnet") {
    const dm = { ...devnetMintsFromEnv(env), ...(opts.devnetMints ?? {}) };
    const m = dm[symbol];
    if (m) return { ...base, mint: m, source: "devnet-mints", enabled: true };
  }
  const reg = base.mints[network];
  if (reg) return { ...base, mint: reg, source: "registry", enabled: true };
  return { ...base, mint: null, source: "unset", enabled: false };
}

export function resolveQuoteAssets(network: Network, opts: ResolveOptions = {}): Record<QuoteAssetSymbol, ResolvedQuoteAsset> {
  return Object.fromEntries(QUOTE_ASSET_LIST.map((q) => [q.symbol, resolveQuoteAsset(q.symbol, network, opts)])) as Record<
    QuoteAssetSymbol,
    ResolvedQuoteAsset
  >;
}

export function quoteMintOrThrow(symbol: QuoteAssetSymbol, network: Network, opts: ResolveOptions = {}): PublicKey {
  const r = resolveQuoteAsset(symbol, network, opts);
  if (!r.mint) {
    throw new Error(
      `Quote asset ${symbol} has no mint on ${network}. Set QUOTE_MINT_${symbol.toUpperCase()}_${network.toUpperCase()}` +
        (network === "mainnet" ? "" : " or run scripts/init-devnet.ts to write devnet-mints.json"),
    );
  }
  return new PublicKey(r.mint);
}

/**
 * Mainnet configuration. Tokenized-stock mints are deliberately NOT hard-coded: the operator must verify
 * the issuer's mint (e.g. xStocks are Token-2022 mints) and set env. `tokenProgram` documents which token
 * program the mint uses so tx builders pick the right ATA program.
 */
export const MAINNET_QUOTE_CONFIG: Record<QuoteAssetSymbol, { envKey: string; tokenProgram: "spl-token" | "token-2022"; jupiterRoutable: boolean; note?: string }> = {
  SOL: { envKey: "QUOTE_MINT_SOL_MAINNET", tokenProgram: "spl-token", jupiterRoutable: true, note: "wSOL; native SOL is wrapped in the same tx" },
  USDC: { envKey: "QUOTE_MINT_USDC_MAINNET", tokenProgram: "spl-token", jupiterRoutable: true },
  NVDAx: { envKey: "QUOTE_MINT_NVDAX_MAINNET", tokenProgram: "token-2022", jupiterRoutable: true, note: "verify issuer mint before enabling" },
  TSLAx: { envKey: "QUOTE_MINT_TSLAX_MAINNET", tokenProgram: "token-2022", jupiterRoutable: true, note: "verify issuer mint before enabling" },
  TTWOx: { envKey: "QUOTE_MINT_TTWOX_MAINNET", tokenProgram: "token-2022", jupiterRoutable: true, note: "verify issuer mint before enabling" },
  AAPLx: { envKey: "QUOTE_MINT_AAPLX_MAINNET", tokenProgram: "token-2022", jupiterRoutable: true, note: "verify issuer mint before enabling" },
  SPYx: { envKey: "QUOTE_MINT_SPYX_MAINNET", tokenProgram: "token-2022", jupiterRoutable: true, note: "verify issuer mint before enabling" },
};

/** Devnet mock mints are classic SPL Token mints created by init-devnet.ts. */
export function quoteTokenProgramKind(symbol: QuoteAssetSymbol, network: Network): "spl-token" | "token-2022" {
  return network === "mainnet" ? MAINNET_QUOTE_CONFIG[symbol].tokenProgram : "spl-token";
}
