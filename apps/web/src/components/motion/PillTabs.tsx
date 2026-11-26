"use client";
import { motion } from "framer-motion";
import clsx from "clsx";
import { SPRING } from "./spring";

export interface PillTab<T extends string> { id: T; label: string; count?: number }

/**
 * Segmented tabs with a shared-layout indicator.
 * - `variant="pill"` (default): ink pill sliding inside a hairline capsule.
 * - `variant="rule"`: broadsheet section tabs — large labels on a hairline with an ink underline that slides.
 */
export function PillTabs<T extends string>({ tabs, value, onChange, layoutId, size = "md", className, variant = "pill" }: { tabs: PillTab<T>[]; value: T; onChange: (v: T) => void; layoutId: string; size?: "sm" | "md"; className?: string; variant?: "pill" | "rule" }) {
  if (variant === "rule") {
    return (
      <div role="tablist" className={clsx("no-scrollbar flex max-w-full items-end gap-6 overflow-x-auto border-b border-rule sm:gap-8", className)}>
        {tabs.map((t) => {
          const active = t.id === value;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => onChange(t.id)}
              className={clsx("relative flex shrink-0 items-baseline gap-2 whitespace-nowrap pb-3 pt-1 font-semibold tracking-[-0.01em] transition-colors", size === "sm" ? "text-sm" : "text-[15px] sm:text-base", active ? "text-ink" : "text-ink-muted hover:text-ink-slate")}
            >
              {t.label}
              {t.count !== undefined && <span className={clsx("num text-[11px] font-normal", active ? "text-ink-slate" : "text-ink-muted")}>{String(t.count).padStart(2, "0")}</span>}
              {active && <motion.span layoutId={layoutId} className="absolute inset-x-0 -bottom-px h-[2px] bg-ink" transition={SPRING} />}
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div role="tablist" className={clsx("no-scrollbar inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-rule bg-sheet p-[3px]", className)}>
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={clsx(
              "relative shrink-0 whitespace-nowrap rounded-full font-medium transition-colors",
              size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm",
              active ? "text-paper" : "text-ink-slate hover:text-ink",
            )}
          >
            {active && <motion.span layoutId={layoutId} className="absolute inset-0 rounded-full bg-ink" transition={SPRING} />}
            <span className="relative z-10 flex items-center gap-1.5">
              {t.label}
              {t.count !== undefined && <span className={clsx("num text-[10px]", active ? "text-paper/70" : "text-ink-muted")}>{t.count}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
