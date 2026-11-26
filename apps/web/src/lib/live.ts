"use client";
/**
 * Live data hooks. Data comes from the REST API and is kept fresh via the WebSocket
 * (subscribe to `global` / `launch:<id>`, debounced refetch on events, slow polling as a
 * safety net). When the API is unreachable, hooks re-read the client-side demo world on
 * every 1s simulation tick instead (devnet/localnet only; on mainnet they retry and never fake data). All time-dependent values are null until mount
 * so server and client markup always match.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { launchChannel, type BuybackEvent, type LaunchSummary, type PricePoint, type ProtocolStats, type RevenueResponse, type Trade, type WsChannel, type WsEnvelope } from "@sealed/shared";
import { api, getDataSource, onDataSource, type DataSource } from "./api";
import { subscribeDemo } from "./demoStore";
import { liveSocket } from "./ws";

// ---------- clock ----------
let clockTimer: ReturnType<typeof setInterval> | null = null;
const clockListeners = new Set<(n: number) => void>();
function subscribeClock(fn: (n: number) => void) {
  clockListeners.add(fn);
  if (!clockTimer) {
    clockTimer = setInterval(() => {
      const n = Date.now() / 1000;
      for (const l of clockListeners) l(n);
    }, 1000);
  }
  return () => {
    clockListeners.delete(fn);
    if (!clockListeners.size && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

/** Unix seconds, ticking every 1s. `null` during SSR and the first client render. */
export function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now() / 1000);
    return subscribeClock(setNow);
  }, []);
  return now;
}

export function useDataSource(): DataSource {
  const [s, setS] = useState<DataSource>("unknown");
  useEffect(() => {
    setS(getDataSource());
    return onDataSource(setS);
  }, []);
  return s;
}

// ---------- generic live resource ----------
interface LiveOpts<T> {
  channels?: WsChannel[];
  /** Decide what to do with a WS event: return new data, "refetch", or undefined to ignore. */
  onWs?: (prev: T | undefined, msg: WsEnvelope) => T | "refetch" | undefined;
  pollMs?: number;
}

export interface LiveState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useLive<T>(key: string | null, fetcher: () => Promise<T>, opts: LiveOpts<T> = {}): LiveState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const source = useDataSource();
  const seq = useRef(0);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const load = useCallback(() => {
    const id = ++seq.current;
    fetchRef
      .current()
      .then((d) => {
        if (id !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (id !== seq.current) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (key === null) return;
    setLoading(true);
    load();
  }, [key, load]);

  // Demo mode: re-read the simulated world each tick.
  useEffect(() => {
    if (key === null || source !== "demo") return;
    return subscribeDemo(load);
  }, [key, source, load]);

  // Offline (mainnet, API unreachable): no demo world; keep the last good data and retry every few seconds.
  const wasOffline = useRef(false);
  useEffect(() => {
    if (key === null) return;
    if (source === "api" && wasOffline.current) load(); // back online: refresh right away
    wasOffline.current = source === "offline";
    if (source !== "offline") return;
    const t = setInterval(() => document.visibilityState === "visible" && load(), 5_000);
    return () => clearInterval(t);
  }, [key, source, load]);

  // API mode: websocket + polling.
  const chanKey = (opts.channels ?? []).join(",");
  useEffect(() => {
    if (key === null || source !== "api") return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const refetchSoon = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        load();
      }, 400);
    };
    const chans = optsRef.current.channels ?? [];
    const unsub = chans.length
      ? liveSocket().subscribe(chans, (msg) => {
          if (!chans.includes(msg.channel)) return;
          const h = optsRef.current.onWs;
          if (!h) return refetchSoon();
          setData((prev) => {
            const r = h(prev, msg);
            if (r === "refetch") {
              refetchSoon();
              return prev;
            }
            return r === undefined ? prev : r;
          });
        })
      : () => {};
    const poll = setInterval(load, optsRef.current.pollMs ?? 15_000);
    return () => {
      unsub();
      clearInterval(poll);
      if (debounce) clearTimeout(debounce);
    };
  }, [key, source, chanKey, load]);

  return { data, loading: loading && data === undefined, error, refetch: load };
}

// ---------- concrete hooks ----------
const LAUNCH_EVENTS = new Set(["launch.created", "launch.updated", "auction.phase_changed", "auction.cleared", "credit.flywheel_activated", "vault.drip", "credit.ledger"]);

export function useLaunches() {
  return useLive<LaunchSummary[]>("launches", api.launches, {
    channels: ["global"],
    onWs: (prev, msg) => {
      if (!prev) return "refetch";
      if (msg.type === "launch.created") return [msg.data, ...prev.filter((l) => l.id !== msg.data.id)];
      if (msg.type === "launch.updated") return prev.map((l) => (l.id === msg.data.id ? msg.data : l));
      if (msg.type === "auction.bid_committed") {
        const d = msg.data;
        return prev.map((l) => (l.id === d.launchId ? { ...l, auction: { ...l.auction, bidCount: d.bidCount, escrowedWallets: d.escrowedWallets, totalEscrowed: d.totalEscrowed } } : l));
      }
      return LAUNCH_EVENTS.has(msg.type) ? "refetch" : undefined;
    },
    pollMs: 20_000,
  });
}

export function useStats() {
  return useLive<ProtocolStats>("stats", api.stats, {
    channels: ["global"],
    onWs: (_prev, msg) => (msg.type === "stats.updated" ? msg.data : undefined),
    pollMs: 15_000,
  });
}

export function useRevenue() {
  return useLive<RevenueResponse>("revenue", api.revenue, {
    channels: ["global"],
    onWs: (prev, msg) => {
      if (!prev) return "refetch";
      if (msg.type === "stats.updated") return { ...prev, stats: msg.data };
      if (msg.type === "vault.drip") {
        const { nextDripTs: _n, vaultBalance: _v, ...ev } = msg.data;
        return { ...prev, recentBuybacks: [ev as BuybackEvent, ...prev.recentBuybacks.filter((b) => b.id !== ev.id)].slice(0, 40) };
      }
      if (msg.type === "credit.ledger") {
        const { repaidPct: _r, ...entry } = msg.data;
        return { ...prev, ledger: [entry, ...prev.ledger.filter((x) => x.id !== entry.id)].slice(0, 60) };
      }
      return undefined;
    },
    pollMs: 20_000,
  });
}

export interface LaunchRoom {
  launch: LaunchSummary | null;
  trades: Trade[];
  chart: PricePoint[];
  buybacks: BuybackEvent[];
}

export function useLaunchRoom(idOrMint: string) {
  const fetcher = useCallback(async (): Promise<LaunchRoom> => {
    const launch = await api.launch(idOrMint);
    if (!launch) return { launch: null, trades: [], chart: [], buybacks: [] };
    const graduated = launch.status === "live" || launch.status === "flywheel";
    const [trades, chart, buybacks] = graduated
      ? await Promise.all([api.trades(launch.id), api.chart(launch.id), api.buybacks(launch.mint, launch.id)])
      : [[], [], []];
    return { launch, trades, chart, buybacks };
  }, [idOrMint]);

  // We need the launch id for the channel; resolve it from the first load.
  const [channelId, setChannelId] = useState<string | null>(null);
  const state = useLive<LaunchRoom>(`room:${idOrMint}`, fetcher, {
    channels: channelId ? [launchChannel(channelId)] : [],
    onWs: (prev, msg) => {
      if (!prev?.launch) return "refetch";
      if (msg.type === "launch.updated") return { ...prev, launch: msg.data };
      if (msg.type === "trade") return { ...prev, trades: [msg.data, ...prev.trades.filter((t) => t.id !== msg.data.id)].slice(0, 80) };
      if (msg.type === "auction.bid_committed") {
        const d = msg.data;
        return { ...prev, launch: { ...prev.launch, auction: { ...prev.launch.auction, bidCount: d.bidCount, escrowedWallets: d.escrowedWallets, totalEscrowed: d.totalEscrowed } } };
      }
      if (msg.type === "auction.bid_revealed") {
        const d = msg.data;
        return { ...prev, launch: { ...prev.launch, auction: { ...prev.launch.auction, revealedCount: d.revealedCount, bidCount: d.bidCount } } };
      }
      return "refetch";
    },
    pollMs: 15_000,
  });
  const resolvedId = state.data?.launch?.id ?? null;
  useEffect(() => {
    if (resolvedId) setChannelId(resolvedId);
  }, [resolvedId]);
  return state;
}
