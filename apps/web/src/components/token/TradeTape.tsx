"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useReducedMotion } from "@/components/motion/reduced";
import clsx from "clsx";
import type { Network, QuoteAssetSymbol, Trade } from "@sealed/shared";
import { useNow } from "@/lib/live";
import { fmtAgo, fmtAmount, fmtCompact, fmtPrice, shortAddr, solscanTx } from "@/lib/format";
import { FlameIcon } from "../ui/Icons";
import { SPRING } from "../motion/spring";

const COLS = "grid grid-cols-[4.25rem_minmax(0,1fr)_auto] gap-x-3 sm:grid-cols-[4.75rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto]";

/** Trade & programmatic-buyback tape set as a ruled ledger. Vault buy-and-burns are marked in `gain`. */
export function TradeTape({ trades, quote, ticker, network, max = 14 }: { trades: Trade[]; quote: QuoteAssetSymbol; ticker: string; network: Network; max?: number }) {
  const now = useNow();
  const reduce = useReducedMotion();
  const rows = trades.slice(0, max);
  if (!rows.length) {
    return <p className="border-y border-rule py-10 text-center font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">No trades yet</p>;
  }
  return (
    <div className="min-w-0">
      <div className={clsx(COLS, "border-b border-ink pb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted")}>
        <span>When</span>
        <span>Side · wallet</span>
        <span className="hidden text-right sm:block">Price</span>
        <span className="hidden text-right sm:block">{ticker}</span>
        <span className="text-right">{quote}</span>
      </div>
      <ul>
        <AnimatePresence initial={false}>
          {rows.map((t) => (
            <motion.li
              key={t.id}
              layout={!reduce ? "position" : false}
              initial={reduce ? false : { opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={SPRING}
              className={clsx("relative border-b border-rule", t.isBuyback && "bg-gain-tint")}
            >
              {t.isBuyback && <span className="absolute inset-y-0 left-0 w-[2px] bg-gain" aria-hidden />}
              <a
                href={solscanTx(t.signature, network)}
                target="_blank"
                rel="noreferrer"
                className={clsx(COLS, "items-baseline py-2.5 text-[12px] transition-colors hover:bg-paper-deep/60", t.isBuyback && "pl-2.5 hover:bg-gain-tint")}
                aria-label={`${t.isBuyback ? "Vault buy and burn" : t.side} ${fmtAmount(t.amountQuote)} ${quote} — view on Solscan`}
              >
                <span className="num text-ink-muted">{now === null ? "—" : fmtAgo(t.ts, now)}</span>
                {t.isBuyback ? (
                  <span className="flex min-w-0 items-center gap-1.5 text-gain">
                    <FlameIcon width={12} height={12} className="shrink-0" />
                    <span className="truncate font-medium">Vault buy &amp; burn</span>
                  </span>
                ) : (
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className={clsx("w-8 shrink-0 font-mono text-[10px] uppercase tracking-[0.06em]", t.side === "buy" ? "text-ink" : "text-burn")}>{t.side}</span>
                    <span className="num truncate text-ink-slate">{shortAddr(t.wallet)}</span>
                    {t.isSniper && <span className="hidden font-mono text-[9px] uppercase tracking-[0.06em] text-burn sm:inline" title="Bought in the graduation slot — 0% holder rewards">snipe</span>}
                  </span>
                )}
                <span className="num hidden text-right text-ink-slate sm:block">{fmtPrice(t.price)}</span>
                <span className="num hidden text-right text-ink-slate sm:block">{fmtCompact(t.amountToken, 2)}</span>
                <span className={clsx("num text-right", t.isBuyback ? "text-gain" : "text-ink")}>{fmtAmount(t.amountQuote)}</span>
              </a>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}
