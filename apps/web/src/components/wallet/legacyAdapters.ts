"use client";
// Legacy (pre Wallet Standard) adapters, loaded as their own lazy chunk by WalletRuntime after it mounts. Most
// current wallets register through Wallet Standard and are detected without any adapter; these cover extensions and
// devices that may not (older Coinbase Wallet / Trust / Bitget builds, Coin98, MathWallet, SafePal, TokenPocket,
// Nightly) and Ledger over WebHID. WalletRuntime drops any of them whose name a Wallet Standard wallet already uses,
// so a wallet never appears twice and the Standard version always wins.
import type { Adapter } from "@solana/wallet-adapter-base";
import { BitgetWalletAdapter } from "@solana/wallet-adapter-bitkeep";
import { Coin98WalletAdapter } from "@solana/wallet-adapter-coin98";
import { CoinbaseWalletAdapter } from "@solana/wallet-adapter-coinbase";
import { LedgerWalletAdapter } from "@solana/wallet-adapter-ledger";
import { MathWalletAdapter } from "@solana/wallet-adapter-mathwallet";
import { NightlyWalletAdapter } from "@solana/wallet-adapter-nightly";
import { SafePalWalletAdapter } from "@solana/wallet-adapter-safepal";
import { TokenPocketWalletAdapter } from "@solana/wallet-adapter-tokenpocket";
import { TrustWalletAdapter } from "@solana/wallet-adapter-trust";

export function createLegacyAdapters(): Adapter[] {
  // Built against a newer @solana/wallet-adapter-base copy: same runtime shape, nominally different types.
  return [
    new CoinbaseWalletAdapter(),
    new TrustWalletAdapter(),
    new BitgetWalletAdapter(),
    new LedgerWalletAdapter(),
    new NightlyWalletAdapter(),
    new Coin98WalletAdapter(),
    new SafePalWalletAdapter(),
    new TokenPocketWalletAdapter(),
    new MathWalletAdapter(),
  ] as unknown as Adapter[];
}
