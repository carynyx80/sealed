import type { BuybackEvent, CreditLedgerEntry, LaunchStatus, LaunchSummary, ProtocolStats, Trade } from "./types.js";

/**
 * WebSocket protocol on `/ws`.
 *
 * Client → server:  { op: "subscribe" | "unsubscribe", channels: Channel[] }   |  { op: "ping" }
 * Server → client:  WsEnvelope  (and { type: "pong" })
 *
 * Channels: "global" (stats, new launches, all buybacks) and `launch:<launchId>` (everything for one launch).
 * Every launch-scoped event is also delivered on "global" if it is a buyback, phase change or creation.
 */
export type WsChannel = "global" | `launch:${string}`;

export type WsClientMessage =
  | { op: "subscribe"; channels: WsChannel[] }
  | { op: "unsubscribe"; channels: WsChannel[] }
  | { op: "ping" };

export type WsEvent =
  | { type: "launch.created"; data: LaunchSummary }
  | { type: "launch.updated"; data: LaunchSummary }
  | { type: "auction.bid_committed"; data: { launchId: string; bidCount: number; escrowedWallets: number; totalEscrowed: number } }
  | { type: "auction.bid_revealed"; data: { launchId: string; revealedCount: number; bidCount: number } }
  | { type: "auction.phase_changed"; data: { launchId: string; from: LaunchStatus; to: LaunchStatus } }
  | { type: "auction.cleared"; data: { launchId: string; clearingPrice: number; totalRaised: number; winners: number } }
  | { type: "trade"; data: Trade }
  | { type: "vault.drip"; data: BuybackEvent & { nextDripTs: number; vaultBalance: number } }
  | { type: "credit.ledger"; data: CreditLedgerEntry & { repaidPct: number } }
  | { type: "credit.flywheel_activated"; data: { launchId: string; ts: number } }
  | { type: "stats.updated"; data: ProtocolStats };

export type WsEventType = WsEvent["type"];

export type WsEnvelope = WsEvent & { channel: WsChannel; ts: number };

export function launchChannel(launchId: string): WsChannel {
  return `launch:${launchId}`;
}
