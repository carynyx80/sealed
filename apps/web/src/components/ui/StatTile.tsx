import clsx from "clsx";
import type { ReactNode } from "react";

export function StatTile({ label, value, sub, className, accent }: { label: string; value: ReactNode; sub?: ReactNode; className?: string; accent?: "emerald" | "terracotta" | "gain" | "burn" | "signal" }) {
  return (
    <div className={clsx("flex min-w-0 flex-col gap-1", className)}>
      <span className="eyebrow">{label}</span>
      <span className={clsx("num truncate text-xl text-ink sm:text-2xl", (accent === "emerald" || accent === "gain") && "text-gain", (accent === "terracotta" || accent === "burn") && "text-burn", accent === "signal" && "text-signal")}>{value}</span>
      {sub && <span className="truncate text-xs text-ink-slate">{sub}</span>}
    </div>
  );
}
