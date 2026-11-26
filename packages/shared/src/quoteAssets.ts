import type { Network, QuoteAsset, QuoteAssetSymbol } from "./types.js";

/**
 * Quote-asset registry. Devnet "stock" mints are mock SPL mints created by
 * `programs/sealed-launchpad/scripts/init-devnet.ts`; their addresses are written to
 * `programs/sealed-launchpad/devnet-mints.json` and may be overridden via env
 * `QUOTE_MINT_<SYMBOL>_<NETWORK>` (e.g. QUOTE_MINT_NVDAX_DEVNET).
 * Mainnet tokenized-stock mints are intentionally null until verified by the operator.
 */
const WSOL = "So11111111111111111111111111111111111111112";

export const QUOTE_ASSETS: Record<QuoteAssetSymbol, QuoteAsset> = {
  SOL: {
    symbol: "SOL", name: "Solana", kind: "native", decimals: 9,
    mints: { mainnet: WSOL, devnet: WSOL, localnet: WSOL },
    demoUsdPrice: 182.4, jupiterRoutable: true,
  },
  USDC: {
    symbol: "USDC", name: "USD Coin", kind: "stable", decimals: 6,
    mints: {
      mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      localnet: null,
    },
    demoUsdPrice: 1, jupiterRoutable: true,
  },
  NVDAx: {
    symbol: "NVDAx", name: "NVIDIA (tokenized)", kind: "stock", decimals: 8,
    mints: { mainnet: null, devnet: null, localnet: null }, demoUsdPrice: 186.2, jupiterRoutable: true,
  },
  TSLAx: {
    symbol: "TSLAx", name: "Tesla (tokenized)", kind: "stock", decimals: 8,
    mints: { mainnet: null, devnet: null, localnet: null }, demoUsdPrice: 402.7, jupiterRoutable: true,
  },
  TTWOx: {
    symbol: "TTWOx", name: "Take-Two Interactive (tokenized)", kind: "stock", decimals: 8,
    mints: { mainnet: null, devnet: null, localnet: null }, demoUsdPrice: 238.9, jupiterRoutable: true,
  },
  AAPLx: {
    symbol: "AAPLx", name: "Apple (tokenized)", kind: "stock", decimals: 8,
    mints: { mainnet: null, devnet: null, localnet: null }, demoUsdPrice: 251.3, jupiterRoutable: true,
  },
  SPYx: {
    symbol: "SPYx", name: "S&P 500 ETF (tokenized)", kind: "stock", decimals: 8,
    mints: { mainnet: null, devnet: null, localnet: null }, demoUsdPrice: 668.1, jupiterRoutable: true,
  },
};

export const QUOTE_ASSET_LIST: QuoteAsset[] = Object.values(QUOTE_ASSETS);
export const STOCK_QUOTE_ASSETS = QUOTE_ASSET_LIST.filter((q) => q.kind === "stock");

export function isQuoteAssetSymbol(s: string): s is QuoteAssetSymbol {
  return s in QUOTE_ASSETS;
}

/** Resolve a mint, letting env override the static registry. */
export function resolveQuoteMint(symbol: QuoteAssetSymbol, network: Network, env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {})): string | null {
  const key = `QUOTE_MINT_${symbol.toUpperCase()}_${network.toUpperCase()}`;
  return env[key] ?? env[`NEXT_PUBLIC_${key}`] ?? QUOTE_ASSETS[symbol].mints[network];
}

export function quoteAssetByMint(mint: string, network: Network): QuoteAsset | undefined {
  return QUOTE_ASSET_LIST.find((q) => resolveQuoteMint(q.symbol, network) === mint);
}

// ---------------------------------------------------------------------------------------------------------------
// MAINNET quote-asset allowlist (custodial backend). On NETWORK=mainnet only `enabled` assets are accepted for
// launches, deposits and withdrawals, and their mint is taken from HERE (env QUOTE_MINT_*_MAINNET overrides are
// ignored by the API on mainnet so a bad env var can never redirect real deposits).
//
// xStocks (Backed Finance) mints below were verified on 2026-11-26 two ways:
//   1. official source: https://xstocks.com/us/products (product data, `addresses.solana`), and
//   2. on-chain (mainnet getAccountInfo, jsonParsed): account exists, is an initialized mint owned by Token-2022
//      (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb), decimals 8, tokenMetadata name/symbol match.
// They stay DISABLED: they are Token-2022 mints with permanentDelegate / transferHook / pausable /
// defaultAccountState / scaledUiAmount extensions, and the custody deposit parser + payout builder only support
// classic SPL Token. Enabling them needs Token-2022 support in custody (and a review of those extensions).
// ---------------------------------------------------------------------------------------------------------------
export type QuoteTokenProgram = "native" | "spl-token" | "token-2022";
export interface MainnetQuoteAssetStatus {
  /** Accepted on mainnet (launch quote asset / deposits / withdrawals). */
  enabled: boolean;
  /** Verified mainnet mint (null = none verified). Native SOL uses the wrapped-SOL mint id for pricing only. */
  mint: string | null;
  tokenProgram: QuoteTokenProgram;
  /** How the mint was verified. */
  verification: string | null;
  /** Why the asset is disabled on mainnet. */
  disabledReason?: string;
}
const XSTOCK_VERIFIED = "xstocks.com/us/products (addresses.solana) + mainnet getAccountInfo: Token-2022 mint, 8 decimals, metadata symbol match (2026-11-26)";
const TOKEN_2022_DISABLED = "Token-2022 mint (permanent delegate, transfer hook, pausable); custody supports classic SPL Token only";
export const QUOTE_ASSET_MAINNET: Record<QuoteAssetSymbol, MainnetQuoteAssetStatus> = {
  SOL: { enabled: true, mint: WSOL, tokenProgram: "native", verification: "native SOL" },
  USDC: {
    enabled: true, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenProgram: "spl-token",
    verification: "Circle USDC; mainnet getAccountInfo: SPL Token mint, 6 decimals (2026-11-26)",
  },
  NVDAx: { enabled: false, mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", tokenProgram: "token-2022", verification: XSTOCK_VERIFIED, disabledReason: TOKEN_2022_DISABLED },
  TSLAx: { enabled: false, mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", tokenProgram: "token-2022", verification: XSTOCK_VERIFIED, disabledReason: TOKEN_2022_DISABLED },
  TTWOx: { enabled: false, mint: "XssvmC28hqLgtT5kf8R8eAv3mejy4XftJ6MXB8QywTa", tokenProgram: "token-2022", verification: XSTOCK_VERIFIED, disabledReason: TOKEN_2022_DISABLED },
  AAPLx: { enabled: false, mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", tokenProgram: "token-2022", verification: XSTOCK_VERIFIED, disabledReason: TOKEN_2022_DISABLED },
  SPYx: { enabled: false, mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", tokenProgram: "token-2022", verification: XSTOCK_VERIFIED, disabledReason: TOKEN_2022_DISABLED },
};

/**
 * Whether a quote asset can be used on `network`. Mainnet: the allowlist above. Devnet/localnet: native SOL or any
 * asset with a resolved mint (registry or env override) — unchanged behaviour.
 */
export function isQuoteAssetEnabled(symbol: QuoteAssetSymbol, network: Network, env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {})): boolean {
  if (network === "mainnet") return QUOTE_ASSET_MAINNET[symbol]?.enabled === true;
  return QUOTE_ASSETS[symbol].kind === "native" || resolveQuoteMint(symbol, network, env) !== null;
}

/** Human-readable reason a quote asset is unavailable on `network` (null when enabled). */
export function quoteAssetDisabledReason(symbol: QuoteAssetSymbol, network: Network, env?: Record<string, string | undefined>): string | null {
  if (isQuoteAssetEnabled(symbol, network, env)) return null;
  if (network === "mainnet") return `${symbol} is not enabled on mainnet${QUOTE_ASSET_MAINNET[symbol]?.disabledReason ? ` (${QUOTE_ASSET_MAINNET[symbol].disabledReason})` : ""}`;
  return `${symbol} has no mint configured on ${network}`;
}
