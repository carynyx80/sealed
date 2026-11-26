import clsx from "clsx";
import type { ReactNode } from "react";

/** Legacy tones (emerald, terracotta, linen) are kept as aliases of gain / burn / paper. */
export type BadgeTone = "neutral" | "ink" | "paper" | "signal" | "gain" | "burn" | "night" | "emerald" | "terracotta" | "linen";

const TONES: Record<BadgeTone, string> = {
  neutral: "border-rule bg-sheet text-ink-slate",
  paper: "border-rule bg-paper-deep text-ink-slate",
  linen: "border-rule bg-paper-deep text-ink-slate",
  signal: "border-signal/20 bg-signal-tint text-signal-ink",
  gain: "border-gain/20 bg-gain-tint text-gain",
  emerald: "border-gain/20 bg-gain-tint text-gain",
  burn: "border-burn/20 bg-burn-tint text-burn",
  terracotta: "border-burn/20 bg-burn-tint text-burn",
  ink: "border-ink bg-ink text-paper",
  night: "border-night-rule bg-night-raised text-night-text",
};

const DOTS: Record<BadgeTone, string> = {
  neutral: "bg-ink-muted", paper: "bg-ink-muted", linen: "bg-ink-muted", signal: "bg-signal",
  gain: "bg-gain", emerald: "bg-gain", burn: "bg-burn", terracotta: "bg-burn", ink: "bg-paper", night: "bg-night-text",
};

export function Badge({ children, tone = "neutral", className, dot }: { children: ReactNode; tone?: BadgeTone; className?: string; dot?: boolean }) {
  return (
    <span className={clsx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-[5px] text-[11px] font-medium leading-none", TONES[tone], className)}>
      {dot && <span className={clsx("h-1.5 w-1.5 rounded-full", DOTS[tone])} />}
      {children}
    </span>
  );
}
