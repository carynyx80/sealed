"use client";
// Owned by web-offchain-agent. Bottom sheet on phones, centred dialog from sm up. Portalled to <body>,
// scroll-locked, Esc / backdrop to close, focus moved in and restored, Tab trapped.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useReducedMotion } from "@/components/motion/reduced";
import { SPRING } from "../motion/spring";
import { XIcon } from "../ui/Icons";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';

export function Sheet({
  open,
  onClose,
  mark,
  title,
  children,
  locked = false,
}: {
  open: boolean;
  onClose: () => void;
  mark: string;
  title: ReactNode;
  children: ReactNode;
  /** Prevent closing (e.g. while a wallet prompt is open). */
  locked?: boolean;
}) {
  const reduce = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement as HTMLElement | null;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus() ?? panel.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !lockedRef.current) {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        items[items.length - 1]!.focus();
      } else if (!e.shiftKey && i === items.length - 1) {
        e.preventDefault();
        items[0]!.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      restore?.focus?.();
    };
  }, [open]);

  if (!mounted) return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <button type="button" tabIndex={-1} aria-label="Close" className="absolute inset-0 cursor-default bg-ink/40" onClick={() => !locked && onClose()} />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-card border border-rule bg-sheet shadow-lift outline-none sm:max-w-[30rem] sm:rounded-card"
            initial={reduce ? { opacity: 0 } : { y: 48, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { y: 36, opacity: 0 }}
            transition={SPRING}
          >
            <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-rule-strong sm:hidden" aria-hidden />
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-rule px-5 pb-4 pt-3 sm:px-6 sm:pt-6">
              <div className="min-w-0">
                <p className="section-mark">{mark}</p>
                <h2 id={titleId} className="mt-2 font-display text-display-sm text-ink sm:text-[1.6rem] sm:tracking-[-0.025em]">{title}</h2>
              </div>
              <button
                type="button"
                onClick={() => !locked && onClose()}
                disabled={locked}
                className="-mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-rule text-ink-slate transition hover:border-rule-strong hover:text-ink disabled:opacity-40"
                aria-label="Close dialog"
              >
                <XIcon width={16} height={16} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 sm:px-6 sm:pb-6">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
