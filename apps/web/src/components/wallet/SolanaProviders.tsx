"use client";
// Connection / Wallet / wallet-modal providers for the whole app (mounted once in app/layout.tsx).
//  - RPC: lib/config RPC_ENDPOINT (the Sealed API's allowlisted /api/rpc proxy unless NEXT_PUBLIC_RPC_URL is set),
//    commitment "confirmed". Network comes from lib/config only.
//  - Wallets: Wallet Standard auto-detection (Phantom, Solflare, Backpack, …) plus explicit Phantom + Solflare
//    adapters (install hints + Solflare's web wallet). The provider drops an explicit adapter whenever a Wallet
//    Standard wallet with the same name is detected, so the modal never lists a wallet twice.
//  - autoConnect only for the wallet this browser connected before (or the one the user just picked).
//  - Errors become quiet toasts (rejections) or actionable ones (not installed → install / open-in-app link).
//  - Perf: the real providers + adapters + @solana/web3.js live in ./WalletRuntime, a lazy chunk. It loads right
//    away for a returning wallet (so autoConnect is unchanged), otherwise on the first wallet intent (modal open,
//    hover/focus of the connect pill, any select()). Until then the app sees a plain "disconnected" wallet state.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import {
  ConnectionContext,
  WalletContext,
  WalletNotSelectedError,
  useWallet,
  type ConnectionContextState,
  type WalletContextState,
} from "@solana/wallet-adapter-react";
import {
  WalletNotConnectedError,
  WalletNotReadyError,
  WalletReadyState,
  type Adapter,
  type WalletError,
  type WalletName,
} from "@solana/wallet-adapter-base";
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
import { isWalletSignInActive } from "@/lib/wallet/signIn";
import { WalletRuntimeContext, type WalletRuntimeState } from "./runtime";
import { SealedWalletModalProvider } from "./WalletModal";
import { WalletToasts } from "./WalletToasts";

const WalletRuntime = dynamic(() => import("./WalletRuntime"), { ssr: false });

/** Context value before the runtime is up: what WalletProvider reports with no wallet selected. */
function idleWallet(select: (name: WalletName | null) => void): WalletContextState {
  return {
    autoConnect: false,
    wallets: [],
    wallet: null,
    publicKey: null,
    connecting: false,
    connected: false,
    disconnecting: false,
    select,
    connect: () => Promise.reject(new WalletNotSelectedError()),
    disconnect: () => Promise.resolve(),
    sendTransaction: () => Promise.reject(new WalletNotConnectedError()),
    signTransaction: undefined,
    signAllTransactions: undefined,
    signMessage: undefined,
    signIn: undefined,
  };
}
const IDLE_CONNECTION = {} as ConnectionContextState;

export function SolanaProviders({ children }: { children: ReactNode }) {
  const [wanted, setWanted] = useState(false);
  const [mirror, setMirror] = useState<{ wallet: WalletContextState; connection: ConnectionContextState } | null>(null);
  const pendingSelect = useRef<WalletName | null>(null);
  const load = useCallback(() => setWanted(true), []);
  // A returning wallet reconnects on page load, as before: start the runtime immediately.
  useEffect(() => {
    if (getLastWallet()) setWanted(true);
  }, []);
  const idle = useMemo(
    () =>
      idleWallet((name) => {
        pendingSelect.current = name;
        setWanted(true);
      }),
    [],
  );
  const onChange = useCallback((wallet: WalletContextState, connection: ConnectionContextState) => setMirror({ wallet, connection }), []);
  const ready = mirror !== null;
  const runtime = useMemo<WalletRuntimeState>(() => ({ ready, load }), [ready, load]);
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
    // "Sign in to Sealed" shows its own friendly status/error; don't double it with a raw wallet toast.
    if (isWalletSignInActive()) return;
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
    <WalletRuntimeContext.Provider value={runtime}>
      <ConnectionContext.Provider value={mirror?.connection ?? IDLE_CONNECTION}>
        <WalletContext.Provider value={mirror?.wallet ?? idle}>
          <SealedWalletModalProvider>
            <WalletSessionSync silentConnect={silentConnect} />
            {children}
            <WalletToasts />
          </SealedWalletModalProvider>
        </WalletContext.Provider>
      </ConnectionContext.Provider>
      {wanted && <WalletRuntime autoConnect={autoConnect} onError={onError} onChange={onChange} pendingSelect={pendingSelect} />}
    </WalletRuntimeContext.Provider>
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
