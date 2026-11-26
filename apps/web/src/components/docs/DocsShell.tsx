"use client";
/**
 * Docs chrome: left sidebar (lg+), a sticky "§ section" bar that opens a nav sheet (< lg), an on-page table of
 * contents (xl+) built from the article's H2/H3 ids, and prev/next links. Page content stays server-rendered.
 */
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SPRING } from "@/components/motion/spring";
import { DOC_GROUPS, docByHref, neighbours } from "./nav";

function normalise(path: string | null): string {
  return (path ?? "/docs").replace(/\/$/, "") || "/docs";
}

/* ---------------------------------------------------------------- sidebar list */

function NavList({ path, onNavigate }: { path: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Documentation" className="space-y-7">
      {DOC_GROUPS.map((g) => (
        <div key={g.label}>
          <p className="eyebrow mb-2">{g.label}</p>
          <ul className="border-t border-rule">
            {g.pages.map((p) => {
              const active = p.href === path;
              return (
                <li key={p.href}>
                  <Link
                    href={p.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={clsx(
                      "group relative flex min-h-[40px] items-center gap-3 border-b border-rule py-2 pr-2 text-[14px] transition-colors",
                      active ? "font-semibold text-ink" : "text-ink-slate hover:text-ink",
                    )}
                  >
                    <span className={clsx("num w-6 shrink-0 text-[10.5px]", active ? "text-ink" : "text-ink-muted")}>{p.n}</span>
                    <span className="min-w-0">{p.title}</span>
                    {active && <span className="absolute -left-px bottom-[-1px] top-[-1px] w-[2px] bg-ink" aria-hidden />}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/* ---------------------------------------------------------------- mobile sheet */

function MobileNav({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const current = docByHref(path);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    setOpen(false);
  }, [path]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => closeBtn.current?.focus(), 30);
    const btn = trigger.current;
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
      btn?.focus();
    };
  }, [open]);

  return (
    <div className="sticky top-16 z-30 -mx-4 border-b border-rule bg-paper px-4 sm:-mx-6 sm:px-6 lg:hidden">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls="docs-sheet"
        className="flex min-h-[48px] w-full items-center gap-3 text-left"
      >
        <span className="eyebrow shrink-0">Docs</span>
        <span className="h-4 w-px shrink-0 bg-rule" aria-hidden />
        <span className="num shrink-0 text-[11px] text-ink-muted">§ {current?.n ?? "00"}</span>
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{current?.title ?? "Overview"}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" className="shrink-0 text-ink-slate" aria-hidden>
          <path d="M4 7h16M4 12h16M4 17h10" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div className="fixed inset-0 z-50" initial={{ opacity: 1 }} exit={{ opacity: 1 }}>
            <motion.button
              type="button"
              aria-label="Close documentation menu"
              tabIndex={-1}
              onClick={close}
              className="absolute inset-0 h-full w-full cursor-default bg-ink/30"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            />
            <motion.div
              id="docs-sheet"
              role="dialog"
              aria-modal="true"
              aria-label="Documentation sections"
              className="absolute bottom-0 left-0 top-0 flex w-[86vw] max-w-[22rem] flex-col border-r border-rule bg-paper"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={SPRING}
            >
              <div className="flex h-16 shrink-0 items-center justify-between border-b border-rule px-4">
                <p className="section-mark">§ Documentation</p>
                <button
                  ref={closeBtn}
                  type="button"
                  onClick={close}
                  className="flex h-11 w-11 items-center justify-center rounded-full border border-rule bg-sheet text-ink"
                  aria-label="Close"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden>
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-4 pb-10 pt-5">
                <NavList path={path} onNavigate={close} />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------------------------------------------------------------- table of contents */

interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

function Toc({ path }: { path: string }) {
  const [items, setItems] = useState<TocItem[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    let obs: IntersectionObserver | null = null;
    const raf = requestAnimationFrame(() => {
      const root = document.querySelector("[data-doc-article]");
      if (!root) return;
      const hs = Array.from(root.querySelectorAll<HTMLElement>("h2[data-toc][id], h3[data-toc][id]"));
      setItems(hs.map((h) => ({ id: h.id, text: h.textContent?.replace(/^§\s*[\d.]+\s*/, "").trim() ?? h.id, level: h.dataset.toc === "3" ? 3 : 2 })));
      setActive(hs[0]?.id ?? null);
      obs = new IntersectionObserver(
        (entries) => {
          const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          if (vis[0]) setActive((vis[0].target as HTMLElement).id);
        },
        { rootMargin: "-72px 0px -65% 0px", threshold: 0 },
      );
      hs.forEach((h) => obs!.observe(h));
    });
    return () => {
      cancelAnimationFrame(raf);
      obs?.disconnect();
    };
  }, [path]);

  if (!items.length) return null;
  return (
    <nav aria-label="On this page">
      <p className="eyebrow mb-2">On this page</p>
      <ul className="border-l border-rule">
        {items.map((it) => (
          <li key={it.id}>
            <a
              href={`#${it.id}`}
              className={clsx(
                "-ml-px block border-l py-1 text-[12.5px] leading-snug transition-colors",
                it.level === 3 ? "pl-6" : "pl-3",
                active === it.id ? "border-ink font-medium text-ink" : "border-transparent text-ink-slate hover:text-ink",
              )}
            >
              {it.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* ---------------------------------------------------------------- prev / next */

function PrevNext({ path }: { path: string }) {
  const { prev, next } = neighbours(path);
  if (!prev && !next) return null;
  return (
    <nav aria-label="Previous and next" className="mt-16 grid gap-3 border-t border-ink pt-6 sm:grid-cols-2">
      {prev ? (
        <Link href={prev.href} className="group min-w-0 rounded-card border border-rule bg-sheet p-4 transition hover:border-rule-strong">
          <span className="eyebrow">← Previous · § {prev.n}</span>
          <span className="mt-1.5 block text-[15px] font-semibold text-ink">{prev.title}</span>
        </Link>
      ) : (
        <span className="hidden sm:block" />
      )}
      {next && (
        <Link href={next.href} className="group min-w-0 rounded-card border border-rule bg-sheet p-4 text-right transition hover:border-rule-strong">
          <span className="eyebrow">Next · § {next.n} →</span>
          <span className="mt-1.5 block text-[15px] font-semibold text-ink">{next.title}</span>
        </Link>
      )}
    </nav>
  );
}

/* ---------------------------------------------------------------- shell */

export function DocsShell({ children }: { children: ReactNode }) {
  const path = normalise(usePathname());
  return (
    <div className="pb-20">
      <MobileNav path={path} />
      <div className="grid gap-10 lg:grid-cols-[13.5rem_minmax(0,1fr)] xl:grid-cols-[13.5rem_minmax(0,1fr)_12rem]">
        <aside className="hidden lg:block">
          <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto pb-10 pr-2 pt-10">
            <NavList path={path} />
          </div>
        </aside>
        <div className="min-w-0 pt-8 lg:pt-10">
          <article data-doc-article className="min-w-0 max-w-[46rem]">
            {children}
          </article>
          <div className="max-w-[46rem]">
            <PrevNext path={path} />
          </div>
        </div>
        <aside className="hidden xl:block">
          <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto pb-10 pt-10">
            <Toc path={path} />
          </div>
        </aside>
      </div>
    </div>
  );
}
