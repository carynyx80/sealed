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
