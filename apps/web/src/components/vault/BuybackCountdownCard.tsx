"use client";
import { motion } from "framer-motion";
import { useReducedMotion } from "@/components/motion/reduced";
import clsx from "clsx";
import type { LaunchSummary } from "@sealed/shared";
import { useNow } from "@/lib/live";
import { fmtAmount, fmtCountdown, fmtCompact } from "@/lib/format";
import { useCustodyInfo } from "@/lib/custody";
import { RollingNumber } from "../motion/RollingNumber";
import { SPRING } from "../motion/spring";

const TICKS = 60;

/** Night band: "Next programmatic buy in 01:42 · 4.20 SOL", an interval ring with minute ticks, drip n/N and vault balance. */
export function BuybackCountdownCard({ launch }: { launch: LaunchSummary }) {
  const now = useNow();
  const reduce = useReducedMotion();
  const v = launch.vault;
  const q = launch.quoteAsset;
  const offchain = useCustodyInfo().availability === "available";
  if (!v) return null;
  const exhausted = v.nextDripTs === 0 || v.balance <= 0;
  const left = now === null || exhausted ? null : Math.max(0, v.nextDripTs - now);
  const urgent = left !== null && left < 30;
  const progress = exhausted ? 1 : left === null ? 0 : Math.min(1, Math.max(0, 1 - left / Math.max(1, v.dripIntervalSec)));
  const nextAmt = Math.min(v.dripAmount, v.balance);
  const remainingPct = (v.balance / Math.max(1e-9, v.creditLine)) * 100;
  const R = 46;
  const C = 2 * Math.PI * R;
  const lit = Math.round(progress * TICKS);

  return (
    <section className="card-night relative overflow-hidden p-5 sm:p-6" aria-label="Buyback vault">
      <div className="flex items-baseline justify-between gap-3">
        <p className="section-mark text-night-muted">§ Vault · Programmatic buyback</p>
        <p className="num text-[11px] text-night-muted">
          drip <span className="text-night-text">{v.dripsExecuted}</span>/{v.dripsTotal}
        </p>
      </div>

      <div className="mt-5 flex items-center justify-between gap-4">
        <div className="min-w-0">
          {exhausted ? (
            <>
              <p className="text-[13px] text-night-muted">Vault fully deployed</p>
              <p className="mt-2 font-display text-display-sm text-night-text">
                Fees now drive the <span className="accent">flywheel.</span>
              </p>
            </>
          ) : (
            <>
              <p className="text-[13px] text-night-muted">Next programmatic buy in</p>
              <motion.p
                className={clsx("num mt-1 text-[2.75rem] leading-none tracking-[-0.03em] sm:text-[3.25rem]", urgent ? "text-burn" : "text-night-text")}
                animate={urgent && !reduce ? { opacity: [1, 0.55, 1] } : { opacity: 1 }}
                transition={urgent && !reduce ? { duration: 1, repeat: Infinity } : { duration: 0.2 }}
                aria-live="off"
              >
                {left === null ? "--:--" : fmtCountdown(left)}
              </motion.p>
              <p className="mt-2 font-mono text-[13px] text-night-text">
                <span className="text-night-muted">·</span> {fmtAmount(nextAmt)} <span className="text-[11px] text-night-muted">{q}</span>
                <span className="ml-2 text-[11px] text-night-muted">→ burn {launch.ticker}</span>
              </p>
            </>
          )}
        </div>

        <div className="relative h-[104px] w-[104px] shrink-0" aria-hidden>
          <svg viewBox="0 0 120 120" className="h-full w-full">
            {Array.from({ length: TICKS }, (_, i) => {
              const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
              const major = i % 5 === 0;
              const r1 = major ? 52 : 54, r2 = 58;
              return (
                <line
                  key={i}
                  x1={60 + Math.cos(a) * r1}
                  y1={60 + Math.sin(a) * r1}
                  x2={60 + Math.cos(a) * r2}
                  y2={60 + Math.sin(a) * r2}
                  stroke={i < lit ? (urgent ? "#D7263D" : "#EDEBE4") : "#2E2D29"}
                  strokeWidth="1"
                />
              );
            })}
            <circle cx="60" cy="60" r={R} fill="none" stroke="#2E2D29" strokeWidth="1" />
            <motion.circle
              cx="60"
              cy="60"
              r={R}
              fill="none"
              strokeWidth="2"
              stroke={urgent ? "#D7263D" : "#0A7D52"}
              strokeDasharray={C}
              transform="rotate(-90 60 60)"
              initial={false}
              animate={{ strokeDashoffset: C * (1 - progress) }}
              transition={reduce ? { duration: 0 } : SPRING}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="num text-xl leading-none text-night-text">{v.dripsExecuted}</span>
            <span className="num mt-1 text-[10px] text-night-muted">of {fmtCompact(v.dripsTotal, 1)}</span>
          </div>
        </div>
      </div>

      <div className="mt-6 border-t border-night-rule pt-4">
        <div className="flex items-baseline justify-between gap-3 text-[12px]">
          <span className="text-night-muted">Buyback credit remaining</span>
          <span className="font-mono">
            <RollingNumber value={v.balance} className="text-night-text" /> <span className="text-night-muted">/ {fmtAmount(v.creditLine)} {q}</span>
          </span>
        </div>
        <div className="mt-2 h-[3px] w-full bg-night-rule" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remainingPct)} aria-label="Buyback credit remaining">
          <motion.div className="h-full bg-night-text" initial={false} animate={{ width: `${Math.min(100, remainingPct)}%` }} transition={SPRING} />
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-night-rule pt-3">
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-night-muted">Burned</dt>
            <dd className="num mt-1 text-[13px] text-night-text">{fmtCompact(v.tokensBurned, 2)}</dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-night-muted">Spent</dt>
            <dd className="num mt-1 text-[13px] text-night-text">{fmtAmount(v.quoteSpent)}</dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-night-muted">Cadence</dt>
            <dd className="num mt-1 text-[13px] text-night-text">{Math.max(1, Math.round(v.dripIntervalSec / 60))}m</dd>
          </div>
        </dl>
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-night-muted">
        {offchain
          ? <>Non-withdrawable. Sealed&rsquo;s ledger permits swap-to-burn only; the creator cannot move vault funds to a wallet.</>
          : <>Non-withdrawable. The program permits swap-to-burn only; neither the creator nor any admin can move vault funds to a wallet.</>}
      </p>
    </section>
  );
}
