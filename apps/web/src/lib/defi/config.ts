"use client";
// Owned by defi-integrations-agent. Env + small helpers shared by the defi hooks/components.
import { API_URL, DEMO_ENABLED, NETWORK, RPC_URL_OVERRIDE } from "../config";

/** Network + endpoints come from the single source of truth in lib/config. */
export { NETWORK, RPC_URL_OVERRIDE };
export const API_BASE: string = API_URL;

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 10_000);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    });
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status);
    return body as T;
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new ApiError("Request timed out", 0);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pseudo signature for simulated demo actions (clearly prefixed so it is never mistaken for a real tx). */
export function demoSignature(seed = ""): string {
  if (!DEMO_ENABLED) throw new Error("Simulated actions are disabled on mainnet");
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const rnd = crypto.getRandomValues(new Uint8Array(40));
  return `demo${seed.slice(0, 4)}` + Array.from(rnd, (b) => alphabet[b % alphabet.length]).join("");
}

export function errorMessage(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (isUserRejection(e)) return "Request rejected in wallet";
  return m.length > 200 ? `${m.slice(0, 200)}…` : m;
}

/** Wallet "user rejected" across adapters (Phantom 4001, Solflare/Backpack messages, Wallet Standard errors). */
export function isUserRejection(e: unknown): boolean {
  const err = e as { code?: number; message?: string; error?: { code?: number; message?: string }; name?: string };
  if (err?.code === 4001 || err?.error?.code === 4001) return true;
  const m = `${err?.message ?? ""} ${err?.error?.message ?? ""}`;
  return /user rejected|rejected the request|user denied|declined|cancell?ed by user|approval denied|request was rejected/i.test(m);
}
