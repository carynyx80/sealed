"use client";
// Whether the wallet runtime (ConnectionProvider + WalletProvider + adapters + @solana/web3.js, loaded lazily by
// SolanaProviders) is up yet, and a way to ask for it (e.g. when the wallet modal opens).
import { createContext, useContext } from "react";

export interface WalletRuntimeState {
  /** True once the real wallet providers are mounted and their state is mirrored into the app. */
  ready: boolean;
  /** Start loading the wallet runtime now (idempotent). */
  load: () => void;
}

export const WalletRuntimeContext = createContext<WalletRuntimeState>({ ready: true, load: () => undefined });

export function useWalletRuntime(): WalletRuntimeState {
  return useContext(WalletRuntimeContext);
}
