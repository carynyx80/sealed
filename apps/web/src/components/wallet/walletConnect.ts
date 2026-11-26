"use client";
// A light stand-in for WalletConnectWalletAdapter that the WalletProvider can list from the start (name, icon,
// "Loadable") without pulling in WalletConnect / Reown AppKit. The real adapter is imported and created on the first
// connect, and every call is delegated to it.
//  - connect(): user picked WalletConnect → AppKit modal (QR on desktop, wallet list + deep links on phones).
//  - autoConnect(): page load for a returning WalletConnect user → restores the stored session only; if there is no
//    live session it fails quietly (never pops a QR on load).
//  - disconnect(): ends the WalletConnect session (the wallet app sees it end too).
import {
  BaseSignerWalletAdapter,
  WalletAdapterNetwork,
  WalletConnectionError,
  WalletNotConnectedError,
  WalletReadyState,
  type TransactionOrVersionedTransaction,
  type WalletName,
} from "@solana/wallet-adapter-base";
import type { PublicKey, TransactionVersion } from "@solana/web3.js";
import { WALLETCONNECT_NAME } from "@/lib/wallet";
import { loadWalletConnect } from "./walletConnectLoader";

// WalletConnect's own mark (same artwork the official adapter ships).
const WC_ICON =
  "data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjE4NSIgdmlld0JveD0iMCAwIDMwMCAxODUiIHdpZHRoPSIzMDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHBhdGggZD0ibTYxLjQzODU0MjkgMzYuMjU2MjYxMmM0OC45MTEyMjQxLTQ3Ljg4ODE2NjMgMTI4LjIxMTk4NzEtNDcuODg4MTY2MyAxNzcuMTIzMjA5MSAwbDUuODg2NTQ1IDUuNzYzNDE3NGMyLjQ0NTU2MSAyLjM5NDQwODEgMi40NDU1NjEgNi4yNzY1MTEyIDAgOC42NzA5MjA0bC0yMC4xMzY2OTUgMTkuNzE1NTAzYy0xLjIyMjc4MSAxLjE5NzIwNTEtMy4yMDUzIDEuMTk3MjA1MS00LjQyODA4MSAwbC04LjEwMDU4NC03LjkzMTE0NzljLTM0LjEyMTY5Mi0zMy40MDc5ODE3LTg5LjQ0Mzg4Ni0zMy40MDc5ODE3LTEyMy41NjU1Nzg4IDBsLTguNjc1MDU2MiA4LjQ5MzYwNTFjLTEuMjIyNzgxNiAxLjE5NzIwNDEtMy4yMDUzMDEgMS4xOTcyMDQxLTQuNDI4MDgwNiAwbC0yMC4xMzY2OTQ5LTE5LjcxNTUwMzFjLTIuNDQ1NTYxMi0yLjM5NDQwOTItMi40NDU1NjEyLTYuMjc2NTEyMiAwLTguNjcwOTIwNHptMjE4Ljc2Nzc5NjEgNDAuNzczNzQ0OSAxNy45MjE2OTcgMTcuNTQ2ODk3YzIuNDQ1NTQ5IDIuMzk0Mzk2OSAyLjQ0NTU2MyA2LjI3NjQ3NjkuMDAwMDMxIDguNjcwODg5OWwtODAuODEwMTcxIDc5LjEyMTEzNGMtMi40NDU1NDQgMi4zOTQ0MjYtNi40MTA1ODIgMi4zOTQ0NTMtOC44NTYxNi4wMDAwNjItLjAwMDAxLS4wMDAwMS0uMDAwMDIyLS4wMDAwMjItLjAwMDAzMi0uMDAwMDMybC01Ny4zNTQxNDMtNTYuMTU0NTcyYy0uNjExMzktLjU5ODYwMi0xLjYwMjY1LS41OTg2MDItMi4yMTQwNCAwLS4wMDAwMDQuMDAwMDA0LS4wMDAwMDcuMDAwMDA4LS4wMDAwMTEuMDAwMDExbC01Ny4zNTI5MjEyIDU2LjE1NDUzMWMtMi40NDU1MzY4IDIuMzk0NDMyLTYuNDEwNTc1NSAyLjM5NDQ3Mi04Ljg1NjE2MTIuMDAwMDg3LS4wMDAwMTQzLS4wMDAwMTQtLjAwMDAyOTYtLjAwMDAyOC0uMDAwMDQ0OS0uMDAwMDQ0bC04MC44MTI0MTk0My03OS4xMjIxODVjLTIuNDQ1NTYwMjEtMi4zOTQ0MDgtMi40NDU1NjAyMS02LjI3NjUxMTUgMC04LjY3MDkxOTdsMTcuOTIxNzI5NjMtMTcuNTQ2ODY3M2MyLjQ0NTU2MDItMi4zOTQ0MDgyIDYuNDEwNTk4OS0yLjM5NDQwODIgOC44NTYxNjAyIDBsNTcuMzU0OTc3NSA1Ni4xNTUzNTdjLjYxMTM5MDguNTk4NjAyIDEuNjAyNjQ5LjU5ODYwMiAyLjIxNDAzOTggMCAuMDAwMDA5Mi0uMDAwMDA5LjAwMDAxNzQtLjAwMDAxNy4wMDAwMjY1LS4wMDAwMjRsNTcuMzUyMTAzMS01Ni4xNTUzMzNjMi40NDU1MDUtMi4zOTQ0NjMzIDYuNDEwNTQ0LTIuMzk0NTUzMSA4Ljg1NjE2MS0uMDAwMi4wMDAwMzQuMDAwMDMzNi4wMDAwNjguMDAwMDY3My4wMDAxMDEuMDAwMTAxbDU3LjM1NDkwMiA1Ni4xNTU0MzJjLjYxMTM5LjU5ODYwMSAxLjYwMjY1LjU5ODYwMSAyLjIxNDA0IDBsNTcuMzUzOTc1LTU2LjE1NDMyNDljMi40NDU1NjEtMi4zOTQ0MDkyIDYuNDEwNTk5LTIuMzk0NDA5MiA4Ljg1NjE2IDB6IiBmaWxsPSIjM2I5OWZjIi8+PC9zdmc+";

export interface WalletConnectProxyConfig {
  network: WalletAdapterNetwork;
  projectId: string;
  metadata: { name: string; description: string; url: string; icons: string[] };
}

/** The subset of the real adapter this proxy uses (it is built against a newer wallet-adapter-base copy). */
interface InnerAdapter {
  publicKey: PublicKey | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  signTransaction<T extends TransactionOrVersionedTransaction<ReadonlySet<TransactionVersion>>>(tx: T): Promise<T>;
  signAllTransactions<T extends TransactionOrVersionedTransaction<ReadonlySet<TransactionVersion>>>(txs: T[]): Promise<T[]>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  on(event: string, fn: (...args: never[]) => void): unknown;
}

export class WalletConnectProxyAdapter extends BaseSignerWalletAdapter {
  name = WALLETCONNECT_NAME as WalletName<"WalletConnect">;
  url = "https://walletconnect.network";
  icon = WC_ICON;
  readonly supportedTransactionVersions: ReadonlySet<TransactionVersion> = new Set<TransactionVersion>(["legacy", 0]);

  private _config: WalletConnectProxyConfig;
  private _inner: InnerAdapter | null = null;
  private _publicKey: PublicKey | null = null;
  private _connecting = false;

  constructor(config: WalletConnectProxyConfig) {
    super();
    this._config = config;
  }

  get publicKey() {
    return this._publicKey;
  }
  get connecting() {
    return this._connecting;
  }
  get readyState() {
    return typeof window === "undefined" ? WalletReadyState.Unsupported : WalletReadyState.Loadable;
  }

  private async inner(): Promise<InnerAdapter> {
    if (this._inner) return this._inner;
    const { WalletConnectWalletAdapter } = await loadWalletConnect();
    const { network, projectId, metadata } = this._config;
    const inner = new WalletConnectWalletAdapter({
      // Same string values ("mainnet-beta" / "devnet"); the enum types come from different package copies.
      network: (network === WalletAdapterNetwork.Mainnet ? "mainnet-beta" : "devnet") as never,
      options: { projectId, metadata },
    }) as unknown as InnerAdapter;
    inner.on("connect", ((pk: PublicKey) => {
      this._publicKey = pk;
      this.emit("connect", pk);
    }) as never);
    inner.on("disconnect", (() => {
      this._publicKey = null;
      this.emit("disconnect");
    }) as never);
    inner.on("error", ((e: never) => this.emit("error", e)) as never);
    this._inner = inner;
    return inner;
  }

  async connect(): Promise<void> {
    if (this.connected || this._connecting) return;
    this._connecting = true;
    try {
      const inner = await this.inner();
      await inner.connect();
      // The real adapter emits "connect" (forwarded above); keep our key in sync either way.
      this._publicKey = inner.publicKey;
    } catch (error) {
      const e = error instanceof Error ? error : new WalletConnectionError(String(error));
      this.emit("error", e as never);
      throw e;
    } finally {
      this._connecting = false;
    }
  }

  /** Page-load reconnect: restore a stored WalletConnect session, never open the QR modal. */
  async autoConnect(): Promise<void> {
    if (!(await hasStoredWalletConnectSession())) {
      const e = new WalletConnectionError("No WalletConnect session to restore");
      this.emit("error", e);
      throw e;
    }
    await this.connect();
  }

  async disconnect(): Promise<void> {
    const inner = this._inner;
    this._publicKey = null;
    if (inner) await inner.disconnect().catch(() => this.emit("disconnect"));
    else this.emit("disconnect");
  }

  async signTransaction<T extends TransactionOrVersionedTransaction<this["supportedTransactionVersions"]>>(tx: T): Promise<T> {
    return (await this.connectedInner()).signTransaction(tx);
  }
  async signAllTransactions<T extends TransactionOrVersionedTransaction<this["supportedTransactionVersions"]>>(txs: T[]): Promise<T[]> {
    return (await this.connectedInner()).signAllTransactions(txs);
  }
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return (await this.connectedInner()).signMessage(message);
  }

  private async connectedInner(): Promise<InnerAdapter> {
    const inner = this._inner;
    if (!inner || !this.connected) {
      const e = new WalletNotConnectedError();
      this.emit("error", e);
      throw e;
    }
    return inner;
  }
}

/* ------------------------------------------------------------------------- stored session */

// @walletconnect/sign-client keeps sessions under "wc@2:client:<version>//session" (IndexedDB via
// @walletconnect/keyvaluestorage; localStorage on older builds) as a JSON array of { expiry (s), namespaces }.
const SESSION_KEY = /^wc@2:client:[^/]*\/\/session$/;

function hasLiveSolanaSession(raw: unknown): boolean {
  try {
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(list)) return false;
    const now = Date.now() / 1000;
    return list.some((s) => s && typeof s.expiry === "number" && s.expiry > now && s.namespaces && "solana" in s.namespaces);
  } catch {
    return false;
  }
}

export async function hasStoredWalletConnectSession(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && SESSION_KEY.test(k) && hasLiveSolanaSession(localStorage.getItem(k))) return true;
    }
  } catch {
    /* storage blocked */
  }
  try {
    if (typeof indexedDB === "undefined") return false;
    // Don't create WalletConnect's database just to look inside it.
    const dbs = typeof indexedDB.databases === "function" ? await indexedDB.databases() : null;
    if (dbs && !dbs.some((d) => d.name === "WALLET_CONNECT_V2_INDEXED_DB")) return false;
    const { createStore, entries } = await import("idb-keyval");
    const store = createStore("WALLET_CONNECT_V2_INDEXED_DB", "keyvaluestorage");
    const all = await Promise.race([entries(store), new Promise<[]>((r) => setTimeout(() => r([]), 2_000))]);
    return all.some(([k, v]) => typeof k === "string" && SESSION_KEY.test(k) && hasLiveSolanaSession(v));
  } catch {
    return false;
  }
}
