"use client";
// Connection / Wallet / wallet-modal providers for the whole app (mounted once in app/layout.tsx).
//  - RPC: lib/config RPC_ENDPOINT (the Sealed API's allowlisted /api/rpc proxy unless NEXT_PUBLIC_RPC_URL is set),
//    commitment "confirmed". Network comes from lib/config only.
//  - Wallets: Wallet Standard auto-detection (Phantom, Solflare, Backpack, …) plus explicit Phantom + Solflare
//    adapters (install hints + Solflare's web wallet). The provider drops an explicit adapter whenever a Wallet
//    Standard wallet with the same name is detected, so the modal never lists a wallet twice.
//  - autoConnect only for the wallet this browser connected before (or the one the user just picked).
//  - Errors become quiet toasts (rejections) or actionable ones (not installed → install / open-in-app link).
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork, WalletNotReadyError, WalletReadyState, type Adapter, type WalletError } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { IS_MAINNET, RPC_ENDPOINT } from "@/lib/config";
import { clearSession } from "@/lib/custody/client";
import { isUserRejection } from "@/lib/defi/config";
import {
  MOBILE_WALLET_ADAPTER_NAME,
  consumeUserPick,
  getLastWallet,
  isMobileDevice,
  pushWalletToast,
  setLastWallet,
  walletDeepLinks,
} from "@/lib/wallet";
import { SealedWalletModalProvider } from "./WalletModal";
import { WalletToasts } from "./WalletToasts";

export function SolanaProviders({ children }: { children: ReactNode }) {
  const network = IS_MAINNET ? WalletAdapterNetwork.Mainnet : WalletAdapterNetwork.Devnet;
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter({ network })], [network]);
  /** Whether the in-flight connect was started by autoConnect (silent on failure) rather than by the user. */
  const silentConnect = useRef(false);

  const autoConnect = useCallback(async (adapter: Adapter): Promise<boolean> => {
    if (consumeUserPick(adapter.name)) {
      silentConnect.current = false;
      return true;
    }
    // Page load: reconnect only the wallet that was connected last time, and only if it is actually present
    // (never pop a web-wallet window or a mobile wallet intent on load).
    const ok =
      getLastWallet() === adapter.name &&
      (adapter.readyState === WalletReadyState.Installed || adapter.name === MOBILE_WALLET_ADAPTER_NAME);
    silentConnect.current = ok;
    return ok;
  }, []);

  const onError = useCallback((error: WalletError, adapter?: Adapter) => {
    if (silentConnect.current) {
      // A failed silent reconnect (wallet locked, permission revoked): forget it, don't nag.
      silentConnect.current = false;
      setLastWallet(null);
      return;
    }
    const name = adapter?.name ?? "Wallet";
    if (isUserRejection(error) || isUserRejection((error as { error?: unknown }).error)) {
      pushWalletToast({ tone: "info", title: "Request cancelled", body: `${name} request was declined in the wallet.` }, 3_500);
      return;
    }
    if (error instanceof WalletNotReadyError || error.name === "WalletNotReadyError") {
      const mobile = isMobileDevice();
      const links = typeof window !== "undefined" ? walletDeepLinks(window.location.href, window.location.origin) : null;
      const href = mobile && links ? (/solflare/i.test(name) ? links.solflare : links.phantom) : adapter?.url;
      pushWalletToast(
        {
          tone: "error",
          title: `${name} isn't available in this browser`,
          body: mobile ? "Open Sealed inside the wallet app to connect." : "Install the extension, then reload this page.",
          action: href ? { label: mobile ? `Open in ${/solflare/i.test(name) ? "Solflare" : "Phantom"}` : `Get ${name}`, href } : undefined,
        },
        10_000,
      );
      return;
    }
    const msg = (error.message || (error as { error?: { message?: string } }).error?.message || "").trim();
    pushWalletToast({ tone: "error", title: `${name} error`, body: msg ? (msg.length > 160 ? `${msg.slice(0, 160)}…` : msg) : "The wallet reported an error. Try again." });
  }, []);

  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect={autoConnect} onError={onError}>
        <SealedWalletModalProvider>
          <WalletSessionSync silentConnect={silentConnect} />
          {children}
          <WalletToasts />
        </SealedWalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

/**
 * Keeps wallet-derived state honest:
 *  - remembers the wallet on a successful connect (so autoConnect can restore it), forgets it on disconnect;
 *  - clears the Sealed (SIWS) session of a wallet that disconnects or is switched away from, so a session can
 *    never outlive the wallet connection that created it.
 */
function WalletSessionSync({ silentConnect }: { silentConnect: React.MutableRefObject<boolean> }) {
  const { publicKey, connected, wallet } = useWallet();
  const address = connected && publicKey ? publicKey.toBase58() : null;
  const prev = useRef<string | null>(null);
  const name = wallet?.adapter.name ?? null;

  useEffect(() => {
    if (address && name) {
      setLastWallet(name);
      silentConnect.current = false;
    }
    const before = prev.current;
    if (before && before !== address) {
      clearSession(before);
      if (!address) setLastWallet(null);
    }
    prev.current = address;
  }, [address, name, silentConnect]);

  return null;
}
