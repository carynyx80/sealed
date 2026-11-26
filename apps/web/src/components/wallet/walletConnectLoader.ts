"use client";
// Loads the WalletConnect adapter (@solana/wallet-adapter-walletconnect → @walletconnect/solana-adapter → Reown
// AppKit + UniversalProvider, several hundred kB) on demand only: when the user picks WalletConnect, hovers it, or a
// stored WalletConnect session is being restored. Nothing here is imported statically by any page.

type WalletConnectModule = typeof import("@solana/wallet-adapter-walletconnect");
let pending: Promise<WalletConnectModule> | null = null;

export function loadWalletConnect(): Promise<WalletConnectModule> {
  if (!pending) {
    pending = (async () => {
      // The adapter serialises transactions with the global `Buffer` (Node style); browsers don't have one.
      const g = globalThis as unknown as { Buffer?: unknown };
      if (typeof g.Buffer === "undefined") g.Buffer = (await import("buffer")).Buffer;
      return import("@solana/wallet-adapter-walletconnect");
    })();
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}

/** Warm the chunk (pointer enter / focus on a WalletConnect row) so the QR opens without a long wait. */
export function preloadWalletConnect(): void {
  void loadWalletConnect().catch(() => undefined);
}
