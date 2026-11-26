"use client";
// Owned by privacy-web-agent. In-memory shielded identity for the connected wallet (Helius Solana Privacy Rings).
//  - The SDK module (./spr) is imported lazily on first use; nothing here pulls it into a page bundle.
//  - Keys live only in this module's memory for the session: never persisted, cleared on wallet change/disconnect.
//  - Exposes a tiny external store + useShieldedIdentity() for every private surface.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { Adapter } from "@solana/wallet-adapter-base";
import { errorMessage, isUserRejection } from "../defi/config";
import { NETWORK } from "../config";
import type { PrivateAsset } from "./contract";
import type { Balances, Identity, WalletBridge } from "./spr";

type Spr = typeof import("./spr");
let sprPromise: Promise<Spr> | null = null;
/** Load the SDK bundle on demand (first private action). */
export function loadSpr(): Promise<Spr> {
  sprPromise ??= import("./spr").catch((e) => {
    sprPromise = null;
    throw e;
  });
  return sprPromise;
}

export type IdentityPhase = "locked" | "unlocking" | "ready" | "error";
export type PrivateOp = null | "register" | "shield" | "unshield" | "send" | "sync";

export interface IdentityState {
  owner: string | null;
  phase: IdentityPhase;
  shieldedAddress: string | null;
  registered: boolean | null;
  balances: Balances | null;
  op: PrivateOp;
  syncing: boolean;
  error: string | null;
  syncedAt: number | null;
}

const EMPTY: IdentityState = { owner: null, phase: "locked", shieldedAddress: null, registered: null, balances: null, op: null, syncing: false, error: null, syncedAt: null };
let state: IdentityState = EMPTY;
let identity: Identity | null = null;
const listeners = new Set<() => void>();
const emit = (patch: Partial<IdentityState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Forget all key material (wallet switched or disconnected). */
export function clearIdentity(owner: string | null = null) {
  try {
    identity?.keys.destroy();
  } catch {
    /* already destroyed */
  }
  identity = null;
  state = { ...EMPTY, owner };
  listeners.forEach((l) => l());
}

/* ------------------------------------------------------------------------------- wallet bridge */

type StdSignTx = {
  supportedTransactionVersions: readonly ("legacy" | 0 | 1)[];
  signTransaction: (...inputs: { account: unknown; transaction: Uint8Array; chain?: string }[]) => Promise<readonly { signedTransaction: Uint8Array }[]>;
};
type StdWallet = { accounts: readonly { address: string }[]; features: Record<string, unknown> };

function standardWalletOf(adapter: Adapter | undefined): StdWallet | null {
  const a = adapter as (Adapter & { standard?: boolean; wallet?: StdWallet }) | undefined;
  return a?.standard && a.wallet ? a.wallet : null;
}

/** Does the connected wallet sign version 1 transactions (what every Privacy Ring transaction is)? */
export function walletSignsV1(adapter: Adapter | undefined): boolean {
  const w = standardWalletOf(adapter);
  const f = w?.features["solana:signTransaction"] as StdSignTx | undefined;
  return !!f && Array.isArray(f.supportedTransactionVersions) && f.supportedTransactionVersions.includes(1);
}

function makeBridge(owner: string, adapter: Adapter | undefined, signMessage: ((m: Uint8Array) => Promise<Uint8Array>) | undefined): WalletBridge {
  if (!signMessage) throw new Error("Your wallet can't sign messages, which the Privacy Ring needs to derive your keys.");
  return {
    owner,
    signMessage,
    signTransactionBytes: async (wire) => {
      const w = standardWalletOf(adapter);
      const f = w?.features["solana:signTransaction"] as StdSignTx | undefined;
      const account = w?.accounts.find((a) => a.address === owner);
      if (!w || !f || !account || !f.supportedTransactionVersions.includes(1)) {
        throw new Error("Your wallet can't sign version 1 transactions yet, which Privacy Ring transactions use. Try another wallet.");
      }
      const [out] = await f.signTransaction({ account, transaction: wire, chain: NETWORK === "mainnet" ? "solana:mainnet" : "solana:devnet" });
      if (!out?.signedTransaction) throw new Error("Your wallet returned no signed transaction");
      return out.signedTransaction;
    },
  };
}

/* ------------------------------------------------------------------------------------- actions */

async function friendly(e: unknown): Promise<string> {
  if (isUserRejection(e)) return "You declined in your wallet. Nothing was sent.";
  try {
    const m = (await loadSpr()).describeSprError(e);
    if (m) return m;
  } catch {
    /* sdk failed to load */
  }
  return errorMessage(e);
}

async function refreshRegistration(owner: string) {
  try {
    const spr = await loadSpr();
    const registered = await spr.isRegistered(owner);
    if (state.owner === owner) emit({ registered });
  } catch {
    if (state.owner === owner) emit({ registered: null });
  }
}

async function doUnlock(bridge: WalletBridge) {
  if (state.phase === "unlocking") return;
  emit({ phase: "unlocking", error: null, owner: bridge.owner });
  try {
    const spr = await loadSpr();
    const id = await spr.deriveIdentity(bridge);
    if (state.owner !== bridge.owner) {
      id.keys.destroy();
      return;
    }
    identity = id;
    emit({ phase: "ready", shieldedAddress: id.shieldedAddress });
    void refreshRegistration(bridge.owner);
    await doSync();
  } catch (e) {
    emit({ phase: identity ? "ready" : "error", error: await friendly(e) });
  }
}

async function doSync() {
  const id = identity;
  if (!id) return;
  emit({ syncing: true, error: null });
  try {
    const spr = await loadSpr();
    const balances = await spr.syncBalances(id);
    if (identity === id) emit({ balances, syncing: false, syncedAt: Date.now() });
  } catch (e) {
    if (identity === id) emit({ syncing: false, error: await friendly(e) });
  }
}

async function runOp<T>(op: Exclude<PrivateOp, null>, fn: (spr: Spr, id: Identity) => Promise<T>): Promise<T> {
  const id = identity;
  if (!id) throw new Error("Unlock your private balance first");
  if (state.op) throw new Error("Another private transaction is in progress");
  emit({ op, error: null });
  try {
    const out = await fn(await loadSpr(), id);
    const b = (out as { balances?: Balances })?.balances;
    if (identity === id) emit({ op: null, ...(b ? { balances: b, syncedAt: Date.now() } : {}) });
    return out;
  } catch (e) {
    const msg = await friendly(e);
    if (identity === id) emit({ op: null, error: msg });
    throw new Error(msg);
  }
}

/* ---------------------------------------------------------------------------------------- hook */

export function useShieldedIdentity() {
  const { publicKey, wallet, signMessage, connected } = useWallet();
  const owner = connected && publicKey ? publicKey.toBase58() : null;
  const s = useSyncExternalStore(subscribe, () => state, () => EMPTY);
  const adapter = wallet?.adapter;

  // Wallet change or disconnect: wipe the keys.
  useEffect(() => {
    if (state.owner !== owner) clearIdentity(owner);
  }, [owner]);

  const bridge = useCallback(() => {
    if (!owner) throw new Error("Connect a wallet first");
    return makeBridge(owner, adapter, signMessage);
  }, [owner, adapter, signMessage]);

  const unlock = useCallback(async () => {
    try {
      await doUnlock(bridge());
    } catch (e) {
      emit({ phase: "error", error: errorMessage(e) });
    }
  }, [bridge]);

  const register = useCallback(
    () =>
      runOp("register", async (spr, id) => {
        const sig = await spr.register(id, bridge());
        emit({ registered: true });
        return sig;
      }),
    [bridge],
  );
  const shield = useCallback((asset: PrivateAsset, amount: number) => runOp("shield", (spr, id) => spr.shield(id, bridge(), asset, amount)), [bridge]);
  const unshield = useCallback((asset: PrivateAsset, amount: number) => runOp("unshield", (spr, id) => spr.unshield(id, bridge(), asset, amount)), [bridge]);
  const sendToCompany = useCallback(
    (companyShieldedAddress: string, asset: PrivateAsset, amount: number) => runOp("send", (spr, id) => spr.sendPrivateToCompany(id, bridge(), companyShieldedAddress, asset, amount)),
    [bridge],
  );

  const view = s.owner === owner ? s : { ...EMPTY, owner };
  return {
    ...view,
    connected: !!owner,
    /** The wallet can sign Privacy Ring (version 1) transactions. Unlocking only needs signMessage. */
    signsV1: walletSignsV1(adapter),
    canSignMessage: !!signMessage,
    unlock,
    lock: () => clearIdentity(owner),
    sync: () => doSync(),
    register,
    shield,
    unshield,
    sendToCompany,
    /** UI units from atoms (null while locked). */
    uiBalance: (asset: PrivateAsset): number | null => {
      const v = view.balances?.[asset];
      if (v === null || v === undefined) return null;
      const d = asset === "SOL" ? 9 : 6;
      const str = v.toString().padStart(d + 1, "0");
      return Number(`${str.slice(0, -d)}.${str.slice(-d)}`);
    },
  };
}
export type ShieldedIdentityApi = ReturnType<typeof useShieldedIdentity>;

/* ------------------------------------------------------------- "open deposit sheet on private" */

let preferPrivate = false;
/** Ask the next DepositSheet open to start on the private method. */
export function preferPrivateDeposit() {
  preferPrivate = true;
}
export function takePrivateDepositPreference(): boolean {
  const v = preferPrivate;
  preferPrivate = false;
  return v;
}
