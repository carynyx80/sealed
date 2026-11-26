"use client";
import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Horizontal-scroll affordance for tab rows and chip rails on narrow screens: fades the edge(s) that still have
 * content to scroll to, so a clipped tab reads as "more this way" rather than as a cut-off label.
 * Watches the first `[role=tablist]` (or the first child) inside; the fades are pointer-events-none overlays.
 */
export function ScrollFade({ children, className, tone = "paper" }: { children: ReactNode; className?: string; tone?: "paper" | "sheet" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const host = ref.current;
    const el = host?.querySelector<HTMLElement>('[role="tablist"]') ?? (host?.firstElementChild as HTMLElement | null);
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const left = max > 1 && el.scrollLeft > 1;
      const right = max > 1 && el.scrollLeft < max - 1;
      setEdges((p) => (p.left === left && p.right === right ? p : { left, right }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  const from = tone === "sheet" ? "from-sheet" : "from-paper";
  return (
    <div ref={ref} className={clsx("relative min-w-0 max-w-full", className)}>
      {children}
      <span aria-hidden className={clsx("pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r to-transparent transition-opacity duration-200", from, edges.left ? "opacity-100" : "opacity-0")} />
      <span aria-hidden className={clsx("pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l to-transparent transition-opacity duration-200", from, edges.right ? "opacity-100" : "opacity-0")} />
    </div>
  );
}
