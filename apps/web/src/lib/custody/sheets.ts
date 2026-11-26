"use client";
// Owned by web-offchain-agent. Global open/close state for the Deposit / Withdraw sheets so any card
// ("Deposit" CTA on the commit or swap card, the session pill, /account) can open them.
import { useSyncExternalStore } from "react";
import type { QuoteAssetSymbol } from "@sealed/shared";

export type SheetState =
  | { kind: "none" }
  | { kind: "deposit"; asset: QuoteAssetSymbol; suggested?: number }
  | { kind: "withdraw"; asset: QuoteAssetSymbol };

let state: SheetState = { kind: "none" };
const listeners = new Set<() => void>();
const set = (s: SheetState) => {
  state = s;
  for (const l of listeners) l();
};

export const openDeposit = (asset: QuoteAssetSymbol = "SOL", suggested?: number) => set({ kind: "deposit", asset, suggested });
export const openWithdraw = (asset: QuoteAssetSymbol = "SOL") => set({ kind: "withdraw", asset });
export const closeSheet = () => set({ kind: "none" });

const NONE: SheetState = { kind: "none" };
export function useSheetState(): SheetState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
    () => NONE,
  );
}
