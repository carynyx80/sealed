import type { Network } from "@sealed/shared";

/**
 * Single source of truth for the web app's network + endpoints. Every other module (wallet providers, explorer
 * links, badges, demo fallbacks, defi hooks) reads these values; nothing else parses NEXT_PUBLIC_NETWORK.
 * NEXT_PUBLIC_* must be read with literal property access so Next.js can inline them at build time.
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:4000/ws";

export function parseNetwork(raw: string | undefined): Network {
  const n = (raw ?? "").trim().toLowerCase();
  if (n === "mainnet" || n === "mainnet-beta") return "mainnet";
  if (n === "localnet" || n === "localhost") return "localnet";
  return "devnet";
}

export const NETWORK: Network = parseNetwork(process.env.NEXT_PUBLIC_NETWORK);
export const IS_MAINNET = NETWORK === "mainnet";

/**
 * Demo/simulation paths (client-side demo world, demo launch creation, simulated ring, simulated fills/claims)
 * are only ever allowed off mainnet. On mainnet the app shows "unavailable" states instead of fake data.
 */
export const DEMO_ENABLED = !IS_MAINNET;

/** User-visible network badge text: "Mainnet" on mainnet builds, empty elsewhere (test clusters are never named in the UI). */
export const NETWORK_LABEL: string = IS_MAINNET ? "Mainnet" : "";

/** User-visible name for a network value in running text. Test clusters are shown generically, never by cluster name. */
export function networkName(network?: Network | string | null): string {
  return network === "mainnet" ? "mainnet" : "test network";
}

/**
 * WalletConnect (Reown) project id: enables the "WalletConnect" option (QR on desktop, wallet-app deep link on
 * phones; Jupiter Mobile, Trust, OKX, …). Public by design (it identifies the dApp, it is not a secret); create one
 * free at cloud.reown.com. Unset → the option is hidden. Outside production builds `window.__SEALED_WC_PROJECT_ID__`
 * can override it for local testing.
 */
const WALLETCONNECT_PROJECT_ID_ENV = (process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "").trim();
export function walletConnectProjectId(): string {
  if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
    const o = (window as unknown as { __SEALED_WC_PROJECT_ID__?: unknown }).__SEALED_WC_PROJECT_ID__;
    if (typeof o === "string" && o.trim()) return o.trim();
  }
  return WALLETCONNECT_PROJECT_ID_ENV;
}

/** Explicit RPC override (e.g. a dedicated provider URL). Never put a secret API key here: it ships to browsers. */
const rawRpc = process.env.NEXT_PUBLIC_RPC_URL || undefined;
/** A devnet/testnet RPC left over in a mainnet build's env is ignored (it would silently point wallets at devnet). */
export const RPC_URL_OVERRIDE: string | undefined = rawRpc && IS_MAINNET && /devnet|testnet/i.test(rawRpc) ? undefined : rawRpc;

/**
 * Browser RPC endpoint for the wallet ConnectionProvider: NEXT_PUBLIC_RPC_URL if set, else the Sealed API's
 * allowlisted JSON-RPC proxy (`/api/rpc`, which forwards to Helius with the key kept server-side). Localnet
 * defaults to the local validator. The `?cluster=devnet` tag on non-mainnet builds is ignored by the API but lets
 * the Solana Mobile Wallet Adapter infer the right cluster from the endpoint URL. The proxy is HTTP-only (no
 * websocket), so every flow confirms by polling (lib/solana/tx.ts), never by subscription.
 */
export const RPC_ENDPOINT: string =
  RPC_URL_OVERRIDE ?? (NETWORK === "localnet" ? "http://127.0.0.1:8899" : `${API_URL}/api/rpc${IS_MAINNET ? "" : "?cluster=devnet"}`);

/** Explorer links: Solscan; mainnet links never carry a `?cluster=` parameter. */
function clusterQuery(network: Network): string {
  if (network === "mainnet") return "";
  if (network === "localnet") return "?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899";
  return "?cluster=devnet";
}
/** A mainnet build only ever links mainnet; elsewhere the record's own network (if known) wins. */
function linkNetwork(network?: Network | null): Network {
  return IS_MAINNET ? "mainnet" : network ?? NETWORK;
}
export function explorerTxUrl(signature: string, network?: Network | null): string {
  return `https://solscan.io/tx/${encodeURIComponent(signature)}${clusterQuery(linkNetwork(network))}`;
}
export function explorerAccountUrl(address: string, network?: Network | null): string {
  return `https://solscan.io/account/${encodeURIComponent(address)}${clusterQuery(linkNetwork(network))}`;
}
export function explorerTokenUrl(mint: string, network?: Network | null): string {
  return `https://solscan.io/token/${encodeURIComponent(mint)}${clusterQuery(linkNetwork(network))}`;
}
/** True for signatures that have a real explorer page (not ledger receipts or demo pseudo-signatures). */
export function isOnchainSignature(sig: string | null | undefined): sig is string {
  return !!sig && !sig.startsWith("ledger:") && !sig.startsWith("demo") && !sig.startsWith("simring") && /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(sig);
}
