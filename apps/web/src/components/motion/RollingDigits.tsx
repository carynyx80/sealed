"use client";
import clsx from "clsx";
import { fmtCompact, fmtInt, fmtPct, fmtUsd, fmtAmount } from "@/lib/format";
import type { RollingFormat } from "./RollingNumber";

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

const STRIP = "0123456789";

/**
 * Odometer-style numerals: each digit is a vertical 0–9 strip that rolls to its new position
 * (CSS transform, so it costs nothing per frame and renders identically on the server).
 * Digits are keyed from the right, so units stay put when the number grows a place.
 */
export function RollingDigits({ value, format = "amount", digits, className }: { value: number; format?: RollingFormat; digits?: number; className?: string }) {
  const text = formatter(format, digits)(value);
  const chars = text.split("");
  return (
    <span className={clsx("num inline-flex items-start align-[-0.12em] leading-none", className)} aria-label={text} role="text">
      {chars.map((c, i) => {
        const key = chars.length - i;
        const d = STRIP.indexOf(c);
        if (d < 0) return <span key={`s${key}`} aria-hidden className="inline-block h-[1.1em] leading-[1.1em]">{c}</span>;
        return (
          <span key={`d${key}`} aria-hidden className="relative inline-block h-[1.1em] overflow-hidden" style={{ width: "1ch" }}>
            <span className="absolute left-0 top-0 flex flex-col transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none" style={{ transform: `translateY(-${d * 10}%)` }}>
              {STRIP.split("").map((n) => <span key={n} className="block h-[1.1em] leading-[1.1em]">{n}</span>)}
            </span>
          </span>
        );
      })}
    </span>
  );
}
