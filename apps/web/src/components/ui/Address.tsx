"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

/**
 * A long mono value (address, signature, hash) that fits any width: it shows in full when there is room and
 * otherwise truncates in the MIDDLE (head… tail), so both ends stay recognisable. The full value is in the
 * tooltip, and the optional copy button copies it. Pure CSS truncation, so no layout shift and no measuring.
 */
export function Address({
  value,
  href,
  tail = 6,
  copy = false,
  className,
  label = "address",
}: {
  value: string;
  href?: string;
  /** Characters always kept at the end. */
  tail?: number;
  copy?: boolean;
  className?: string;
  /** Used in the copy button's accessible name. */
  label?: string;
}) {
  const head = value.length > tail ? value.slice(0, -tail) : value;
  const end = value.length > tail ? value.slice(-tail) : "";
  const text = (
    <span className="flex min-w-0">
      <span className="truncate">{head}</span>
      <span className="shrink-0">{end}</span>
    </span>
  );
  return (
    <span className={clsx("num inline-flex min-w-0 max-w-full items-center gap-1", className)} title={value}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="flex min-w-0 underline decoration-rule-strong underline-offset-2 transition-colors hover:decoration-ink">
          {text}
        </a>
      ) : (
        text
      )}
      {copy && <CopyButton value={value} label={label} />}
    </span>
  );
}

/** Small copy control with a 44px touch target that doesn't change the line height. */
export function CopyButton({ value, label = "value", className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setDone(true);
    clearTimeout(t.current);
    t.current = setTimeout(() => setDone(false), 1400);
  };
  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      aria-label={done ? `Copied ${label}` : `Copy ${label}`}
      className={clsx(
        "relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-muted transition-colors hover:text-ink before:absolute before:-inset-3 before:content-['']",
        done && "text-gain hover:text-gain",
        className,
      )}
    >
      {done ? (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden><path d="M2 6.5 4.8 9 10 3" stroke="currentColor" strokeWidth="1.25" /></svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden><rect x="3.5" y="3.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.25" /><path d="M8.5 2.5V2a.5.5 0 0 0-.5-.5H2a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 .5.5h.5" stroke="currentColor" strokeWidth="1.25" /></svg>
      )}
      <span className="sr-only" aria-live="polite">{done ? "Copied" : ""}</span>
    </button>
  );
}
