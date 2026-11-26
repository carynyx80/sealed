"use client";
// Wallet error / info toasts (quiet: bottom-right on desktop, full-width above the safe area on phones).
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import { dismissWalletToast, useWalletToasts } from "@/lib/wallet";
import { SPRING } from "../motion/spring";
import { ArrowUpRight, XIcon } from "../ui/Icons";

export function WalletToasts() {
  const toasts = useWalletToasts();
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex flex-col items-stretch gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:inset-x-auto sm:right-6 sm:w-[22rem] sm:px-0 sm:pb-6"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={SPRING}
            role={t.tone === "error" ? "alert" : "status"}
            className={clsx("pointer-events-auto flex items-start gap-3 rounded-card border bg-sheet p-3.5 shadow-lift", t.tone === "error" ? "border-burn/30" : "border-rule")}
          >
            <span aria-hidden className={clsx("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", t.tone === "error" ? "bg-burn" : "bg-ink-muted")} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-ink">{t.title}</p>
              {t.body && <p className="mt-0.5 text-[12px] leading-relaxed text-ink-slate">{t.body}</p>}
              {t.action && (
                <a href={t.action.href} target="_blank" rel="noreferrer" className="btn-link mt-1.5 !text-[12px]">
                  {t.action.label} <ArrowUpRight width={12} height={12} />
                </a>
              )}
            </div>
            <button type="button" onClick={() => dismissWalletToast(t.id)} className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-muted hover:text-ink" aria-label="Dismiss">
              <XIcon width={13} height={13} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
