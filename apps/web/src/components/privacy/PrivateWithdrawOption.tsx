"use client";
// Owned by privacy-web-agent. WithdrawSheet option: Sealed pays out with a confidential transfer to the user's own
// Shielded Address (`privateTo` on POST /api/account/withdrawals). Needs the identity unlocked to know that address.
import clsx from "clsx";
import type { ShieldedIdentityApi } from "@/lib/privacy/session";
import { shortAddr } from "@/lib/format";
import { RingMark } from "./RingMotif";
import { UnlockPrompt } from "./ShieldedIdentity";

export function PrivateWithdrawOption({ id, checked, onChange }: { id: ShieldedIdentityApi; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={clsx("mt-4 rounded-field border p-3.5 transition-colors", checked ? "border-signal/40 bg-signal-tint/50" : "border-rule bg-sheet")}>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[#2E3FE0]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-[14px] font-semibold text-ink">
            <RingMark size={16} active={checked} className="text-signal" /> Send privately to my shielded address
          </span>
          <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-slate">
            Paid into your Helius Privacy Ring balance with the amount encrypted on-chain. Sealed&apos;s address and yours stay visible.
          </span>
        </span>
      </label>
      {checked && (
        <div className="mt-3">
          {id.phase === "ready" && id.shieldedAddress ? (
            <p className="font-mono text-[11px] text-ink-slate">To {shortAddr(id.shieldedAddress, 10)}</p>
          ) : (
            <UnlockPrompt id={id} compact />
          )}
        </div>
      )}
    </div>
  );
}
