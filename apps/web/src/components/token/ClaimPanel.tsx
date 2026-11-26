"use client";
// Post-auction claim for the offchain custodial ledger: POST /api/trade/claim/:launchId via useSealedBid().claim().
// Credits won tokens + the unspent deposit (or the full deposit on a failed auction) to the Sealed balance.
// Server-side the claim is idempotent, so a repeat returns the same amounts; we also remember the receipt per
// wallet+launch in localStorage so the panel shows "Claimed" on later visits instead of an action.
import { useEffect, useState } from "react";
import clsx from "clsx";
import type { LaunchSummary } from "@sealed/shared";
import { defaultVaultStorage } from "@sealed/defi";
import { useSealedBid } from "@/lib/defi/useSealedBid";
import { CustodyError, useCustodySession } from "@/lib/custody";
import { fmtAmount, fmtCompact } from "@/lib/format";
import { CheckIcon } from "../ui/Icons";
import { LedgerRow } from "./RoomParts";

interface Receipt { tokens: number; refund: number; ts: number }
const receiptKey = (wallet: string, launchId: string) => `sealed-claim:v1:${wallet}:${launchId}`;

function readReceipt(wallet: string, launchId: string): Receipt | null {
  try {
    const raw = localStorage.getItem(receiptKey(wallet, launchId));
    return raw ? (JSON.parse(raw) as Receipt) : null;
  } catch {
    return null;
  }
}
function writeReceipt(wallet: string, launchId: string, r: Receipt) {
  try {
    localStorage.setItem(receiptKey(wallet, launchId), JSON.stringify(r));
  } catch {
    /* private mode: the server-side claim is idempotent, nothing is lost */
  }
}

/** Does this browser's bid vault hold a sealed bid for this wallet + launch? (key presence only, no decryption). */
function useLocalBid(wallet: string | null, launchId: string): boolean | null {
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    if (!wallet) return setHas(null);
    let live = true;
    defaultVaultStorage()
      .get(`${wallet}:${launchId}`)
      .then((v) => live && setHas(!!v))
      .catch(() => live && setHas(false));
    return () => {
      live = false;
    };
  }, [wallet, launchId]);
  return has;
}

type Outcome = { kind: "none" } | { kind: "pending"; text: string } | { kind: "error"; text: string };

/**
 * `variant="embedded"` sits inside the clearing / failed status panel (shown to any signed-in wallet there).
 * `variant="card"` is the live-state rail card, shown only when this browser holds a bid for the launch or a receipt.
 */
export function ClaimPanel({ launch: L, variant }: { launch: LaunchSummary; variant: "embedded" | "card" }) {
  const custody = useCustodySession();
  const bid = useSealedBid(L);
  const wallet = custody.wallet;
  const localBid = useLocalBid(wallet, L.id);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [noBid, setNoBid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "none" });

  useEffect(() => {
    setReceipt(wallet ? readReceipt(wallet, L.id) : null);
    setNoBid(false);
    setOutcome({ kind: "none" });
  }, [wallet, L.id]);

  const offchain = custody.availability === "available";
  const failed = L.status === "failed";
  const cleared = L.status === "live" || L.status === "flywheel" || failed;
  const clearing = L.status === "clearing";
  if (!offchain || !wallet || noBid || (!cleared && !clearing)) return null;
  if (variant === "card" && !localBid && !receipt) return null;
  if (variant === "embedded" && !custody.signedIn && !localBid && !receipt) return null;

  const claim = async () => {
    setBusy(true);
    setOutcome({ kind: "none" });
    try {
      if (!custody.signedIn) await custody.signIn();
      const r = await bid.claim();
      if (!(r.tokens > 0) && !(r.refund > 0)) {
        setNoBid(variant === "card");
        setOutcome({ kind: "pending", text: "Nothing to claim for this wallet on this launch." });
        return;
      }
      const rec = { tokens: r.tokens, refund: r.refund, ts: Math.floor(Date.now() / 1000) };
      writeReceipt(wallet, L.id, rec);
      setReceipt(rec);
    } catch (e) {
      const status = e instanceof CustodyError ? e.status : 0;
      const msg = e instanceof Error ? e.message : String(e);
      if (status === 404 && /no bid/i.test(msg)) {
        // This wallet never bid here: drop the action entirely.
        setNoBid(true);
      } else if (status === 409) {
        setOutcome({ kind: "pending", text: /not settled|not cleared/i.test(msg) ? "Your bid is still being settled. Try again in a moment." : msg });
      } else {
        setOutcome({ kind: "error", text: msg });
      }
    } finally {
      setBusy(false);
    }
  };

  const label = failed ? "Claim refund" : "Claim tokens & refund";
  const body = receipt ? (
    <div>
      <p className="flex items-center gap-2 text-[13px] font-medium text-gain">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gain text-white"><CheckIcon width={11} height={11} /></span>
        Claimed to your Sealed balance
      </p>
      <dl className="mt-3 border-y border-rule">
        {!failed && <LedgerRow k="Tokens received" v={<>{fmtCompact(receipt.tokens, 2)} <span className="text-ink-muted">{L.ticker}</span></>} strong />}
        <LedgerRow k={failed ? "Deposit refunded" : "Refund"} v={<>{fmtAmount(receipt.refund)} <span className="text-ink-muted">{L.quoteAsset}</span></>} strong />
      </dl>
      <p className="fine mt-2">Recorded by Sealed&apos;s ledger. Withdraw any time from your account.</p>
    </div>
  ) : (
    <div>
      <p className="text-[13px] leading-relaxed text-ink-slate">
        {clearing
          ? "Claims open as soon as the clearing price is final."
          : failed
            ? "Your full deposit returns to your Sealed balance."
            : "Won tokens and any unspent deposit are credited to your Sealed balance."}
      </p>
      <button
        type="button"
        className="btn-primary mt-4 min-h-[48px] w-full py-3"
        disabled={busy || clearing || custody.signingIn}
        aria-busy={busy}
        onClick={() => void claim()}
      >
        {busy ? (custody.signingIn ? "Check your wallet…" : "Claiming…") : clearing ? "Claim opens after clearing" : !custody.signedIn ? `Sign in · ${label.toLowerCase()}` : label}
      </button>
      {outcome.kind !== "none" && (
        <p role={outcome.kind === "error" ? "alert" : "status"} className={clsx("mt-3 text-[12px] leading-relaxed", outcome.kind === "error" ? "text-burn" : "text-ink-slate")}>
          {outcome.text}
        </p>
      )}
    </div>
  );

  if (variant === "embedded") {
    return (
      <div className="mt-5 border-t border-rule pt-4">
        <p className="eyebrow mb-2">Your bid</p>
        {body}
      </div>
    );
  }
  return (
    <section className="card min-w-0 p-5 sm:p-6" aria-labelledby="claim-title">
      <p className="section-mark">§ Auction — Settlement</p>
      <h2 id="claim-title" className="mt-3 font-display text-display-sm text-ink">
        {receipt ? <>Your allocation is <span className="accent">in</span></> : <>Claim your <span className="accent">allocation</span></>}
      </h2>
      <div className="mt-4">{body}</div>
    </section>
  );
}
