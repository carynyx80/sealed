import type { BuybackEvent, CreditLedgerEntry, HolderReward, LaunchSummary, PricePoint, ProtocolStats, Trade, Network } from "./types.js";

/**
 * REST contract. Base path `/api`. All responses are JSON; errors are `{ error: string, details?: unknown }`.
 *
 * GET  /api/health                         → HealthResponse
 * GET  /api/stats                          → ProtocolStats
 * GET  /api/launches?status=&quote=&limit= → LaunchListResponse   (status also accepts tab aliases: auctions|vaults|graduated; quote: SOL|USDC|stocks|all|<symbol>)
 * GET  /api/launches/:idOrMint             → LaunchSummary
 * GET  /api/launches/:idOrMint/trades      → TradesResponse        (?limit=)
 * GET  /api/launches/:idOrMint/chart       → ChartResponse         (?interval=1m|5m|1h)
 * POST /api/launches                       → LaunchSummary         (body CreateLaunchInput; demo mode creates in-memory; else returns unsigned tx)
 * GET  /api/auctions/:idOrMint             → AuctionResponse
 * POST /api/auctions/:idOrMint/demo-bid    → AuctionResponse       (demo mode only; body DemoBidInput)
 * GET  /api/vaults/:mint                   → VaultResponse
 * GET  /api/rewards/:mint/:wallet          → HolderReward
 * GET  /api/revenue                        → RevenueResponse
 * GET  /api/relayer/pubkey                 → RelayerPubkeyResponse
 * POST /api/relayer/reveals                → { accepted: true, id: string }  (body SealedRevealEnvelope)
 * GET  /llms.txt                           → text/plain agent guide
 * WS   /ws                                 → see ws.ts
 */
export const API_ROUTES = {
  health: "/api/health",
  stats: "/api/stats",
  launches: "/api/launches",
  launch: (id: string) => `/api/launches/${id}`,
  trades: (id: string) => `/api/launches/${id}/trades`,
  chart: (id: string) => `/api/launches/${id}/chart`,
  auction: (id: string) => `/api/auctions/${id}`,
  demoBid: (id: string) => `/api/auctions/${id}/demo-bid`,
  vault: (mint: string) => `/api/vaults/${mint}`,
  rewards: (mint: string, wallet: string) => `/api/rewards/${mint}/${wallet}`,
  revenue: "/api/revenue",
  relayerPubkey: "/api/relayer/pubkey",
  relayerReveals: "/api/relayer/reveals",
  privacyStatus: "/api/privacy/status",
  privacyRpc: "/api/privacy/rpc",
  llms: "/llms.txt",
  ws: "/ws",
} as const;

export interface HealthResponse {
  ok: true;
  network: Network;
  isDemo: boolean;
  db: "postgres" | "memory";
  cache: "redis" | "memory";
  rpc: string | null;
  programId: string;
  uptimeSec: number;
  version: string;
}

export interface LaunchListResponse {
  launches: LaunchSummary[];
  total: number;
}

export interface TradesResponse {
  trades: Trade[];
}

export interface ChartResponse {
  points: PricePoint[];
}

export interface AuctionResponse {
  launch: LaunchSummary;
  /** Public-only: count & escrow totals. Individual bid sizes / prices are never returned before clearing. */
  serverTimeTs: number;
}

export interface VaultResponse {
  launch: LaunchSummary;
  recentBuybacks: BuybackEvent[];
  serverTimeTs: number;
}

export interface RevenueResponse {
  stats: ProtocolStats;
  recentBuybacks: BuybackEvent[];
  ledger: CreditLedgerEntry[];
  /** Daily series for the dashboard charts. */
  daily: { date: string; feesUsd: number; creditRepaidUsd: number; burnedUsd: number; holderPayoutsUsd: number }[];
}

export interface RelayerPubkeyResponse {
  /** base64 x25519 public key to seal reveal payloads to. */
  pubkey: string;
  relayerAddress: string; // base58 fee payer that submits reveals
}

export type { HolderReward };
