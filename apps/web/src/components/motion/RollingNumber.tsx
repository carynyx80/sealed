"use client";
import { useEffect, useRef } from "react";
import { animate } from "framer-motion";
import { useReducedMotion } from "@/components/motion/reduced";
import clsx from "clsx";
import { fmtCompact, fmtInt, fmtPct, fmtUsd, fmtAmount } from "@/lib/format";

export type RollingFormat = "usd" | "pct" | "int" | "compact" | "amount" | ((n: number) => string);

function formatter(f: RollingFormat, digits?: number): (n: number) => string {
  if (typeof f === "function") return f;
  switch (f) {
    case "usd": return (n) => fmtUsd(n);
    case "pct": return (n) => fmtPct(n, digits ?? 1);
    case "int": return (n) => fmtInt(n);
    case "compact": return (n) => fmtCompact(n, digits ?? 1);
    default: return (n) => fmtAmount(n, digits);
  }
}

/** Animated tabular counter. Text is written straight to the DOM so ticking never re-renders the tree. */
export function RollingNumber({ value, format = "amount", digits, className, prefix, suffix }: { value: number; format?: RollingFormat; digits?: number; className?: string; prefix?: string; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef<number>(value);
  const reduce = useReducedMotion();
  const fmtRef = useRef(formatter(format, digits));
  fmtRef.current = formatter(format, digits);
  // React owns only the first paint; later updates are written by the animation (avoids flashes).
  const initial = useRef<string>(fmtRef.current(value));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = prev.current;
    prev.current = value;
    if (reduce || from === value || !Number.isFinite(from)) {
      el.textContent = fmtRef.current(value);
      return;
    }
    const controls = animate(from, value, {
      type: "spring",
      stiffness: 90,
      damping: 20,
      onUpdate: (v) => {
        el.textContent = fmtRef.current(v);
      },
    });
    return () => controls.stop();
  }, [value, reduce]);

  return (
    <span className={clsx("num", className)}>
      {prefix}
      <span ref={ref}>{initial.current}</span>
      {suffix}
    </span>
  );
}
