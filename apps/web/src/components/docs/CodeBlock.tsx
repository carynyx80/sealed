"use client";
/**
 * Code block with a copy button. Long lines scroll inside the box (never the page): the figure is `min-w-0`
 * and the <pre> owns `overflow-x-auto`.
 */
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { scrollShade } from "./scrollShade";

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CodeBlock({ code, lang = "text", title, className }: { code: string; lang?: string; title?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const text = code.replace(/^\n+|\s+$/g, "");

  const onCopy = async () => {
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1600);
  };

  return (
    <figure className={clsx("mt-5 min-w-0 overflow-hidden rounded-card border border-rule bg-sheet", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-rule bg-paper-deep/60 py-1.5 pl-4 pr-1.5">
        <span className="eyebrow min-w-0 truncate">{title ?? lang}</span>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex min-h-[40px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-full px-3 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-slate transition hover:bg-sheet hover:text-ink"
          aria-label={title ? `Copy ${title}` : "Copy code"}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
            {state === "copied" ? <path d="m5 12 5 5 9-10" /> : (
              <>
                <rect x="8" y="8" width="12" height="12" rx="2" />
                <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
              </>
            )}
          </svg>
          <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
        </button>
      </div>
      <pre
        className="max-w-full overflow-x-auto overscroll-x-contain px-4 py-3.5 font-mono text-[12.5px] leading-[1.7] text-ink [scrollbar-width:thin] [tab-size:2]"
        style={scrollShade()}
        tabIndex={0}
      >
        <code>{text}</code>
      </pre>
    </figure>
  );
}
