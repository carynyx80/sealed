import clsx from "clsx";
import type { LaunchStatus } from "@sealed/shared";
import { LockIcon } from "../ui/Icons";

const MAP: Record<LaunchStatus, { label: string; cls: string; dot: string }> = {
  commit: { label: "Sealed · Commit window", cls: "border-ink bg-ink text-paper", dot: "" },
  reveal: { label: "Reveal window", cls: "border-burn/25 bg-burn-tint text-burn", dot: "bg-burn" },
  clearing: { label: "Clearing", cls: "border-rule bg-paper-deep text-ink-slate", dot: "bg-ink-slate" },
  live: { label: "Live · Buyback vault", cls: "border-gain/20 bg-gain-tint text-gain", dot: "bg-gain" },
  flywheel: { label: "Flywheel", cls: "border-gain/20 bg-gain-tint text-gain", dot: "bg-gain" },
  failed: { label: "Refunded", cls: "border-rule bg-sheet text-ink-slate", dot: "bg-ink-muted" },
};

const chip = "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase leading-none tracking-[0.06em]";

export function CommitRevealBadge({ status, className }: { status: LaunchStatus; className?: string }) {
  const m = MAP[status];
  return (
    <span className={clsx(chip, m.cls, className)}>
      {status === "commit" ? <LockIcon width={11} height={11} strokeWidth={1.5} /> : <span className={clsx("h-1.5 w-1.5 rounded-full", m.dot, (status === "reveal" || status === "live") && "animate-pulse-soft")} />}
      {m.label}
    </span>
  );
}

/** "Amounts hidden" marker, drawn with the sealed ring motif. */
export function PrivacyBadge({ className }: { className?: string }) {
  return (
    <span className={clsx(chip, "border-signal/25 bg-signal-tint text-signal", className)}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1" strokeDasharray="1.2 1.8" />
        <circle cx="8" cy="8" r="4" stroke="currentColor" strokeWidth="1" />
        <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      </svg>
      Amounts hidden
    </span>
  );
}
