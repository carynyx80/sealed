import clsx from "clsx";
import { ShieldIcon } from "../ui/Icons";

/** Eligibility for holder rewards. Wallets that bought in the graduation slot get 0%. */
export function AntiSnipeBadge({ eligible, className }: { eligible: boolean | null; className?: string }) {
  const tone =
    eligible === null
      ? "border-rule bg-paper-deep text-ink-slate"
      : eligible
        ? "border-gain/20 bg-gain-tint text-gain"
        : "border-burn/20 bg-burn-tint text-burn";
  const label = eligible === null ? "Anti-snipe protected" : eligible ? "Eligible · not in registry" : "Graduation-slot buyer · 0%";
  return (
    <span className={clsx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase leading-none tracking-[0.06em]", tone, className)}>
      <ShieldIcon width={11} height={11} strokeWidth={1.25} /> {label}
    </span>
  );
}
