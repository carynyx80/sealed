"use client";
// Owned by helius-privacy-agent. Commit-bid card row: fund the escrow deposit from a Helius Privacy Ring
// confidential balance. Disabled (with the reason) whenever the ring cannot fund this launch's escrow.
import { useEffect, useId } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import type { LaunchSummary } from "@sealed/shared";
import { SPR_READY_ASSETS } from "@sealed/defi";
import { SPRING } from "@/components/motion/spring";
import { usePrivacyRing } from "@/lib/privacy/usePrivacyRing";
import { DEMO_ENABLED } from "@/lib/config";
import { RingMark } from "./RingMotif";

const STEP: Record<string, string> = {
  proving: "Proving balance…",
  submitting: "Funding escrow confidentially…",
  done: "Deposit funded from the ring",
};

export function PrivateDepositToggle({ launch, enabled, onChange }: { launch: LaunchSummary; enabled: boolean; onChange: (v: boolean) => void }) {
  const ring = usePrivacyRing();
  const id = useId();

  const reason: string | null = ring.loading
    ? "Checking Privacy Ring…"
    : launch.isDemo && DEMO_ENABLED
      ? null // demo launches always use the simulated ring
      : !ring.available
        ? ring.reason ?? `Helius Privacy Ring is unavailable on ${launch.network}`
        : ring.simulated
          ? "This deployment runs a simulated ring; real launches bid publicly"
          : !SPR_READY_ASSETS.includes(launch.quoteAsset)
            ? `${launch.quoteAsset} has no Privacy Ring interface yet`
            : !ring.escrowFunding
              ? "Escrow can't receive confidential deposits until the program upgrade"
              : null;
  const disabled = reason !== null;

  // Never leave a private deposit selected when it can't be honoured.
  useEffect(() => {
    if (disabled && enabled && !ring.loading) onChange(false);
  }, [disabled, enabled, ring.loading, onChange]);

  const on = enabled && !disabled;
  const step = on && STEP[ring.status];

  return (
    <div className={clsx("flex items-start gap-3.5 rounded-field border px-3.5 py-3 transition-colors", on ? "border-signal/40 bg-signal-tint/60" : "border-rule bg-sheet")}>
      <RingMark size={26} active={on} className={clsx("mt-0.5 transition-colors", on ? "text-signal" : "text-ink-muted")} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={id} className={clsx("text-[14px] font-semibold", disabled ? "text-ink-muted" : "text-ink")}>
            Private deposit
          </label>
          <span className="rounded-full border border-signal/30 px-1.5 py-px font-mono text-[9.5px] uppercase tracking-[0.08em] text-signal">beta</span>
          {launch.isDemo && DEMO_ENABLED && <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">simulated</span>}
        </div>
        <p className="mt-0.5 text-[12.5px] leading-snug text-ink-slate">
          Fund the escrow from your Helius Privacy Ring balance, so the deposit size stays encrypted.
        </p>
        <p id={`${id}-note`} className={clsx("mt-1.5 font-mono text-[10.5px] leading-snug", step ? "text-signal" : "text-ink-muted")} aria-live="polite">
          {disabled ? reason : step || (ring.status === "error" && ring.error) || "Addresses stay visible · amounts don't"}
        </p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={on}
        aria-describedby={`${id}-note`}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={clsx(
          "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:shadow-focus",
          on ? "border-signal bg-signal" : "border-rule-strong bg-paper-deep",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <motion.span layout transition={SPRING} className={clsx("mx-0.5 h-5 w-5 rounded-full bg-sheet shadow-[0_1px_2px_rgba(15,15,13,0.2)]", on && "ml-auto")} />
      </button>
    </div>
  );
}
