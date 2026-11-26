"use client";
// Wallet connection helpers: device detection, mobile deep links, "last connected wallet" memory (so autoConnect
// only reconnects a wallet the user actually connected before), and a tiny toast store for wallet errors.
import { useSyncExternalStore } from "react";

/* ---------------------------------------------------------------------------------------- device */

/** Phone/tablet browser (iOS, iPadOS, Android). Client-only: returns false during SSR. */
export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  // iPadOS 13+ reports a desktop Mac UA.
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

export function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "");
}

/** Universal links that open the current page inside the wallet app's in-app browser (wallet is injected there). */
export function walletDeepLinks(href: string, origin: string): { phantom: string; solflare: string } {
  const url = encodeURIComponent(href);
  const ref = encodeURIComponent(origin);
  return {
    phantom: `https://phantom.app/ul/browse/${url}?ref=${ref}`,
    solflare: `https://solflare.com/ul/v1/browse/${url}?ref=${ref}`,
  };
}

/* ------------------------------------------------------------------------------ connect memory */

const LAST_KEY = "sealed:last-wallet:v1";
export const MOBILE_WALLET_ADAPTER_NAME = "Mobile Wallet Adapter";

export function getLastWallet(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}
export function setLastWallet(name: string | null) {
  try {
    if (name) localStorage.setItem(LAST_KEY, name);
    else localStorage.removeItem(LAST_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Set by the wallet modal right before `select(name)`: the next autoConnect request is user-initiated. */
let userPick: string | null = null;
export function markUserPick(name: string) {
  userPick = name;
}
export function consumeUserPick(name: string): boolean {
  if (userPick !== name) return false;
  userPick = null;
  return true;
}

/* ---------------------------------------------------------------------------------------- toasts */

export interface WalletToast {
  id: number;
  tone: "info" | "error";
  title: string;
  body?: string;
  action?: { label: string; href: string };
}
let toasts: WalletToast[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function pushWalletToast(t: Omit<WalletToast, "id">, ttlMs = 6_000): number {
  const id = ++seq;
  // De-duplicate identical consecutive toasts (adapters sometimes emit the same error twice).
  toasts = [...toasts.filter((x) => x.title !== t.title || x.body !== t.body), { ...t, id }].slice(-3);
  emit();
  if (ttlMs > 0) setTimeout(() => dismissWalletToast(id), ttlMs);
  return id;
}
export function dismissWalletToast(id: number) {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}
const EMPTY: WalletToast[] = [];
export function useWalletToasts(): WalletToast[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => toasts,
    () => EMPTY,
  );
}
