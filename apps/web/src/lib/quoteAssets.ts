"use client";
// Which quote assets the web app offers. Mainnet: only the shared mainnet allowlist (QUOTE_ASSET_MAINNET, the same
// table the API enforces: SOL + USDC today; xStocks stay off until custody supports Token-2022). Off mainnet:
// everything, as before (devnet mock mints are resolved by the API).
import { QUOTE_ASSET_LIST, QUOTE_ASSET_MAINNET, isQuoteAssetEnabled, type QuoteAsset, type QuoteAssetSymbol } from "@sealed/shared";
import { IS_MAINNET, NETWORK } from "./config";

export function quoteAssetOffered(symbol: QuoteAssetSymbol): boolean {
  return IS_MAINNET ? isQuoteAssetEnabled(symbol, NETWORK) : true;
}

export function offeredQuoteAssets(): QuoteAsset[] {
  return QUOTE_ASSET_LIST.filter((q) => quoteAssetOffered(q.symbol));
}

/** Mainnet: the pinned, verified mint for an SPL quote asset (null for native SOL or unverified assets). */
export function pinnedMainnetMint(symbol: QuoteAssetSymbol): string | null {
  const s = QUOTE_ASSET_MAINNET[symbol];
  return s && s.tokenProgram !== "native" ? s.mint : null;
}
