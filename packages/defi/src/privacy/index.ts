import type { Network } from "@sealed/shared";
import { HeliusPrivacyRingClient, type HeliusSprBindings, type SprTransport } from "./helius.js";
import { SimulatedPrivacyRingClient, type SimulatedRingStorage } from "./simulated.js";
import { SPR_NETWORKS, type PrivacyRingClient } from "./types.js";

export * from "./types.js";
export * from "./helius.js";
export * from "./simulated.js";

export interface CreatePrivacyRingOptions {
  network: Network;
  /** Force the simulated ring (demo mode). */
  simulated?: boolean;
  /** Required for the real ring: `proxyTransport(apiBase)` in browsers, `directTransport(...)` on servers. */
  transport?: SprTransport;
  sdk?: HeliusSprBindings;
  storage?: SimulatedRingStorage;
  latencyMs?: number;
}

/** Real Helius ring on mainnet/devnet when a transport is supplied; otherwise the simulated ring. */
export function createPrivacyRingClient(o: CreatePrivacyRingOptions): PrivacyRingClient {
  if (!o.simulated && o.transport && SPR_NETWORKS.includes(o.network)) {
    return new HeliusPrivacyRingClient({ network: o.network, transport: o.transport, sdk: o.sdk });
  }
  return new SimulatedPrivacyRingClient({ network: o.network, storage: o.storage, latencyMs: o.latencyMs });
}
