"use client";
// The heavy half of the wallet stack, loaded on demand by SolanaProviders (next/dynamic, client only): the real
// ConnectionProvider / WalletProvider (Wallet Standard detection, Mobile Wallet Adapter, autoConnect) plus the
// explicit Phantom + Solflare adapters, and with them @solana/web3.js. It renders no UI: <Bridge /> mirrors the
// provider state up to SolanaProviders, which serves it to the app through the standard wallet-adapter contexts,
// so every `useWallet()` / `useConnection()` keeps working unchanged.
import { memo, useLayoutEffect, useMemo, type MutableRefObject } from "react";
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
import { IS_MAINNET, RPC_ENDPOINT } from "@/lib/config";

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
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter({ network })], [network]);
  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT} config={CONNECTION_CONFIG}>
      <WalletProvider wallets={wallets} autoConnect={autoConnect} onError={onError}>
        <Bridge onChange={onChange} pendingSelect={pendingSelect} />
      </WalletProvider>
    </ConnectionProvider>
  );
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
