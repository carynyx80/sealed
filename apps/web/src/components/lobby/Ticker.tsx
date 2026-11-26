"use client";
import clsx from "clsx";
import { useNow } from "@/lib/live";
import { fmtCountdown } from "@/lib/format";

/** Ticking mono countdown for lobby surfaces. Turns `burn` under `urgentUnder` seconds. */
export function LobbyCountdown({ to, className, urgentUnder = 30, endedLabel = "00:00" }: { to: number; className?: string; urgentUnder?: number; endedLabel?: string }) {
  const now = useNow();
  const left = now === null ? null : Math.max(0, to - now);
  const urgent = left !== null && left > 0 && left < urgentUnder;
  const text = left === null ? "--:--" : left === 0 ? endedLabel : fmtCountdown(left);
  return (
    <span className={clsx("num inline-block whitespace-nowrap transition-colors duration-300", urgent ? "text-burn" : "", className)} aria-label={`${text} remaining`}>
      {text}
    </span>
  );
}

/** 0–1 fraction of a window elapsed; null before mount. */
export function useElapsed(start: number, end: number): number | null {
  const now = useNow();
  if (now === null || end <= start) return null;
  return Math.max(0, Math.min(1, (now - start) / (end - start)));
}

/** Deterministic 32-bit FNV-1a hash — used to draw stable, purely illustrative redaction widths & hashes. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function fakeHex(seed: string, len = 8): string {
  let out = "";
  let i = 0;
  while (out.length < len) out += hash32(`${seed}:${i++}`).toString(16).padStart(8, "0");
  return out.slice(0, len);
}
