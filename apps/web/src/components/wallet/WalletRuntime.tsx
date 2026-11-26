"use client";
// The heavy half of the wallet stack, loaded on demand by SolanaProviders (next/dynamic, client only): the real
// ConnectionProvider / WalletProvider (Wallet Standard detection, Mobile Wallet Adapter, autoConnect) plus the
// explicit adapters, and with them @solana/web3.js. It renders no UI: <Bridge /> mirrors the provider state up to
// SolanaProviders, which serves it to the app through the standard wallet-adapter contexts, so every `useWallet()` /
// `useConnection()` keeps working unchanged.
//  - Phantom + Solflare adapters (install hints, Solflare's web wallet).
//  - WalletConnect (only when a project id is configured): a light proxy here; the real adapter and Reown AppKit load
//    on the first connect (./walletConnect).
//  - Legacy adapters for wallets that may not speak Wallet Standard (./legacyAdapters, its own lazy chunk).
//  - Any explicit adapter whose name a detected Solana Wallet Standard wallet already uses is dropped, so the
//    Standard wallet wins and nothing is listed twice.
import { memo, useEffect, useLayoutEffect, useMemo, useState, type MutableRefObject } from "react";
import {
  ConnectionProvider,
  WalletProvider,
  useConnection,
  useWallet,
  type ConnectionContextState,
  type WalletContextState,
} from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork, type Adapter, type WalletError, type WalletName } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { IS_MAINNET, RPC_ENDPOINT, walletConnectProjectId } from "@/lib/config";
import { SITE_URL } from "@/lib/site";
import { WalletConnectProxyAdapter } from "./walletConnect";

const CONNECTION_CONFIG = { commitment: "confirmed" } as const;

export interface WalletRuntimeProps {
  autoConnect: (adapter: Adapter) => Promise<boolean>;
  onError: (error: WalletError, adapter?: Adapter) => void;
  onChange: (wallet: WalletContextState, connection: ConnectionContextState) => void;
  /** A wallet picked before the runtime was up; selected as soon as it mounts. */
  pendingSelect: MutableRefObject<WalletName | null>;
}

function WalletRuntime({ autoConnect, onError, onChange, pendingSelect }: WalletRuntimeProps) {
  const network = IS_MAINNET ? WalletAdapterNetwork.Mainnet : WalletAdapterNetwork.Devnet;
  const standardNames = useStandardWalletNames();
  const [legacy, setLegacy] = useState<Adapter[]>([]);
  useEffect(() => {
    let live = true;
    import("./legacyAdapters")
      .then((m) => live && setLegacy(m.createLegacyAdapters()))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const base = useMemo(() => {
    const list: Adapter[] = [new PhantomWalletAdapter(), new SolflareWalletAdapter({ network })];
    const projectId = walletConnectProjectId();
    if (projectId) {
      list.push(
        new WalletConnectProxyAdapter({
          network,
          projectId,
          metadata: {
            name: "Sealed",
            description: "Sealed launchpad on Solana",
            url: SITE_URL,
            icons: [`${SITE_URL}/icon.svg`],
          },
        }),
      );
    }
    return list;
  }, [network]);
  const wallets = useMemo(
    () => [...base, ...legacy].filter((a) => !standardNames.has(a.name)),
    [base, legacy, standardNames],
  );
  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT} config={CONNECTION_CONFIG}>
      <WalletProvider wallets={wallets} autoConnect={autoConnect} onError={onError}>
        <Bridge onChange={onChange} pendingSelect={pendingSelect} />
      </WalletProvider>
    </ConnectionProvider>
  );
}

/* ------------------------------------------------------------------- Wallet Standard names */

interface StdWalletLike {
  name?: unknown;
  chains?: readonly unknown[];
  features?: Record<string, unknown>;
}
const isSolanaStandard = (w: StdWalletLike) =>
  typeof w?.name === "string" &&
  !!w.features &&
  "standard:connect" in w.features &&
  Array.isArray(w.chains) &&
  w.chains.some((c) => typeof c === "string" && c.startsWith("solana:"));

/**
 * Names of the Solana Wallet Standard wallets registered on this page, via the Wallet Standard protocol itself
 * (an app dispatches "wallet-standard:app-ready"; wallets answer by calling `register`, and later ones announce
 * themselves with "wallet-standard:register-wallet"). Read synchronously on mount so explicit duplicates never
 * reach the WalletProvider.
 */
function useStandardWalletNames(): ReadonlySet<string> {
  const [names, setNames] = useState<ReadonlySet<string>>(() => collectNames(() => undefined));
  useEffect(() => {
    return subscribeNames((found) =>
      setNames((prev) => (found.every((n) => prev.has(n)) ? prev : new Set([...prev, ...found]))),
    );
  }, []);
  return names;
}

function makeApi(add: (wallets: StdWalletLike[]) => void) {
  return {
    register: (...wallets: StdWalletLike[]) => {
      add(wallets.filter(isSolanaStandard));
      return () => undefined;
    },
  };
}

function collectNames(onLate: (names: string[]) => void): Set<string> {
  const set = new Set<string>();
  if (typeof window === "undefined") return set;
  const api = makeApi((ws) => {
    const fresh = ws.map((w) => w.name as string).filter((n) => !set.has(n));
    fresh.forEach((n) => set.add(n));
    if (fresh.length) onLate(fresh);
  });
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  } catch {
    /* ignore */
  }
  return set;
}

function subscribeNames(cb: (names: string[]) => void): () => void {
  const api = makeApi((ws) => ws.length && cb(ws.map((w) => w.name as string)));
  const onRegister = (e: Event) => {
    const callback = (e as CustomEvent).detail;
    if (typeof callback === "function") {
      try {
        callback(api);
      } catch {
        /* a misbehaving wallet must not break the page */
      }
    }
  };
  window.addEventListener("wallet-standard:register-wallet", onRegister);
  collectNames(cb);
  return () => window.removeEventListener("wallet-standard:register-wallet", onRegister);
}

function Bridge({ onChange, pendingSelect }: Pick<WalletRuntimeProps, "onChange" | "pendingSelect">) {
  const wallet = useWallet();
  const connection = useConnection();
  useLayoutEffect(() => onChange(wallet, connection), [wallet, connection, onChange]);
  const { select } = wallet;
  useLayoutEffect(() => {
    const name = pendingSelect.current;
    if (!name) return;
    pendingSelect.current = null;
    select(name);
  }, [select, pendingSelect]);
  return null;
}

// Memoised: SolanaProviders re-renders whenever the mirrored state changes; the runtime must not (all props are stable).
export default memo(WalletRuntime);
