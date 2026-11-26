"use client";
// Owned by helius-privacy-agent. Singletons for the Privacy Ring adapters + the shared UI store.
import {
  HeliusPrivacyRingClient,
  SimulatedPrivacyRingClient,
  proxyTransport,
  type PrivacyRingClient,
  type SimulatedRingStorage,
} from "@sealed/defi";
import type { PrivacyStatusResponse } from "@sealed/shared";
import { API_BASE, NETWORK } from "../defi/config";

export const PRIVACY_STATUS_PATH = "/api/privacy/status";
const SIM_KEY = "sealed-privacy-ring-sim:v1";

const localRingStorage = (): SimulatedRingStorage => ({
  load: () => {
    try {
      return localStorage.getItem(SIM_KEY);
    } catch {
      return null;
    }
  },
  save: (s) => {
    try {
      localStorage.setItem(SIM_KEY, s);
    } catch {
      /* private mode: memory only */
    }
  },
});

let sim: SimulatedPrivacyRingClient | null = null;
let helius: HeliusPrivacyRingClient | null = null;

/** Demo / unsupported networks: simulated ring persisted per device. Never touches funds. */
export function simulatedRing(): SimulatedPrivacyRingClient {
  sim ??= new SimulatedPrivacyRingClient({ network: NETWORK, storage: localRingStorage(), latencyMs: 650 });
  return sim;
}

/** Real ring: indexer reads go through the API proxy (HELIUS_API_KEY stays server-side). */
export function heliusRing(): HeliusPrivacyRingClient {
  helius ??= new HeliusPrivacyRingClient({ network: NETWORK, transport: proxyTransport(API_BASE) });
  return helius;
}

export function ringFor(simulated: boolean): PrivacyRingClient {
  return simulated ? simulatedRing() : heliusRing();
}

/** Owner key for the ring: the connected wallet, or a device-local demo identity. */
export function privacyOwner(wallet: string | null | undefined): string {
  return wallet ?? "demo-device";
}

/* ------------------------------------------------------------------------------- status (cached) */

/** Used when the API predates /api/privacy/status: behave as the simulated (demo) ring. */
export const FALLBACK_STATUS: PrivacyStatusResponse = {
  available: true,
  network: NETWORK,
  simulated: true,
  escrowFunding: true,
  reason: "Privacy status endpoint unreachable — using the simulated ring",
};

let statusPromise: Promise<PrivacyStatusResponse> | null = null;
let statusValue: PrivacyStatusResponse | null = null;

export function cachedPrivacyStatus(): PrivacyStatusResponse | null {
  return statusValue;
}

export function fetchPrivacyStatus(): Promise<PrivacyStatusResponse> {
  statusPromise ??= (async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6_000);
      const res = await fetch(`${API_BASE}${PRIVACY_STATUS_PATH}`, { signal: ctrl.signal, headers: { accept: "application/json" } }).finally(() => clearTimeout(t));
      const body = (await res.json()) as PrivacyStatusResponse;
      if (!res.ok || typeof body?.available !== "boolean") throw new Error("bad status");
      statusValue = body;
    } catch {
      statusValue = FALLBACK_STATUS;
      statusPromise = null; // retry on next mount
    }
    return statusValue!;
  })();
  return statusPromise;
}
