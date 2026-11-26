"use client";
// Owned by web-offchain-agent. Offchain custodial backend client (contract: packages/shared/src/custody.ts).
//  - session store: SIWS token per wallet, persisted in localStorage, observable
//  - custody availability: one shared probe of GET /api/custody/info; 404 / network failure → "unavailable"
//    with backoff, so a backend without the custody routes produces exactly one failed request, not spam
//  - custodyFetch: authed JSON fetch (Bearer token), 401 clears the session
import { CUSTODY_ROUTES, type CustodyInfoResponse, type ExecutionMode } from "@sealed/shared";
import { API_URL } from "../config";

/* ------------------------------------------------------------------------------------------- mode */

/** NEXT_PUBLIC_EXECUTION_MODE: "offchain" (default, custodial ledger) or "onchain" (Anchor program). */
export const EXECUTION_MODE: ExecutionMode = process.env.NEXT_PUBLIC_EXECUTION_MODE === "onchain" ? "onchain" : "offchain";

export class CustodyError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = "CustodyError";
  }
}

/** True when the browser cannot reach a localhost API from a deployed origin (mirrors lib/api.ts). */
function unreachableByConfig(): boolean {
  if (typeof window === "undefined") return true;
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

/* ---------------------------------------------------------------------------------- availability */

export type CustodyAvailability = "unknown" | "available" | "unavailable";
interface InfoState { availability: CustodyAvailability; info: CustodyInfoResponse | null; checkedTs: number }

let infoState: InfoState = { availability: "unknown", info: null, checkedTs: 0 };
const infoListeners = new Set<() => void>();
let infoInflight: Promise<InfoState> | null = null;
let infoFailures = 0;
let infoRetryAt = 0;

function setInfo(s: InfoState) {
  infoState = s;
  for (const l of infoListeners) l();
}
export function getCustodyInfoState(): InfoState {
  return infoState;
}
export function subscribeCustodyInfo(fn: () => void): () => void {
  infoListeners.add(fn);
  return () => infoListeners.delete(fn);
}

/** Probe /api/custody/info (deduped). `force` bypasses the backoff window. */
export function refreshCustodyInfo(force = false): Promise<InfoState> {
  if (EXECUTION_MODE !== "offchain") {
    if (infoState.availability !== "unavailable") setInfo({ availability: "unavailable", info: null, checkedTs: Date.now() });
    return Promise.resolve(infoState);
  }
  if (infoInflight) return infoInflight;
  if (!force && infoState.availability === "unavailable" && Date.now() < infoRetryAt) return Promise.resolve(infoState);
  if (unreachableByConfig()) {
    setInfo({ availability: "unavailable", info: null, checkedTs: Date.now() });
    infoRetryAt = Number.POSITIVE_INFINITY;
    return Promise.resolve(infoState);
  }
  infoInflight = (async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(`${API_URL}${CUSTODY_ROUTES.info}`, { signal: ctrl.signal });
      if (!res.ok) throw new CustodyError(`custody info ${res.status}`, res.status);
      const info = (await res.json()) as CustodyInfoResponse;
      infoFailures = 0;
      const availability: CustodyAvailability = info.mode === "onchain" ? "unavailable" : "available";
      setInfo({ availability, info, checkedTs: Date.now() });
    } catch {
      infoFailures++;
      // 30s, 60s, 120s … capped at 5 min. A 404 means the API predates the custody routes.
      infoRetryAt = Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(infoFailures - 1, 4));
      setInfo({ availability: "unavailable", info: infoState.info, checkedTs: Date.now() });
    } finally {
      clearTimeout(t);
      infoInflight = null;
    }
    return infoState;
  })();
  return infoInflight;
}

/** Resolve whether trading should go through the custody routes right now. */
export async function custodyReady(): Promise<boolean> {
  if (EXECUTION_MODE !== "offchain") return false;
  const s = infoState.availability === "unknown" ? await refreshCustodyInfo() : infoState;
  return s.availability === "available";
}

/* --------------------------------------------------------------------------------------- session */

export interface CustodySession { token: string; wallet: string; expiresTs: number }
const SESSION_KEY = "sealed-custody-session:v1";

let sessions: Record<string, CustodySession> = {};
let sessionsLoaded = false;
const sessionListeners = new Set<() => void>();
let sessionVersion = 0;

function loadSessions() {
  if (sessionsLoaded || typeof window === "undefined") return;
  sessionsLoaded = true;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) sessions = JSON.parse(raw) as Record<string, CustodySession>;
  } catch {
    sessions = {};
  }
  window.addEventListener("storage", (e) => {
    if (e.key !== SESSION_KEY) return;
    try {
      sessions = e.newValue ? (JSON.parse(e.newValue) as Record<string, CustodySession>) : {};
    } catch {
      sessions = {};
    }
    emitSessions();
  });
}
function persist() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
  } catch {
    /* private mode: session lives in memory */
  }
}
function emitSessions() {
  sessionVersion++;
  for (const l of sessionListeners) l();
}

const nowSec = () => Math.floor(Date.now() / 1000);
/** expiresTs may be seconds or ms; normalise to seconds. */
const toSec = (ts: number) => (ts > 1e12 ? Math.floor(ts / 1000) : ts);

export function getSession(wallet: string | null | undefined): CustodySession | null {
  if (!wallet) return null;
  loadSessions();
  const s = sessions[wallet];
  if (!s) return null;
  if (toSec(s.expiresTs) <= nowSec() + 30) return null;
  return s;
}
export function setSession(s: CustodySession) {
  loadSessions();
  sessions = { ...sessions, [s.wallet]: { ...s, expiresTs: toSec(s.expiresTs) } };
  persist();
  emitSessions();
}
export function clearSession(wallet: string) {
  loadSessions();
  if (!sessions[wallet]) return;
  const next = { ...sessions };
  delete next[wallet];
  sessions = next;
  persist();
  emitSessions();
}
export function subscribeSessions(fn: () => void): () => void {
  loadSessions();
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}
export function getSessionVersion(): number {
  return sessionVersion;
}

/* ------------------------------------------------------------------------------------- fetching */

export interface CustodyFetchInit extends Omit<RequestInit, "body"> {
  body?: unknown;
  /** Wallet whose session token to attach. Omit for public routes. */
  wallet?: string | null;
  timeoutMs?: number;
}

/** JSON fetch against the custody API. Throws CustodyError; 401 clears the stale session. */
export async function custodyFetch<T>(path: string, init: CustodyFetchInit = {}): Promise<T> {
  const { body, wallet, timeoutMs = 10_000, headers, ...rest } = init;
  const session = wallet ? getSession(wallet) : null;
  if (wallet && !session) throw new CustodyError("Sign in to Sealed to continue", 401, "no_session");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...rest,
      signal: ctrl.signal,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(session ? { authorization: `Bearer ${session.token}` } : {}),
        ...((headers as Record<string, string>) ?? {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
    if (!res.ok) {
      if (res.status === 401 && wallet) clearSession(wallet);
      if (res.status === 404 && /route not found/i.test(json?.error ?? "")) void refreshCustodyInfo(true);
      throw new CustodyError(json?.error ?? `Request failed (${res.status})`, res.status, json?.code);
    }
    return json as T;
  } catch (e) {
    if (e instanceof CustodyError) throw e;
    if ((e as Error)?.name === "AbortError") throw new CustodyError("The Sealed API timed out", 0, "timeout");
    throw new CustodyError("The Sealed API is unreachable", 0, "network");
  } finally {
    clearTimeout(t);
  }
}

/** Convenience: is this error a "not enough internal balance" rejection? */
export function isInsufficientBalance(e: unknown): boolean {
  const err = e as CustodyError;
  return err?.code === "insufficient_balance" || /insufficient/i.test(err?.message ?? "");
}
