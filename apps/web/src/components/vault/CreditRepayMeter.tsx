"use client";
import clsx from "clsx";
import { motion } from "framer-motion";
import type { CreditState, QuoteAssetSymbol } from "@sealed/shared";
import { useReducedMotion } from "@/components/motion/reduced";
import { fmtAmount } from "@/lib/format";
import { RollingNumber } from "../motion/RollingNumber";
import { SPRING_SOFT } from "../motion/spring";
import { Bar } from "../ui/Bar";

/** "68.4% Repaid — Flywheel activates at 100%". `compact` renders a lobby-card mini-bar. */
export function CreditRepayMeter({ credit, quote, compact = false, className }: { credit: CreditState; quote: QuoteAssetSymbol; compact?: boolean; className?: string }) {
  const reduce = useReducedMotion();
  const fly = credit.phase === "flywheel" || credit.repaidPct >= 100;
  const pct = Math.max(0, Math.min(100, credit.repaidPct));
  if (compact) {
    return (
      <div className={clsx("space-y-1.5", className)}>
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-ink-slate">{fly ? "Credit repaid · flywheel on" : "Credit repaid"}</span>
          <RollingNumber value={pct} format="pct" className={fly ? "text-gain" : "text-ink"} />
        </div>
        <Bar pct={credit.repaidPct} height={4} label="Credit repaid" />
      </div>
    );
  }
  return (
    <section className={clsx("card p-5 sm:p-6", className)} aria-label="Credit repayment">
      <div className="flex items-baseline justify-between gap-3">
        <p className="section-mark">§ Credit · Repayment</p>
        <p className="font-mono text-[11px] text-ink-muted">{fly ? "phase 02" : "phase 01"}</p>
      </div>

      <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <RollingNumber value={pct} format="pct" className={clsx("text-[2.5rem] leading-none tracking-[-0.03em]", fly ? "text-gain" : "text-ink")} />
        <span className="font-display text-lg font-semibold tracking-[-0.02em] text-ink">Repaid</span>
      </div>
      <p className="mt-2 text-[13px] text-ink-slate">
        {fly ? (
          <>Flywheel <span className="accent text-ink">active</span>: fees now split 50 / 35 / 15, permanently.</>
        ) : (
          <>Flywheel activates at <span className="num text-ink">100%</span>.</>
        )}
      </p>

      {/* ruled meter with decile ticks and the 100% activation mark */}
      <div className="relative mt-5 pt-4">
        <span className="absolute right-0 top-0 font-mono text-[9px] uppercase tracking-[0.08em] text-ink">Flywheel</span>
        <div className="relative h-2.5 w-full bg-paper-deep" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Credit repaid">
          <motion.div
            className={clsx("h-full", fly ? "bg-gain" : "bg-ink")}
            initial={reduce ? false : { width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={SPRING_SOFT}
          />
          <span className="absolute -top-1.5 right-0 h-[22px] w-px bg-ink" aria-hidden />
        </div>
        <div className="relative mt-1 h-2" aria-hidden>
          {Array.from({ length: 11 }, (_, i) => (
            <span key={i} className={clsx("absolute top-0 w-px", i % 5 === 0 ? "h-2 bg-ink-slate" : "h-1 bg-rule-strong")} style={{ left: i === 10 ? "calc(100% - 1px)" : `${i * 10}%` }} />
          ))}
        </div>
        <div className="mt-0.5 flex justify-between font-mono text-[10px] text-ink-muted">
          <span>0</span>
          <span>50</span>
          <span>100</span>
        </div>
      </div>

      <dl className="mt-4 border-t border-rule">
        <div className="flex items-baseline justify-between gap-3 border-b border-rule py-2 text-[12px]">
          <dt className="text-ink-slate">Repaid of credit line</dt>
          <dd className="num text-ink">
            {fmtAmount(credit.repaid)} <span className="text-ink-muted">/ {fmtAmount(credit.creditLine)} {quote}</span>
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-b border-rule py-2 text-[12px]">
          <dt className="text-ink-slate">Lifetime pool fees</dt>
          <dd className="num text-ink">
            {fmtAmount(credit.feesCollected)} <span className="text-ink-muted">{quote}</span>
          </dd>
        </div>
      </dl>
      <p className="mt-3 font-mono text-[10px] leading-relaxed text-ink-muted">80% of fees repay the Credit Pool · 20% platform burn &amp; ops</p>
    </section>
  );
}
