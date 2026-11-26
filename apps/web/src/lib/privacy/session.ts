"use client";
// Owned by privacy-web-agent. In-memory private Sealed wallet ("burner") for the connected wallet (Helius Solana
// Privacy Rings). See ./burner.ts for the derivation and ./spr.ts for every SDK call.
//  - The SDK module (./spr) is imported lazily on first use; nothing here pulls it into a page bundle.
//  - Keys live only in this module's memory: never persisted, destroyed on wallet change/disconnect and on Lock.
//    Signing the same message again with the same wallet re-creates the same burner, so nothing needs storing.
//  - Link status (GET/POST /api/privacy/link) is kept per main wallet so withdrawals can pay the linked burner.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { Adapter } from "@solana/wallet-adapter-base";
import type { Connection, Transaction as LegacyTransaction } from "@solana/web3.js";
import { errorMessage, isUserRejection } from "../defi/config";
import { CustodyError, custodyFetch, getSession, subscribeSessions } from "../custody/client";
import { muteWalletErrorToasts, toBytes } from "../wallet/signIn";
import { PRIVACY_ROUTES, type PrivateAsset } from "./contract";
import type { Balances, Identity, MainWalletBridge, PublicBalances } from "./spr";

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
export type PrivateOp = null | "register" | "fund" | "shield" | "unshield" | "send" | "sweep";

export type LinkStatus =
  | "unknown" // not checked yet
  | "signed_out" // no Sealed session for the main wallet
  | "checking"
  | "linked" // linked to THIS burner (or, while locked, to some burner)
  | "none" // signed in, nothing linked
  | "other" // linked to a different burner than the one open now
  | "taken" // this burner belongs to another Sealed account
  | "unavailable" // privacy routes off / unreachable
  | "error";

export interface LinkState {
  status: LinkStatus;
  /** The burner the backend has linked to the main wallet's account. */
  linkedBurner: string | null;
  error: string | null;
}

export interface IdentityState {
  /** The connected main wallet. */
  owner: string | null;
  phase: IdentityPhase;
  /** The private wallet's public Solana address. */
  burner: string | null;
  shieldedAddress: string | null;
  registered: boolean | null;
  balances: Balances | null;
  pub: PublicBalances | null;
  op: PrivateOp;
  syncing: boolean;
  error: string | null;
  syncedAt: number | null;
  link: LinkState;
}

const NO_LINK: LinkState = { status: "unknown", linkedBurner: null, error: null };
const EMPTY: IdentityState = {
  owner: null,
  phase: "locked",
  burner: null,
  shieldedAddress: null,
  registered: null,
  balances: null,
  pub: null,
  op: null,
  syncing: false,
  error: null,
  syncedAt: null,
  link: NO_LINK,
};
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

function destroyCurrent() {
  const id = identity;
  identity = null;
  if (id) void loadSpr().then((spr) => spr.destroyIdentity(id)).catch(() => undefined);
}

/** Forget all key material (wallet switched or disconnected). */
export function clearIdentity(owner: string | null = null) {
  destroyCurrent();
  lastLinkKey = null;
  state = { ...EMPTY, owner };
  listeners.forEach((l) => l());
}

/** Lock: destroy the keys but keep the link status (it's not secret). */
function lockIdentity(owner: string | null) {
  destroyCurrent();
  state = { ...EMPTY, owner, link: state.owner === owner ? state.link : NO_LINK };
  listeners.forEach((l) => l());
}

/* ------------------------------------------------------------------------------- wallet bridge */

function makeBridge(
  main: string,
  signMessage: ((m: Uint8Array) => Promise<Uint8Array>) | undefined,
  sendTransaction: ((tx: LegacyTransaction, c: Connection, o?: { preflightCommitment?: "confirmed"; maxRetries?: number }) => Promise<string>) | undefined,
): MainWalletBridge {
  return {
    main,
    signMessage: async (m) => {
      if (!signMessage) throw new Error(NO_SIGN_MESSAGE);
      // The wallet UI explains a refusal itself and so does this panel: keep the global raw-error toast quiet.
      const release = muteWalletErrorToasts();
      try {
        return toBytes(await signMessage(m));
      } finally {
        release();
      }
    },
    sendLegacy: async (tx, c) => {
      if (!sendTransaction) throw new Error("Your wallet can't send transactions from this page.");
      const release = muteWalletErrorToasts();
      try {
        return await sendTransaction(tx, c, { preflightCommitment: "confirmed", maxRetries: 3 });
      } finally {
        release();
      }
    },
  };
}

const NO_SIGN_MESSAGE =
  "This wallet can't sign messages, so it can't open a private Sealed wallet. Hardware wallets such as Ledger don't support it yet; connect a browser or mobile wallet instead.";

/* ------------------------------------------------------------------------------------- actions */

async function friendly(e: unknown): Promise<string> {
  if (isUserRejection(e)) return "You declined in your wallet. Nothing was signed or sent.";
  const m = errorMessage(e);
  if (/not (be )?supported|unsupported/i.test(m) && /message/i.test(m)) return NO_SIGN_MESSAGE;
  try {
    const d = (await loadSpr()).describeSprError(e);
    if (d) return d;
  } catch {
    /* sdk failed to load */
  }
  return m;
}

async function refreshRegistration(id: Identity) {
  try {
    const spr = await loadSpr();
    const registered = await spr.isRegistered(id.burner);
    if (identity === id) emit({ registered });
  } catch {
    if (identity === id) emit({ registered: null });
  }
}

async function refreshPublic(id: Identity) {
  try {
    const spr = await loadSpr();
    const pub = await spr.publicBalances(id.burner, state.registered);
    if (identity === id) emit({ pub });
  } catch {
    /* keep the last figures */
  }
}

/* ------------------------------------------------------------------------------------------- link */

let linkRun = 0;
let lastLinkKey: string | null = null;

function linkErr(e: unknown): { status: LinkStatus; error: string } {
  const err = e as CustodyError;
  if (err?.code === "burner_taken" || err?.status === 409)
    return {
      status: "taken",
      error: "This private wallet is already linked to another Sealed account, so Sealed can't credit its private deposits to you. Sign in with the wallet that opened it.",
    };
  if (err?.status === 401) return { status: "signed_out", error: "" };
  if (err?.status === 404 || err?.status === 503) return { status: "unavailable", error: "Linking isn't available on Sealed right now." };
  return { status: "error", error: errorMessage(e) };
}

/** GET the link for `main`; when a burner is open and nothing is linked, link it (one local signature, no prompt). */
async function syncLink(main: string, autoLink: boolean) {
  const run = ++linkRun;
  if (!getSession(main)) {
    if (state.owner === main) emit({ link: { status: "signed_out", linkedBurner: null, error: null } });
    return;
  }
  if (state.owner === main) emit({ link: { ...state.link, status: "checking", error: null } });
  try {
    const r = await custodyFetch<{ burner: string | null }>(PRIVACY_ROUTES.link, { wallet: main });
    if (run !== linkRun || state.owner !== main) return;
    const linked = r?.burner ?? null;
    const id = identity && identity.main === main ? identity : null;
    if (!id) return emit({ link: { status: linked ? "linked" : "none", linkedBurner: linked, error: null } });
    if (linked === id.burner) return emit({ link: { status: "linked", linkedBurner: linked, error: null } });
    if (linked && !autoLink) return emit({ link: { status: "other", linkedBurner: linked, error: null } });
    if (!linked && !autoLink) return emit({ link: { status: "none", linkedBurner: null, error: null } });
    await postLink(main, id, run);
  } catch (e) {
    if (run !== linkRun || state.owner !== main) return;
    const { status, error } = linkErr(e);
    emit({ link: { status, linkedBurner: state.link.linkedBurner, error: error || null } });
  }
}

async function postLink(main: string, id: Identity, run = ++linkRun) {
  const spr = await loadSpr();
  const signature = spr.signLink(id);
  const r = await custodyFetch<{ linked: true; burner: string }>(PRIVACY_ROUTES.link, { method: "POST", wallet: main, body: { burner: id.burner, signature } });
  if (run !== linkRun || state.owner !== main) return;
  emit({ link: { status: "linked", linkedBurner: r?.burner ?? id.burner, error: null } });
}

/** Make sure Sealed attributes this burner's private deposits to the signed-in account; throws a readable reason. */
async function ensureLinked(id: Identity) {
  if (state.link.status === "linked" && state.link.linkedBurner === id.burner) return;
  if (!getSession(id.main)) throw new Error("Sign in to Sealed first so your private deposit is credited to your account.");
  try {
    await postLink(id.main, id);
  } catch (e) {
    const { status, error } = linkErr(e);
    emit({ link: { status, linkedBurner: state.link.linkedBurner, error: error || null } });
    throw new Error(error || "Sealed couldn't link your private wallet. Nothing was sent.");
  }
  if (!(state.link.status === "linked" && state.link.linkedBurner === id.burner)) throw new Error("Sealed couldn't link your private wallet. Nothing was sent.");
}

/* ---------------------------------------------------------------------------------- unlock / sync */

async function doUnlock(bridge: MainWalletBridge) {
  if (state.phase === "unlocking") return;
  emit({ phase: "unlocking", error: null, owner: bridge.main });
  try {
    const spr = await loadSpr();
    const id = await spr.openBurner(bridge);
    if (state.owner !== bridge.main) {
      spr.destroyIdentity(id);
      return;
    }
    destroyCurrent();
    identity = id;
    emit({ phase: "ready", burner: id.burner, shieldedAddress: id.shieldedAddress });
    void refreshRegistration(id).then(() => refreshPublic(id));
    await doSync();
  } catch (e) {
    emit({ phase: identity ? "ready" : "error", error: await friendly(e) });
  }
}

async function doSync() {
  const id = identity;
  if (!id) return;
  emit({ syncing: true, error: null });
  void refreshPublic(id);
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
  if (!id) throw new Error("Open your private wallet first");
  if (state.op) throw new Error("Another private wallet transaction is in progress");
  emit({ op, error: null });
  try {
    const out = await fn(await loadSpr(), id);
    const b = (out as { balances?: Balances })?.balances;
    if (identity === id) emit({ op: null, ...(b ? { balances: b, syncedAt: Date.now() } : {}) });
    void refreshPublic(id);
    return out;
  } catch (e) {
    const msg = await friendly(e);
    if (identity === id) emit({ op: null, error: msg });
    void refreshPublic(id);
    throw new Error(msg);
  }
}

/* ---------------------------------------------------------------------------------------- hook */

function useSessionToken(wallet: string | null): string | null {
  const get = useCallback(() => getSession(wallet)?.token ?? null, [wallet]);
  return useSyncExternalStore(subscribeSessions, get, () => null);
}

export function useShieldedIdentity() {
  const { publicKey, signMessage, sendTransaction, connected, wallet } = useWallet();
  const owner = connected && publicKey ? publicKey.toBase58() : null;
  const s = useSyncExternalStore(subscribe, () => state, () => EMPTY);
  const token = useSessionToken(owner);

  // Wallet change or disconnect: destroy the keys.
  useEffect(() => {
    if (state.owner !== owner) clearIdentity(owner);
  }, [owner]);

  // Signed in / out (or a burner just opened): refresh the link status.
  // Every mounted surface runs this effect: only the first one per (wallet, session, burner) fetches.
  useEffect(() => {
    if (!owner) return;
    const key = `${owner}|${token ?? ""}|${s.burner ?? ""}`;
    if (lastLinkKey === key) return;
    lastLinkKey = key;
    void syncLink(owner, true);
  }, [owner, token, s.burner]);

  const bridge = useCallback(() => {
    if (!owner) throw new Error("Connect a wallet first");
    return makeBridge(owner, signMessage, sendTransaction as Parameters<typeof makeBridge>[2]);
  }, [owner, signMessage, sendTransaction]);

  const unlock = useCallback(async () => {
    try {
      await doUnlock(bridge());
    } catch (e) {
      emit({ phase: "error", error: await friendly(e) });
    }
  }, [bridge]);

  const register = useCallback(
    () =>
      runOp("register", async (spr, id) => {
        const sig = await spr.register(id);
        emit({ registered: true });
        return sig;
      }),
    [],
  );
  const fund = useCallback((asset: PrivateAsset, amount: number) => runOp("fund", (spr, id) => spr.fundBurner(id, bridge(), asset, amount)), [bridge]);
  const shield = useCallback((asset: PrivateAsset, amount: number) => runOp("shield", (spr, id) => spr.shield(id, asset, amount)), []);
  const unshield = useCallback((asset: PrivateAsset, amount: number) => runOp("unshield", (spr, id) => spr.unshield(id, asset, amount)), []);
  const sweep = useCallback((asset: PrivateAsset, amount: number) => runOp("sweep", (spr, id) => spr.sweepToMain(id, asset, amount)), []);
  const sendToCompany = useCallback(
    (companyShieldedAddress: string, asset: PrivateAsset, amount: number) =>
      runOp("send", async (spr, id) => {
        await ensureLinked(id);
        return spr.sendPrivateToCompany(id, companyShieldedAddress, asset, amount);
      }),
    [],
  );
  const relink = useCallback(async () => {
    const id = identity;
    if (!id) return;
    try {
      await postLink(id.main, id);
    } catch (e) {
      const { status, error } = linkErr(e);
      emit({ link: { status, linkedBurner: state.link.linkedBurner, error: error || null } });
    }
  }, []);

  const view = s.owner === owner ? s : { ...EMPTY, owner };
  const adapter: Adapter | undefined = wallet?.adapter;
  return {
    ...view,
    connected: !!owner,
    signedIn: !!token,
    canSignMessage: !!signMessage,
    walletName: adapter?.name ?? null,
    unlock,
    lock: () => lockIdentity(owner),
    sync: () => doSync(),
    register,
    fund,
    shield,
    unshield,
    sweep,
    sendToCompany,
    relink,
    /** UI units from private-balance atoms (null while locked). */
    uiBalance: (asset: PrivateAsset): number | null => {
      const v = view.balances?.[asset];
      return v === null || v === undefined ? null : atomsToUi(v, asset);
    },
    /** UI units of the burner's PUBLIC balance (null while unknown / no token account). */
    uiPublic: (asset: PrivateAsset): number | null => {
      const v = asset === "SOL" ? view.pub?.sol : view.pub?.usdc;
      return v === null || v === undefined ? null : atomsToUi(v, asset);
    },
  };
}
export type ShieldedIdentityApi = ReturnType<typeof useShieldedIdentity>;

export function atomsToUi(v: bigint, asset: PrivateAsset): number {
  const d = asset === "SOL" ? 9 : 6;
  const str = v.toString().padStart(d + 1, "0");
  return Number(`${str.slice(0, -d)}.${str.slice(-d)}`);
}

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
