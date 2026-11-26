"use client";
/**
 * Typed REST client for the Sealed API with a transparent client-side demo fallback.
 * If the API is unreachable (or errors), every call resolves from the local demo world
 * so the UI is always alive. `getDataSource()` tells the UI which one it is showing.
 */
import {
  API_ROUTES,
  demoStats,
  type ChartResponse,
  type CreateLaunchInput,
  type LaunchListResponse,
  type LaunchSummary,
  type PricePoint,
  type ProtocolStats,
  type RevenueResponse,
  type Trade,
  type TradesResponse,
  type VaultResponse,
  type BuybackEvent,
} from "@sealed/shared";
import { API_URL } from "./config";
import { createDemoLaunch, demoRevenue, findDemoLaunch, getDemoWorld } from "./demoStore";

export type DataSource = "api" | "demo" | "unknown";

let source: DataSource = "unknown";
let offlineUntil = 0;
let failures = 0;

/** A localhost API is unreachable from a deployed (non-local) page — skip straight to demo, no console noise. */
function apiUnreachableByConfig(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const api = new URL(API_URL);
    const local = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
    if (local(api.hostname) && !local(window.location.hostname)) return true;
    if (window.location.protocol === "https:" && api.protocol === "http:" && !local(api.hostname)) return true;
  } catch {
    return true;
  }
  return false;
}
const sourceListeners = new Set<(s: DataSource) => void>();

function setSource(s: DataSource) {
  if (s === source) return;
  source = s;
  for (const l of sourceListeners) l(s);
}
export function getDataSource(): DataSource {
  return source;
}
export function onDataSource(fn: (s: DataSource) => void): () => void {
  sourceListeners.add(fn);
  return () => sourceListeners.delete(fn);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** One shared reachability probe so concurrent first loads don't each hit a dead API. */
let probe: Promise<boolean> | null = null;
function probeApi(): Promise<boolean> {
  if (!probe) {
    probe = (async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      try {
        const res = await fetch(`${API_URL}${API_ROUTES.health}`, { signal: ctrl.signal });
        return res.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(t);
      }
    })().then((ok) => {
      if (!ok) {
        failures++;
        offlineUntil = Date.now() + Math.min(300_000, 15_000 * 2 ** Math.min(failures - 1, 5));
        setSource("demo");
      }
      setTimeout(() => (probe = null), ok ? 60_000 : 0);
      return ok;
    });
  }
  return probe;
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 4000): Promise<T> {
  if (apiUnreachableByConfig()) {
    setSource("demo");
    throw new ApiError(0, "api not reachable from this origin");
  }
  if (Date.now() < offlineUntil) throw new ApiError(0, "api offline (cooldown)");
  if (source !== "api" && !(await probeApi())) throw new ApiError(0, "api unreachable");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: ctrl.signal,
      // Only send content-type with a body: a bare GET stays a "simple" CORS request (no preflight).
      headers: init?.body ? { "content-type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const j = (await res.json()) as { error?: string };
        if (j?.error) msg = j.error;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, msg);
    }
    failures = 0;
    setSource("api");
    return (await res.json()) as T;
  } catch (e) {
    if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) {
      // Network failure / server down → back off for a while, use demo world.
      failures++;
      offlineUntil = Date.now() + Math.min(300_000, 15_000 * 2 ** Math.min(failures - 1, 5));
      setSource("demo");
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** Run an API call; on network/server failure resolve from the demo world. 4xx (e.g. 404) on a live API propagates. */
async function withFallback<T>(live: () => Promise<T>, demo: () => T): Promise<T> {
  try {
    return await live();
  } catch (e) {
    if (e instanceof ApiError && e.status >= 400 && e.status < 500 && source === "api") throw e;
    return demo();
  }
}

const clone = <T,>(v: T): T => (typeof structuredClone === "function" ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T));
const now = () => Math.floor(Date.now() / 1000);

export const api = {
  stats(): Promise<ProtocolStats> {
    return withFallback(
      () => request<ProtocolStats>(API_ROUTES.stats),
      () => demoStats(getDemoWorld(), now()),
    );
  },

  launches(): Promise<LaunchSummary[]> {
    return withFallback(
      async () => (await request<LaunchListResponse>(`${API_ROUTES.launches}?limit=200`)).launches,
      () => clone(getDemoWorld().launches),
    );
  },

  async launch(idOrMint: string): Promise<LaunchSummary | null> {
    try {
      return await withFallback(
        () => request<LaunchSummary>(API_ROUTES.launch(encodeURIComponent(idOrMint))),
        () => {
          const L = findDemoLaunch(idOrMint);
          if (!L) throw new ApiError(404, "not found");
          return clone(L);
        },
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // A launch created offline lives only in the local demo world.
        const L = findDemoLaunch(idOrMint);
        return L ? clone(L) : null;
      }
      throw e;
    }
  },

  trades(idOrMint: string): Promise<Trade[]> {
    return withFallback(
      async () => (await request<TradesResponse>(`${API_ROUTES.trades(encodeURIComponent(idOrMint))}?limit=60`)).trades,
      () => {
        const L = findDemoLaunch(idOrMint);
        return L ? clone((getDemoWorld().trades[L.id] ?? []).slice(0, 60)) : [];
      },
    );
  },

  chart(idOrMint: string): Promise<PricePoint[]> {
    return withFallback(
      async () => (await request<ChartResponse>(`${API_ROUTES.chart(encodeURIComponent(idOrMint))}?interval=5m`)).points,
      () => {
        const L = findDemoLaunch(idOrMint);
        return L ? clone(getDemoWorld().charts[L.id] ?? []) : [];
      },
    );
  },

  buybacks(mint: string, launchId: string): Promise<BuybackEvent[]> {
    return withFallback(
      async () => (await request<VaultResponse>(API_ROUTES.vault(encodeURIComponent(mint)))).recentBuybacks,
      () => clone(getDemoWorld().buybacks.filter((b) => b.launchId === launchId).slice(0, 30)),
    );
  },

  revenue(): Promise<RevenueResponse> {
    return withFallback(
      () => request<RevenueResponse>(API_ROUTES.revenue),
      () => clone(demoRevenue()),
    );
  },

  /** Create a launch. If the API is unreachable, the launch is added to the local demo world. */
  async createLaunch(input: CreateLaunchInput): Promise<{ launch: LaunchSummary; offline: boolean }> {
    try {
      const launch = await request<LaunchSummary>(API_ROUTES.launches, { method: "POST", body: JSON.stringify(input) }, 8000);
      return { launch, offline: false };
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) throw e;
      return { launch: createDemoLaunch(input), offline: true };
    }
  },
};
