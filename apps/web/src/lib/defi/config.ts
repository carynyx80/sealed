"use client";
// Owned by defi-integrations-agent. Env + small helpers shared by the defi hooks/components.
import type { Network } from "@sealed/shared";

/** NEXT_PUBLIC_* must be read with literal property access so Next.js can inline them. */
export const API_BASE: string = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

export const NETWORK: Network = ((): Network => {
  const n = process.env.NEXT_PUBLIC_NETWORK;
  return n === "mainnet" || n === "localnet" || n === "devnet" ? n : "devnet";
})();

export const RPC_URL_OVERRIDE: string | undefined = process.env.NEXT_PUBLIC_RPC_URL || undefined;

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
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const rnd = crypto.getRandomValues(new Uint8Array(40));
  return `demo${seed.slice(0, 4)}` + Array.from(rnd, (b) => alphabet[b % alphabet.length]).join("");
}

export function errorMessage(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/User rejected|rejected the request/i.test(m)) return "Request rejected in wallet";
  return m.length > 200 ? `${m.slice(0, 200)}…` : m;
}
