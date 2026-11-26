"use client";
// Owned by privacy-web-agent. WithdrawSheet option: Sealed pays out with a confidential transfer into the user's
// linked private Sealed wallet (`privateTo: "linked"` on POST /api/account/withdrawals; the backend resolves the
// linked burner). Needs a link, which is made the first time the private wallet is opened while signed in.
import clsx from "clsx";
import type { ShieldedIdentityApi } from "@/lib/privacy/session";
import { shortAddr } from "@/lib/format";
import { RingMark } from "./RingMotif";
import { UnlockPrompt } from "./ShieldedIdentity";

/** The linked private wallet, when the backend has one for this account. */
export function linkedPrivateWallet(id: ShieldedIdentityApi): string | null {
  if (id.link.status !== "linked" && id.link.status !== "other") return null;
  return id.link.linkedBurner;
}

export function PrivateWithdrawOption({ id, checked, onChange }: { id: ShieldedIdentityApi; checked: boolean; onChange: (v: boolean) => void }) {
  const linked = linkedPrivateWallet(id);
  return (
    <div className={clsx("mt-4 rounded-field border p-3.5 transition-colors", checked ? "border-signal/40 bg-signal-tint/50" : "border-rule bg-sheet")}>
      <label className="flex min-h-[44px] cursor-pointer items-start gap-3">
        <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[#2E3FE0]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-[14px] font-semibold text-ink">
            <RingMark size={16} active={checked} className="text-signal" /> Send privately to my private wallet
          </span>
          <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-slate">
            Paid into your private wallet&apos;s Helius Privacy Ring balance with the amount encrypted on-chain. Sealed&apos;s address and your private
            wallet&apos;s stay visible.
          </span>
        </span>
      </label>
      {checked && (
        <div className="mt-3">
          {linked ? (
            <p className="font-mono text-[11px] text-ink-slate">
              To your linked private wallet {shortAddr(linked, 6)}. It arrives in its private balance on your account page.
            </p>
          ) : id.link.status === "checking" || id.link.status === "unknown" ? (
            <p className="fine">Checking your linked private wallet…</p>
          ) : (
            <div>
              <p className="mb-2 text-[12px] leading-relaxed text-ink-slate">
                Open your private wallet once so Sealed can link it to your account (no funds move). It must also be registered, on your account page.
              </p>
              {id.phase === "ready" ? (
                id.link.error ? <p className="text-[12px] text-burn">{id.link.error}</p> : <p className="fine">Linking…</p>
              ) : (
                <UnlockPrompt id={id} compact />
              )}
              {id.phase !== "ready" && id.error && <p className="mt-2 font-mono text-[11px] text-burn" role="alert">{id.error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
