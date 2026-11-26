"use client";
// Owned by web-offchain-agent. React hooks over the custody API: availability, session, account, deposits,
// withdrawals. Resources are shared stores (one fetch per wallet no matter how many components read them),
// polled while mounted and the tab is visible, and refetched on WebSocket events.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { IS_MAINNET } from "../config";
import { SignInError, signInCapabilities, signerFromAdapter, statusText as signInStatusText, type SignInMethod } from "../wallet/signIn";
import { cancelSignIn, clearSignInError, getSignInFlow, signInWithSigner, subscribeSignInFlow } from "./auth";
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
  /** The connected wallet offers at least one sign-in method (signIn, signMessage or signTransaction). */
  canSign: boolean;
  signingIn: boolean;
  /** Domain named in the sign-in request currently (or last) being signed, shown next to the wallet prompt. */
  messageDomain: string | null;
  /** Friendly error of the last attempt for this wallet ("Sign-in cancelled", "Unlock your wallet and try again"…). */
  error: string | null;
  /** True when the error is a user cancellation: show it muted, not in the error colour. */
  errorQuiet: boolean;
  /** Progress line while signing in ("Approve the sign-in request in Phantom"), else null. */
  statusText: string | null;
  /** Method in use (or last used): the memo transaction path changes the fine print. */
  method: SignInMethod | null;
  walletName: string | null;
  signIn: () => Promise<CustodySession>;
  /** Stop waiting for the wallet (the wallet's own prompt may stay open; it can be closed there). */
  cancel: () => void;
  signOut: () => void;
}

const SERVER_FLOW = getSignInFlow();

export function useCustodySession(): CustodySessionApi {
  const { publicKey, connected, connecting, wallet: selected } = useWallet();
  const adapter = selected?.adapter ?? null;
  const wallet = connected && publicKey ? publicKey.toBase58() : null;
  const { availability } = useCustodyInfo();
  const getSnap = useCallback(() => getSession(wallet), [wallet]);
  const session = useSyncExternalStore(subscribeSessions, getSnap, () => null);
  const flow = useSyncExternalStore(subscribeSignInFlow, getSignInFlow, () => SERVER_FLOW);
  // Capabilities can change after connect (Wallet Standard "change" events), so recompute whenever the key does.
  const caps = useMemo(() => signInCapabilities(wallet ? adapter : null), [adapter, wallet]); // eslint-disable-line react-hooks/exhaustive-deps

  // The wallet switched account or disconnected: abort a flow that was started for the previous account.
  const prevWallet = useRef<string | null>(wallet);
  useEffect(() => {
    const before = prevWallet.current;
    prevWallet.current = wallet;
    if (before && before !== wallet) {
      cancelSignIn(
        before,
        new SignInError(wallet ? "account_changed" : "disconnected", wallet ? "Your wallet switched accounts. Sign in again." : "Wallet disconnected. Connect it again to sign in."),
      );
      clearSignInError(before);
    }
  }, [wallet]);

  const signIn = useCallback(async () => {
    if (!wallet || !adapter) {
      throw new CustodyError(connecting ? "Your wallet is still connecting. Try again in a moment." : "Connect a wallet first", 0, connecting ? "not_ready" : "no_wallet");
    }
    // autoConnect race: the provider says connected but the adapter hasn't caught up yet.
    if (!adapter.connected || adapter.publicKey?.toBase58() !== wallet) {
      throw new CustodyError("Your wallet is still connecting. Try again in a moment.", 0, "not_ready");
    }
    const signer = signerFromAdapter(adapter, wallet, { chain: IS_MAINNET ? "solana:mainnet" : "solana:devnet" });
    return signInWithSigner(signer);
  }, [wallet, adapter, connecting]);

  const signOut = useCallback(() => {
    if (wallet) clearSession(wallet);
  }, [wallet]);
  const cancel = useCallback(() => cancelSignIn(wallet), [wallet]);

  const mine = !!wallet && flow.wallet === wallet;
  const signingIn = mine && !!flow.status;
  const err = mine && !session ? flow.error : null;
  return {
    wallet,
    session,
    signedIn: !!session,
    availability,
    canSign: !!wallet && caps.any,
    signingIn,
    messageDomain: mine ? flow.domain : null,
    error: err?.message ?? null,
    errorQuiet: !!err?.quiet,
    statusText: signingIn ? signInStatusText(flow.status) : null,
    method: mine ? flow.method : null,
    walletName: adapter?.name ?? null,
    signIn,
    cancel,
    signOut,
  };
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
