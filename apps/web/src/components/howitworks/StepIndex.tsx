"use client";
import clsx from "clsx";
import { useEffect, useState } from "react";

/** Sticky desktop contents for the ten steps; highlights the step currently in view. */
export function StepIndex({ items }: { items: { id: string; n: string; label: string }[] }) {
  const [active, setActive] = useState(items[0]?.id ?? "");

  useEffect(() => {
    const els = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => !!e);
    if (!els.length || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id);
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [items]);

  return (
    <nav aria-label="Steps" className="sticky top-24 pt-14">
      <p className="eyebrow border-b border-ink pb-2.5">Contents</p>
      <ol className="mt-1">
        {items.map((i) => {
          const on = i.id === active;
          return (
            <li key={i.id}>
              <a
                href={`#${i.id}`}
                aria-current={on ? "step" : undefined}
                className={clsx(
                  "flex items-baseline gap-3 border-b border-rule py-2 text-[13px] transition-colors",
                  on ? "text-ink" : "text-ink-muted hover:text-ink",
                )}
              >
                <span className={clsx("num w-5 shrink-0 text-[11px]", on && "text-signal")}>{i.n}</span>
                <span className={clsx(on && "font-semibold")}>{i.label}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
