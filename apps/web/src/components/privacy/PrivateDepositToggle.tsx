"use client";
// Owned by privacy-web-agent. Commit-bid card row about privacy of the bid deposit.
//
// Decision: informational, not a switch. In custodial mode the bid deposit is a ledger lock on the user's Sealed
// balance; nothing about it touches the chain, so there is nothing to "fund privately" per bid. What can leak is how
// the Sealed balance was funded. A private deposit (Helius Privacy Ring confidential transfer to Sealed custody) hides
// that amount on-chain, so this row points there. A toggle here would promise something the bid itself can't change.
// The props stay for CommitBidCard compatibility; `enabled` is forced back to false. On-chain mode renders nothing.
import { useEffect } from "react";
import type { LaunchSummary } from "@sealed/shared";
import { usePrivacyRing } from "@/lib/privacy/usePrivacyRing";
import { preferPrivateDeposit } from "@/lib/privacy/session";
import { isPrivateAsset } from "@/lib/privacy/contract";
import { openDeposit } from "@/lib/custody/sheets";
import { EXECUTION_MODE } from "@/lib/custody/client";
import { RingMark } from "./RingMotif";

export function PrivateDepositToggle({ launch, enabled, onChange }: { launch: LaunchSummary; enabled: boolean; onChange: (v: boolean) => void }) {
  const ring = usePrivacyRing();
  useEffect(() => {
    if (enabled) onChange(false);
  }, [enabled, onChange]);

  // On-chain mode the escrow deposit is a public SPL transfer the ring can't fund yet (fails closed): show nothing.
  if (EXECUTION_MODE !== "offchain" || !ring.privateEnabled || !isPrivateAsset(launch.quoteAsset)) return null;

  return (
    <div className="flex items-start gap-3.5 rounded-field border border-rule bg-sheet px-3.5 py-3">
      <RingMark size={26} className="mt-0.5 text-signal" />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold text-ink">Deposit size stays off-chain</p>
        <p className="mt-0.5 text-[12.5px] leading-snug text-ink-slate">
          Your bid deposit is locked inside your Sealed balance, so no transfer shows it. To keep how you funded that balance private too,
          top it up with a private deposit through the Helius Privacy Ring.
        </p>
        <button
          type="button"
          className="btn-link mt-1.5 !text-[12.5px]"
          onClick={() => {
            preferPrivateDeposit();
            openDeposit(launch.quoteAsset);
          }}
        >
          Make a private deposit
        </button>
        <p className="mt-1 font-mono text-[10.5px] leading-snug text-ink-muted">Addresses stay visible · amounts don&apos;t</p>
      </div>
    </div>
  );
}
