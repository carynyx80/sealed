import clsx from "clsx";
import type { ReactNode } from "react";

/** Broadsheet section head: "§ 02 — Trade tape" eyebrow, a display title, optional right-hand fine print. */
export function SectionHead({ mark, title, aside, className, night = false }: { mark: string; title: ReactNode; aside?: ReactNode; className?: string; night?: boolean }) {
  return (
    <header className={clsx("flex flex-wrap items-end justify-between gap-x-4 gap-y-2", className)}>
      <div className="min-w-0">
        <p className={clsx("section-mark", night && "text-night-muted")}>§ {mark}</p>
        <h2 className={clsx("mt-1.5 font-display text-display-sm", night ? "text-night-text" : "text-ink")}>{title}</h2>
      </div>
      {aside && <div className={clsx("min-w-0 font-mono text-[11px] leading-snug", night ? "text-night-muted" : "text-ink-muted")}>{aside}</div>}
    </header>
  );
}

/**
 * The sealed-state ring motif: a slowly rotating dashed outer ring, a solid inner ring and a centre point.
 * Used wherever something is hidden / encrypted (bid sizes, private deposits, shielded balances).
 */
export function SealRing({ size = 28, className, spin = true, tone = "signal" }: { size?: number; className?: string; spin?: boolean; tone?: "signal" | "ink" | "night" }) {
  const c = tone === "signal" ? "text-signal" : tone === "night" ? "text-night-text" : "text-ink";
  return (
    <span className={clsx("relative inline-block shrink-0", c, className)} style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 32 32" className={clsx("absolute inset-0 h-full w-full", spin && "animate-ring")} fill="none">
        <circle cx="16" cy="16" r="15" stroke="currentColor" strokeWidth="1" strokeDasharray="1.5 2.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <svg viewBox="0 0 32 32" className="absolute inset-0 h-full w-full" fill="none">
        <circle cx="16" cy="16" r="10" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <circle cx="16" cy="16" r="5.5" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <circle cx="16" cy="16" r="1.6" fill="currentColor" />
      </svg>
    </span>
  );
}

/** Ruled key/value row for ledgers (dl > div). Values are always mono. */
export function LedgerRow({ k, v, note, strong = false }: { k: ReactNode; v: ReactNode; note?: ReactNode; strong?: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 border-t border-rule py-2.5 first:border-t-0">
      <dt className="min-w-0 text-[13px] text-ink-slate">
        {k}
        {note && <span className="ml-1.5 font-mono text-[10px] text-ink-muted">{note}</span>}
      </dt>
      <dd className={clsx("num truncate text-right text-[13px]", strong ? "text-ink" : "text-ink-soft")}>{v}</dd>
    </div>
  );
}

/** Unit suffix set in small muted mono, e.g. the "SOL" after an amount. */
export function Unit({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx("ml-1 font-mono text-[0.62em] font-normal uppercase tracking-[0.04em] text-ink-muted", className)}>{children}</span>;
}
