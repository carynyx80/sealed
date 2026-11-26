"use client";
// Owned by helius-privacy-agent. Helius Solana Privacy Rings in the UI: status, encrypted balances, viewing-key
// decryption, shield / unshield. Demo + unsupported deployments use the simulated ring (never real funds).
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { QUOTE_ASSETS, type QuoteAssetSymbol } from "@sealed/shared";
import type { PrivacyStatus as PrivacyStatusResponse } from "./contract";
import { atomsToUi, simulatedViewingKey, uiToAtoms, type EncryptedBalance, type PrivacyRingClient } from "@sealed/defi";
import { errorMessage } from "../defi/config";
import { DEMO_ENABLED } from "../config";
import { cachedPrivacyStatus, fetchPrivacyStatus, privacyOwner, privateFeaturesOn, ringFor } from "./ring";

export type PrivacyRingStatus = "unavailable" | "idle" | "proving" | "submitting" | "done" | "error";
export interface ShieldedBalance { symbol: QuoteAssetSymbol; amount: number | null; encrypted: boolean }

/* ------------------------------------------------------------------------------ tiny shared store */

interface State {
  ring: PrivacyStatusResponse | null;
  op: PrivacyRingStatus;
  error: string | null;
  /** keyed `${owner}:${symbol}` */
  plain: Record<string, number>;
  cipher: Record<string, EncryptedBalance>;
}
let state: State = { ring: cachedPrivacyStatus(), op: "idle", error: null, plain: {}, cipher: {} };
const listeners = new Set<() => void>();
const emit = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => state;
const SERVER_STATE: State = { ring: null, op: "idle", error: null, plain: {}, cipher: {} };
const serverSnapshot = () => SERVER_STATE;

/** Exposed for useSealedBid so a private bid reflects in the shared ring state. */
export function setPrivacyOp(op: PrivacyRingStatus, error: string | null = null) {
  emit({ op, error });
}
/** Re-encrypt the displayed balance after a balance-changing operation (forces a fresh decrypt). */
export function invalidateShieldedBalance(owner: string, symbol: QuoteAssetSymbol) {
  const k = `${owner}:${symbol}`;
  const plain = { ...state.plain };
  delete plain[k];
  const cipher = { ...state.cipher };
  delete cipher[k];
  emit({ plain, cipher });
}

const decimals = (s: QuoteAssetSymbol) => QUOTE_ASSETS[s].decimals;

// Development only (stripped from production builds): lets a local browser session preview the enabled private
// surfaces against a mocked status, e.g. `window.__sealedPrivacyStatus({ enabled: true, ... })`.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as unknown as { __sealedPrivacyStatus?: (s: PrivacyStatusResponse) => void }).__sealedPrivacyStatus = (ring) => emit({ ring });
}

/* ----------------------------------------------------------------------------------------- hook */

export function usePrivacyRing() {
  const { publicKey } = useWallet();
  const s = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const owner = privacyOwner(publicKey?.toBase58());

  useEffect(() => {
    if (state.ring) return;
    let live = true;
    fetchPrivacyStatus().then((ring) => live && emit({ ring }));
    return () => {
      live = false;
    };
  }, []);

  const ring = s.ring;
  // Mainnet never simulates (DEMO_ENABLED is false there); ring.ts also normalises a simulated status away.
  const simulated = DEMO_ENABLED && (ring ? ring.simulated : true);
  const available = ring ? ring.available : false;
  const client: PrivacyRingClient = useMemo(() => ringFor(simulated), [simulated]);
  const caps = client.capabilities();

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    emit({ op: "proving", error: null });
    try {
      const out = await fn();
      emit({ op: "done" });
      return out;
    } catch (e) {
      emit({ op: "error", error: errorMessage(e) });
      throw e;
    }
  }, []);

  const balance = useCallback(
    (sym: QuoteAssetSymbol): ShieldedBalance => {
      const v = s.plain[`${owner}:${sym}`];
      return v === undefined ? { symbol: sym, amount: null, encrypted: true } : { symbol: sym, amount: v, encrypted: false };
    },
    [s.plain, owner],
  );

  /** Ciphertext view (what any observer can fetch). */
  const encrypted = useCallback((sym: QuoteAssetSymbol): EncryptedBalance | null => s.cipher[`${owner}:${sym}`] ?? null, [s.cipher, owner]);

  const refreshEncrypted = useCallback(
    async (sym: QuoteAssetSymbol): Promise<EncryptedBalance | null> => {
      if (!available) return null;
      try {
        const e = await client.encryptedBalance(owner, sym);
        emit({ cipher: { ...state.cipher, [`${owner}:${sym}`]: e } });
        return e;
      } catch {
        return null;
      }
    },
    [available, client, owner],
  );

  const decrypt = useCallback(
    (sym: QuoteAssetSymbol): Promise<number | null> =>
      run(async () => {
        if (!available) throw new Error(ring?.reason ?? "Privacy Ring unavailable on this network");
        // Simulated ring: the device-local demo viewing key. Real ring: the SDK derives the X25519 viewing key
        // from the wallet (see HeliusSprBindings); without it the client throws a clear "SDK not enabled" error.
        const vk = simulated ? simulatedViewingKey(owner) : new Uint8Array(0);
        const atoms = await client.decryptBalance(owner, sym, vk);
        const ui = atomsToUi(atoms, decimals(sym));
        emit({ plain: { ...state.plain, [`${owner}:${sym}`]: ui } });
        return ui;
      }),
    [run, available, ring?.reason, simulated, client, owner],
  );

  /** Hide a decrypted balance again (client-side only). */
  const conceal = useCallback((sym: QuoteAssetSymbol) => {
    const plain = { ...state.plain };
    delete plain[`${owner}:${sym}`];
    emit({ plain });
  }, [owner]);

  const shield = useCallback(
    (amount: number, sym: QuoteAssetSymbol): Promise<string> =>
      run(async () => {
        const r = await client.shield({ owner, symbol: sym, atoms: uiToAtoms(amount, decimals(sym)) });
        invalidateShieldedBalance(owner, sym);
        void refreshEncrypted(sym);
        return r.signature;
      }),
    [run, client, owner, refreshEncrypted],
  );

  const unshield = useCallback(
    (amount: number, sym: QuoteAssetSymbol): Promise<string> =>
      run(async () => {
        const r = await client.unshield({ owner, recipient: publicKey?.toBase58() ?? owner, symbol: sym, atoms: uiToAtoms(amount, decimals(sym)) });
        invalidateShieldedBalance(owner, sym);
        void refreshEncrypted(sym);
        return r.signature;
      }),
    [run, client, owner, publicKey, refreshEncrypted],
  );

  return {
    /** true when Helius Privacy Ring is usable on this network (mainnet) or simulated (demo). */
    available,
    simulated,
    status: (available ? s.op : "unavailable") as PrivacyRingStatus,
    error: s.error,
    balance,
    decrypt,
    shield,
    unshield,
    /* additive extras */
    loading: ring === null,
    /** Real Helius Privacy Ring features (SDK) are switched on for this deployment. */
    privateEnabled: privateFeaturesOn(ring),
    statusRaw: ring,
    network: ring?.network ?? client.network,
    ringId: ring?.ringId,
    reason: ring?.reason,
    /** Can a sealed-bid escrow be funded from the ring on this deployment? */
    escrowFunding: ring ? !!ring.escrowFunding && (simulated || caps.fundProgramEscrow) : false,
    owner,
    encrypted,
    refreshEncrypted,
    conceal,
  };
}
