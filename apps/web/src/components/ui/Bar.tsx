"use client";
import { motion } from "framer-motion";
import { useReducedMotion } from "@/components/motion/reduced";
import clsx from "clsx";
import { SPRING_SOFT } from "../motion/spring";

type BarTone = "gain" | "ink" | "burn" | "signal" | "emerald" | "terracotta";
const FILL: Record<BarTone, string> = { gain: "bg-gain", emerald: "bg-gain", ink: "bg-ink", burn: "bg-burn", terracotta: "bg-burn", signal: "bg-signal" };

/** Thin progress bar on a hairline track. pct 0–100. `ticks` draws quarter marks like a printed gauge. */
export function Bar({ pct, tone = "gain", height = 6, className, label, ticks = false, track = "bg-paper-deep" }: { pct: number; tone?: BarTone; height?: number; className?: string; label?: string; ticks?: boolean; track?: string }) {
  const reduce = useReducedMotion();
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className={clsx("relative w-full overflow-hidden rounded-full", track, className)} style={{ height }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)} aria-label={label}>
      <motion.div className={clsx("h-full rounded-full", FILL[tone])} initial={reduce ? false : { width: 0 }} animate={{ width: `${p}%` }} transition={SPRING_SOFT} />
      {ticks && [25, 50, 75].map((t) => <span key={t} aria-hidden className="absolute inset-y-0 w-px bg-sheet/80" style={{ left: `${t}%` }} />)}
    </div>
  );
}
