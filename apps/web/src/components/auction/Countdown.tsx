"use client";
import { motion } from "framer-motion";
import { useReducedMotion } from "@/components/motion/reduced";
import clsx from "clsx";
import { useNow } from "@/lib/live";
import { fmtCountdown } from "@/lib/format";

/** Ticking mm:ss countdown to a unix-seconds target. Pulses in `burn` under `urgentUnder` seconds. */
export function Countdown({ to, className, urgentUnder = 30, endedLabel = "00:00" }: { to: number; className?: string; urgentUnder?: number; endedLabel?: string }) {
  const now = useNow();
  const reduce = useReducedMotion();
  const left = now === null ? null : Math.max(0, to - now);
  const urgent = left !== null && left > 0 && left < urgentUnder;
  return (
    <motion.span
      className={clsx("num inline-block transition-colors", urgent ? "text-burn" : "", className)}
      animate={urgent && !reduce ? { opacity: [1, 0.55, 1] } : { opacity: 1 }}
      transition={urgent && !reduce ? { duration: 1, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
      aria-live="off"
    >
      {left === null ? "--:--" : left === 0 ? endedLabel : fmtCountdown(left)}
    </motion.span>
  );
}

export function useSecondsLeft(to: number): number | null {
  const now = useNow();
  return now === null ? null : Math.max(0, to - now);
}
