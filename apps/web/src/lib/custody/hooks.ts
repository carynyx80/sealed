"use client";
// Owned by web-offchain-agent. React hooks over the custody API: availability, session, account, deposits,
// withdrawals. Resources are shared stores (one fetch per wallet no matter how many components read them),
// polled while mounted and the tab is visible, and refetched on WebSocket events.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  CUSTODY_ROUTES,
  type AccountResponse,
  type AssetId,
  type BalanceRow,
  type CustodyInfoResponse,
  type DepositRecord,
  type QuoteAssetSymbol,
  type WithdrawalRecord,
} from "@sealed/shared";
import { liveSocket } from "../ws";
import { signInWithSolana } from "./auth";
import {
  CustodyError,
  clearSession,
  custodyFetch,
  getCustodyInfoState,
  getSession,
  refreshCustodyInfo,
  subscribeCustodyInfo,
  subscribeSessions,
  type CustodyAvailability,
  type CustodySession,
} from "./client";

/* ----------------------------------------------------------------------------------- availability */

const SERVER_INFO = { availability: "unknown" as CustodyAvailability, info: null as CustodyInfoResponse | null, checkedTs: 0 };

export function useCustodyInfo(): { availability: CustodyAvailability; info: CustodyInfoResponse | null; refresh: () => void } {
  const s = useSyncExternalStore(subscribeCustodyInfo, getCustodyInfoState, () => SERVER_INFO);
  useEffect(() => {
    void refreshCustodyInfo();
    // Re-probe every minute: picks up the custody routes once the API is restarted; refreshes proof-of-reserves.
    const t = setInterval(() => document.visibilityState === "visible" && void refreshCustodyInfo(), 60_000);
    return () => clearInterval(t);
  }, []);
  const refresh = useCallback(() => void refreshCustodyInfo(true), []);
  return { availability: s.availability, info: s.info, refresh };
}

/* ---------------------------------------------------------------------------------------- session */

export interface CustodySessionApi {
  wallet: string | null;
  session: CustodySession | null;
  signedIn: boolean;
  availability: CustodyAvailability;
  canSign: boolean;
  signingIn: boolean;
  error: string | null;
  signIn: () => Promise<CustodySession>;
  signOut: () => void;
}

export function useCustodySession(): CustodySessionApi {
  const { publicKey, signMessage, connected } = useWallet();
  const wallet = connected && publicKey ? publicKey.toBase58() : null;
  const { availability } = useCustodyInfo();
  const getSnap = useCallback(() => getSession(wallet), [wallet]);
  const session = useSyncExternalStore(subscribeSessions, getSnap, () => null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setError(null), [wallet]);

  const signIn = useCallback(async () => {
    if (!wallet) throw new CustodyError("Connect a wallet first", 0, "no_wallet");
    if (!signMessage) throw new CustodyError("This wallet cannot sign messages", 0, "no_sign");
    setSigningIn(true);
    setError(null);
    try {
      return await signInWithSolana(wallet, signMessage);
    } catch (e) {
      const m = (e as Error)?.message ?? String(e);
      setError(/reject/i.test(m) ? "Sign-in request rejected in wallet" : m);
      throw e;
    } finally {
      setSigningIn(false);
    }
  }, [wallet, signMessage]);

  const signOut = useCallback(() => {
    if (wallet) clearSession(wallet);
  }, [wallet]);

  return { wallet, session, signedIn: !!session, availability, canSign: !!signMessage, signingIn, error, signIn, signOut };
}

/* ------------------------------------------------------------------------------- shared resources */

interface ResState<T> { data: T | null; error: string | null; loading: boolean; ts: number }
const IDLE: ResState<never> = { data: null, error: null, loading: false, ts: 0 };

class Resource<T> {
  state: ResState<T> = { data: null, error: null, loading: true, ts: 0 };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private pollers = new Map<symbol, number>();

  constructor(private readonly fetcher: () => Promise<T>) {}

  private emit(next: Partial<ResState<T>>) {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  refetch = (): Promise<void> => {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const data = await this.fetcher();
        this.emit({ data, error: null, loading: false, ts: Date.now() });
      } catch (e) {
        this.emit({ error: (e as Error)?.message ?? String(e), loading: false });
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  };

  private interval(): number {
    let ms = Number.POSITIVE_INFINITY;
    for (const v of this.pollers.values()) ms = Math.min(ms, v);
    return ms;
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ms = this.interval();
    if (!Number.isFinite(ms) || this.listeners.size === 0) return;
    this.timer = setTimeout(async () => {
      if (document.visibilityState === "visible") await this.refetch();
      this.schedule();
    }, ms);
  }

  /** Change how often an existing subscriber wants polling (e.g. a deposit being tracked). */
  setPoll(id: symbol, ms: number) {
    this.pollers.set(id, ms);
    this.schedule();
  }

  subscribe(fn: () => void, pollMs: number): { unsubscribe: () => void; id: symbol } {
    const id = Symbol("poller");
    this.listeners.add(fn);
    this.pollers.set(id, pollMs);
    if (this.state.ts === 0 || Date.now() - this.state.ts > 3000) void this.refetch();
    this.schedule();
    return {
      id,
      unsubscribe: () => {
        this.listeners.delete(fn);
        this.pollers.delete(id);
        this.schedule();
      },
    };
  }
}

const resources = new Map<string, Resource<unknown>>();
function resource<T>(key: string, fetcher: () => Promise<T>): Resource<T> {
  let r = resources.get(key) as Resource<T> | undefined;
  if (!r) {
    r = new Resource<T>(fetcher);
    resources.set(key, r as Resource<unknown>);
  }
  return r;
}

/** Refetch every custody resource for a wallet (or all wallets). Call after any trade/deposit/withdrawal. */
export function invalidateCustody(wallet?: string | null) {
  for (const [k, r] of resources) if (!wallet || k.endsWith(`|${wallet}`)) void r.refetch();
}

// One WS subscription for all custody resources; debounced refetch on any account-affecting event.
let wsOff: (() => void) | null = null;
let wsRefs = 0;
let wsDebounce: ReturnType<typeof setTimeout> | null = null;
const WS_REFRESH = /^(account|deposit|withdrawal|balance|ledger)\.|^auction\.(cleared|phase_changed|bid_committed)$/;
function retainWs() {
  wsRefs++;
  if (wsOff) return;
  wsOff = liveSocket().subscribe(["global"], (msg) => {
    if (!WS_REFRESH.test(String((msg as { type: string }).type))) return;
    if (wsDebounce) clearTimeout(wsDebounce);
    wsDebounce = setTimeout(() => invalidateCustody(), 400);
  });
}
function releaseWs() {
  wsRefs = Math.max(0, wsRefs - 1);
  if (wsRefs === 0 && wsOff) {
    wsOff();
    wsOff = null;
  }
}

function useResource<T>(key: string | null, fetcher: () => Promise<T>, pollMs: number, fastPollMs?: number | null) {
  const r = useMemo(() => (key ? resource<T>(key, fetcher) : null), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pollId, setPollId] = useState<symbol | null>(null);
  const subscribe = useCallback(
    (fn: () => void) => {
      if (!r) return () => undefined;
      const { unsubscribe, id } = r.subscribe(fn, pollMs);
      setPollId(id);
      retainWs();
      return () => {
        unsubscribe();
        releaseWs();
      };
    },
    [r, pollMs],
  );
  const state = useSyncExternalStore(subscribe, () => (r ? r.state : IDLE), () => IDLE as ResState<T>);
  useEffect(() => {
    if (r && pollId) r.setPoll(pollId, fastPollMs ?? pollMs);
  }, [r, pollId, fastPollMs, pollMs]);
  const refetch = useCallback(() => (r ? r.refetch() : Promise.resolve()), [r]);
  return { ...(state as ResState<T>), refetch };
}

/** The signed-in wallet when custody is available and a session exists, else null. */
function useAuthedWallet(): string | null {
  const { wallet, session, availability } = useCustodySession();
  return availability === "available" && session && wallet ? wallet : null;
}

export function useCustodyAccount() {
  const wallet = useAuthedWallet();
  return useResource<AccountResponse>(wallet ? `account|${wallet}` : null, () => custodyFetch<AccountResponse>(CUSTODY_ROUTES.me, { wallet }), 15_000);
}

export function useDeposits(fastPoll = false) {
  const wallet = useAuthedWallet();
  return useResource<DepositRecord[]>(
    wallet ? `deposits|${wallet}` : null,
    async () => (await custodyFetch<{ deposits: DepositRecord[] }>(CUSTODY_ROUTES.deposits, { wallet })).deposits ?? [],
    30_000,
    fastPoll ? 4_000 : null,
  );
}

export function useWithdrawals(fastPoll = false) {
  const wallet = useAuthedWallet();
  return useResource<WithdrawalRecord[]>(
    wallet ? `withdrawals|${wallet}` : null,
    async () => (await custodyFetch<{ withdrawals: WithdrawalRecord[] }>(CUSTODY_ROUTES.withdrawals, { wallet })).withdrawals ?? [],
    30_000,
    fastPoll ? 5_000 : null,
  );
}

export interface BalanceView {
  /** True when we know the user's internal balance (custody available + signed in + account loaded). */
  known: boolean;
  available: number;
  locked: number;
  row: BalanceRow | null;
}

export function balanceOf(account: AccountResponse | null, asset: AssetId): BalanceView {
  if (!account) return { known: false, available: 0, locked: 0, row: null };
  const row = account.balances.find((b) => b.asset === asset) ?? null;
  return { known: true, available: row?.available ?? 0, locked: row?.locked ?? 0, row };
}

/** Internal balance for one asset (quote symbol or `tok:<launchId>`). */
export function useCustodyBalance(asset: AssetId): BalanceView & { loading: boolean } {
  const acc = useCustodyAccount();
  return { ...balanceOf(acc.data, asset), loading: acc.loading };
}

export const quoteAssetId = (s: QuoteAssetSymbol): AssetId => s;
export const tokenAssetId = (launchId: string): AssetId => `tok:${launchId}`;
