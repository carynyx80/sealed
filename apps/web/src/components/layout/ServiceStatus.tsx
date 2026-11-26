"use client";
// "Service unavailable — retrying" band, shown under the nav whenever the data source is "offline" (mainnet with
// the Sealed API unreachable). Mainnet never falls back to demo data, so this is the honest state: live figures,
// launches and balances are withheld until the API answers again; nothing is simulated in the meantime.
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { nextApiRetryAt, retryApiNow } from "@/lib/api";
import { useDataSource } from "@/lib/live";
import { SPRING } from "../motion/spring";

export function ServiceStatus() {
  const source = useDataSource();
  const offline = source === "offline";
  const [secs, setSecs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!offline) return;
    const tick = () => setSecs(Math.max(0, Math.ceil((nextApiRetryAt() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [offline]);

  return (
    <AnimatePresence initial={false}>
      {offline && (
        <motion.div
          role="status"
          aria-live="polite"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={SPRING}
          className="overflow-hidden border-t border-night-rule bg-night text-night-text"
        >
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
            <span className="flex min-w-0 items-center gap-2.5">
              <span aria-hidden className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-burn-bright opacity-60 motion-reduce:hidden" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-burn-bright" />
              </span>
              <span className="text-[13px] font-semibold">Service unavailable — retrying</span>
            </span>
            <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-night-muted">
              The Sealed API isn&apos;t responding. Live launches, prices and balances are paused; nothing shown is simulated.
            </span>
            <span className="flex shrink-0 items-center gap-3">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-night-muted">
                {busy ? "checking…" : secs ? `next try ${secs}s` : "retrying…"}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await retryApiNow();
                  } finally {
                    setBusy(false);
                  }
                }}
                className="inline-flex min-h-[36px] items-center rounded-full border border-night-rule px-3 text-[12px] font-semibold text-night-text transition-colors hover:border-night-muted disabled:opacity-60"
              >
                Retry now
              </button>
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
