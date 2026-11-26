"use client";
// Owned by defi-integrations-agent. Wraps children in Connection / Wallet / WalletModal providers.
import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { clusterApiUrl } from "@solana/web3.js";
import "./wallet.css";

function resolveEndpoint(): { endpoint: string; network: WalletAdapterNetwork } {
  const n = process.env.NEXT_PUBLIC_NETWORK || "devnet";
  const network = n === "mainnet" ? WalletAdapterNetwork.Mainnet : WalletAdapterNetwork.Devnet;
  const override = process.env.NEXT_PUBLIC_RPC_URL;
  if (override) return { endpoint: override, network };
  if (n === "localnet") return { endpoint: "http://127.0.0.1:8899", network };
  return { endpoint: clusterApiUrl(network), network };
}

export function SolanaProviders({ children }: { children: ReactNode }) {
  const { endpoint, network } = useMemo(resolveEndpoint, []);
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter({ network })], [network]);
  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
