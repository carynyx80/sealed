"use client";
// Owned by privacy-web-agent. Private deposit API calls (Bearer session from lib/custody). 404/503 resolve to a
// clear "not available" state instead of throwing into the UI.
import { useCallback, useEffect, useRef, useState } from "react";
import { CustodyError, custodyFetch } from "../custody/client";
import { errorMessage } from "../defi/config";
import { PRIVACY_ROUTES, type PrivacyDepositInfo, type PrivacyDepositRecord } from "./contract";

function unavailable(e: unknown): string {
  const st = (e as CustodyError)?.status;
  if (st === 404 || st === 503) return "Private deposits are not open on Sealed right now.";
  return errorMessage(e);
}

export function usePrivacyDepositInfo(wallet: string | null, enabled: boolean) {
  const [data, setData] = useState<PrivacyDepositInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    if (!wallet || !enabled) return;
    custodyFetch<PrivacyDepositInfo>(PRIVACY_ROUTES.depositInfo, { wallet })
      .then((r) => {
        if (!live) return;
        if (!r || typeof r.enabled !== "boolean") throw new Error("Unexpected response from the privacy API");
        setData(r);
      })
      .catch((e) => live && setError(unavailable(e)));
    return () => {
      live = false;
    };
  }, [wallet, enabled]);
  return { data, error };
}

export async function claimPrivateDeposit(wallet: string, signature: string): Promise<{ status: string; reason?: string }> {
  return custodyFetch<{ status: string; reason?: string }>(PRIVACY_ROUTES.claimDeposit, { method: "POST", wallet, body: { signature } });
}

/** Poll GET /api/privacy/deposits for one signature until credited / rejected (or the component unmounts). */
export function usePrivateDepositTracking(wallet: string | null, signature: string | null) {
  const [record, setRecord] = useState<PrivacyDepositRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tries = useRef(0);
  const poll = useCallback(async () => {
    if (!wallet || !signature) return null;
    const r = await custodyFetch<{ deposits: PrivacyDepositRecord[] }>(PRIVACY_ROUTES.deposits, { wallet });
    return r?.deposits?.find((d) => d.signature === signature) ?? null;
  }, [wallet, signature]);

  useEffect(() => {
    setRecord(null);
    setError(null);
    tries.current = 0;
    if (!wallet || !signature) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      tries.current++;
      try {
        const rec = await poll();
        if (!live) return;
        if (rec) setRecord(rec);
        if (rec && (rec.status === "credited" || rec.status === "rejected")) return;
        // Re-nudge the claim now and then in case the first claim raced the indexer.
        if (tries.current % 5 === 0) void claimPrivateDeposit(wallet, signature).catch(() => undefined);
      } catch (e) {
        if (live) setError(unavailable(e));
      }
      if (live && tries.current < 120) timer = setTimeout(tick, tries.current < 10 ? 3000 : 8000);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [wallet, signature, poll]);
  return { record, error };
}
