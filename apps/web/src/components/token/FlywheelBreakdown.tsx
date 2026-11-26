"use client";
import clsx from "clsx";
import { motion } from "framer-motion";
import { FLYWHEEL_SPLIT, REPAY_SPLIT, type LaunchSummary } from "@sealed/shared";
import { useReducedMotion } from "@/components/motion/reduced";
import { fmtAmount } from "@/lib/format";
import { useCustodyInfo } from "@/lib/custody";

interface Slice { key: string; label: string; bps: number; fill: string; text: string }

const REPAY: Slice[] = [
  { key: "repay", label: "Credit repayment", bps: REPAY_SPLIT.creditRepayBps, fill: "bg-ink", text: "text-paper" },
  { key: "ops", label: "Platform burn & ops", bps: REPAY_SPLIT.platformBurnOpsBps, fill: "bg-burn", text: "text-white" },
];
const FLY: Slice[] = [
  { key: "holders", label: "Holder payouts", bps: FLYWHEEL_SPLIT.holderPayoutBps, fill: "bg-gain", text: "text-white" },
  { key: "burn", label: "Platform buyback & burn", bps: FLYWHEEL_SPLIT.platformBuybackBurnBps, fill: "bg-burn", text: "text-white" },
  { key: "treasury", label: "Treasury & credit pool", bps: FLYWHEEL_SPLIT.treasuryBps, fill: "bg-ink-slate", text: "text-paper" },
];

type PhaseState = "active" | "next" | "done";

/** Fee routing as a proportional ledger: Phase 1 (80/20 auto-repay) → Phase 2 (50/35/15 holder flywheel). */
export function FlywheelBreakdown({ launch }: { launch: LaunchSummary }) {
  const c = launch.credit;
  const offchain = useCustodyInfo().availability === "available";
  const q = launch.quoteAsset;
  const graduated = launch.status === "live" || launch.status === "flywheel";
  const fly = launch.status === "flywheel" || c?.phase === "flywheel";
  const amounts: Record<string, number> = c
    ? { holders: c.holderPayouts, burn: c.platformBurnQuote, treasury: c.treasury, repay: c.repaid, ops: c.platformBurnQuote }
    : {};

  const p1: PhaseState = fly ? "done" : graduated ? "active" : "next";
  const p2: PhaseState = fly ? "active" : "next";

  return (
    <div>
      <p className="max-w-xl text-[13px] leading-relaxed text-ink-slate">
        Every trade pays a <span className="num text-ink">1%</span> pool fee into the token&rsquo;s {offchain ? "fee collector account" : "Fee Collector PDA"}. It is routed in two phases, enforced by {offchain ? <>Sealed&rsquo;s ledger</> : "the program"}.
        {c && (
          <> Lifetime fees on this pool: <span className="num text-ink">{fmtAmount(c.feesCollected)}</span> <span className="font-mono text-[11px] text-ink-muted">{q}</span>.</>
        )}
      </p>
      <div className="mt-6 border-t border-ink">
        <Phase n="01" title="Auto-repay" when="Until the credit line is 100% repaid" state={p1} items={REPAY} amounts={amounts} q={q} showAmounts={!!c && p1 !== "next"} />
        <Phase n="02" title="Holder flywheel" when="Permanent, from 100% repaid" state={p2} items={FLY} amounts={amounts} q={q} showAmounts={!!c && p2 === "active"} />
      </div>
      <p className="mt-3 font-mono text-[10px] leading-relaxed text-ink-muted">
        * Wallets that bought in the graduation slot sit in the Anti-Snipe Registry and receive 0% of holder payouts.
      </p>
    </div>
  );
}

function Phase({ n, title, when, state, items, amounts, q, showAmounts }: { n: string; title: string; when: string; state: PhaseState; items: Slice[]; amounts: Record<string, number>; q: string; showAmounts: boolean }) {
  const reduce = useReducedMotion();
  const muted = state === "next";
  return (
    <section className="grid gap-x-8 gap-y-4 border-b border-rule py-5 md:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="flex items-start justify-between gap-3 md:block">
        <div>
          <p className="section-mark">Phase {n}</p>
          <h3 className={clsx("mt-1 font-display text-lg font-semibold tracking-[-0.02em]", muted ? "text-ink-slate" : "text-ink")}>{title}</h3>
        </div>
        <p className="mt-1 md:mt-2">
          <span
            className={clsx(
              "inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em]",
              state === "active" ? "text-gain" : "text-ink-muted",
            )}
          >
            <span className={clsx("h-1.5 w-1.5 rounded-full", state === "active" ? "bg-gain" : state === "done" ? "bg-ink-muted" : "border border-ink-muted")} />
            {state === "active" ? "Active" : state === "done" ? "Complete" : "Queued"}
          </span>
        </p>
      </div>

      <div className="min-w-0">
        {/* proportional bar */}
        <motion.div
          className="flex h-9 w-full gap-px"
          initial={reduce ? false : { clipPath: "inset(0 100% 0 0)" }}
          whileInView={{ clipPath: "inset(0 0% 0 0)" }}
          viewport={{ once: true }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          role="img" aria-label={`${title}: ${items.map((s) => `${s.bps / 100}% ${s.label}`).join(", ")}`}>
          {items.map((s, i) => (
            <div
              key={s.key}
              className={clsx(
                "relative flex h-full items-center overflow-hidden px-2",
                i === 0 && "rounded-l-[4px]",
                i === items.length - 1 && "rounded-r-[4px]",
                muted ? "border border-rule-strong bg-[repeating-linear-gradient(135deg,transparent_0_4px,#DEDAD1_4px_5px)]" : s.fill,
              )}
              style={{ width: `${s.bps / 100}%` }}
            >
              <span className={clsx("num text-[12px]", muted ? "text-ink-slate" : s.text)}>{s.bps / 100}%</span>
            </div>
          ))}
        </motion.div>
        {/* scale ticks 0 · 25 · 50 · 75 · 100 */}
        <div className="relative mt-1 h-3" aria-hidden>
          {[0, 25, 50, 75, 100].map((t) => (
            <span key={t} className="absolute top-0 h-1.5 w-px bg-rule-strong" style={{ left: t === 100 ? "calc(100% - 1px)" : `${t}%` }} />
          ))}
        </div>

        {/* ledger */}
        <dl className="mt-1">
          {items.map((s) => (
            <div key={s.key} className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-baseline gap-x-3 border-t border-rule py-2 text-[13px] first:border-t-0">
              <span className={clsx("h-2 w-2 translate-y-[-1px] self-center", muted ? "border border-ink-muted" : s.fill)} aria-hidden />
              <dt className={clsx("truncate", muted ? "text-ink-muted" : "text-ink-slate")}>{s.label}</dt>
              <dd className="num text-right text-ink-muted">
                {showAmounts ? (
                  <>
                    {fmtAmount(amounts[s.key] ?? 0)} <span className="text-[10px]">{q}</span>
                  </>
                ) : (
                  "—"
                )}
              </dd>
              <dd className={clsx("num w-10 text-right", muted ? "text-ink-muted" : "text-ink")}>{s.bps / 100}%</dd>
            </div>
          ))}
        </dl>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">{when}</p>
      </div>
    </section>
  );
}
