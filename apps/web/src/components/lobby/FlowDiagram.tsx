"use client";
import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { useReducedMotion } from "@/components/motion/reduced";
import { SPRING } from "../motion/spring";

/* ---------- small printed figures, one per step (1px strokes, mono labels) ---------- */

function FigSealed() {
  const bars = [62, 88, 40, 104, 74, 52];
  return (
    <svg viewBox="0 0 260 96" className="h-auto w-full" aria-hidden>
      {bars.map((w, i) => {
        const y = 8 + i * 15;
        return (
          <g key={i}>
            <rect x="0" y={y} width={w} height="7" rx="1" className="fill-ink" />
            <path d={`M${w + 4} ${y + 3.5} C ${w + 60} ${y + 3.5}, 150 48, 182 48`} className="stroke-rule-strong" strokeWidth="1" fill="none" />
          </g>
        );
      })}
      <circle cx="186" cy="48" r="4" className="fill-signal" />
      <path d="M190 48 H260" className="stroke-signal" strokeWidth="1" strokeDasharray="3 3" />
      <text x="258" y="40" textAnchor="end" className="fill-signal font-mono text-[9px] uppercase tracking-[0.08em]">p* uniform</text>
    </svg>
  );
}

function FigCredit() {
  // vault balance stepping down with each drip; ticks mark drips
  const steps = 9;
  const w = 260 / steps;
  let d = "M0 14";
  for (let i = 0; i < steps; i++) {
    const y = 14 + (i + 1) * 7;
    d += ` H${(i + 1) * w} V${y}`;
  }
  return (
    <svg viewBox="0 0 260 96" className="h-auto w-full" aria-hidden>
      <path d="M0 86 H260" className="stroke-rule-strong" strokeWidth="1" />
      {Array.from({ length: steps + 1 }, (_, i) => (
        <path key={i} d={`M${i * w} 82 V90`} className="stroke-ink-muted" strokeWidth="1" />
      ))}
      <path d={d} className="stroke-ink" strokeWidth="1.25" fill="none" />
      {Array.from({ length: steps }, (_, i) => (
        <circle key={i} cx={(i + 1) * w} cy={14 + (i + 1) * 7} r="2.2" className="fill-burn" />
      ))}
      <text x="0" y="8" className="fill-ink-muted font-mono text-[9px] uppercase tracking-[0.08em]">vault</text>
      <text x="260" y="78" textAnchor="end" className="fill-ink-muted font-mono text-[9px] uppercase tracking-[0.08em]">drip / 2 to 5 min</text>
    </svg>
  );
}

function FigFlywheel() {
  return (
    <svg viewBox="0 0 260 96" className="h-auto w-full" aria-hidden>
      <text x="0" y="10" className="fill-ink-muted font-mono text-[9px] uppercase tracking-[0.08em]">until repaid</text>
      <rect x="0" y="16" width="208" height="14" className="fill-ink" />
      <rect x="208" y="16" width="52" height="14" className="fill-paper-deep stroke-rule-strong" strokeWidth="1" />
      <text x="6" y="26" className="fill-paper font-mono text-[9px]">80 REPAY</text>
      <text x="214" y="26" className="fill-ink-slate font-mono text-[9px]">20</text>
      <text x="0" y="56" className="fill-ink-muted font-mono text-[9px] uppercase tracking-[0.08em]">then, forever</text>
      <rect x="0" y="62" width="130" height="14" className="fill-gain" />
      <rect x="130" y="62" width="91" height="14" className="fill-ink" />
      <rect x="221" y="62" width="39" height="14" className="fill-paper-deep stroke-rule-strong" strokeWidth="1" />
      <text x="6" y="72" className="fill-sheet font-mono text-[9px]">50 HOLDERS</text>
      <text x="136" y="72" className="fill-paper font-mono text-[9px]">35 BURN</text>
      <text x="226" y="72" className="fill-ink-slate font-mono text-[9px]">15</text>
      <path d="M0 88 H260" className="stroke-rule" strokeWidth="1" />
    </svg>
  );
}

interface Step {
  n: string;
  phase: string;
  title: string;
  body: string;
  fig: ReactNode;
  spec: [string, string][];
}

const STEPS: Step[] = [
  {
    n: "01",
    phase: "Commit · Reveal",
    title: "Sealed bid",
    body: "Bidders escrow collateral and post only a hash. Nobody sees prices or sizes, so there is nothing to snipe or copy. An optional relayer reveals for you the second the window opens.",
    fig: <FigSealed />,
    spec: [
      ["Commitment", "keccak256(bidder, px, amt, salt)"],
      ["Window", "15 to 30 min, then 2 min reveal"],
      ["Settlement", "Uniform clearing price"],
    ],
  },
  {
    n: "02",
    phase: "Graduation",
    title: "Instant buyback credit",
    body: "Because demand is known at minute zero, the Credit Pool advances a capped line into a locked vault. It buys and burns in steady drips from the first public trade. No one can withdraw it.",
    fig: <FigCredit />,
    spec: [
      ["Credit line", "10 to 15% of raise"],
      ["Drips", "Every 2 to 5 min via Jupiter"],
      ["Withdrawals", "None, by construction"],
    ],
  },
  {
    n: "03",
    phase: "Fees",
    title: "Auto-repay flywheel",
    body: "Trading fees repay the credit first. At 100% the split flips for good, paying holders in the quote asset (SOL, USDC or a tokenized stock) while the rest burns. Graduation-slot snipers earn nothing.",
    fig: <FigFlywheel />,
    spec: [
      ["Repay phase", "80% of fees, ~72h"],
      ["Flywheel", "50 / 35 / 15"],
      ["Anti-snipe", "Same-slot buyers → 0%"],
    ],
  },
];

/** The three-step loop as a broadsheet sequence: giant numerals, ruled columns, printed figures, and a return line. */
export function FlowDiagram() {
  const reduce = useReducedMotion();
  return (
    <div>
      <ol className="grid grid-cols-1 border-t border-ink md:grid-cols-3">
        {STEPS.map((s, i) => (
          <motion.li
            key={s.n}
            className={`relative flex min-w-0 flex-col border-b border-rule py-8 md:border-b-0 md:py-10 ${i > 0 ? "md:border-l md:pl-8" : ""} ${i < 2 ? "md:pr-8" : ""}`}
            initial={reduce ? false : { opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ ...SPRING, delay: i * 0.1 }}
          >
            <div className="flex items-start justify-between gap-4">
              <span className="numeral text-[88px] leading-[0.8] text-ink sm:text-[112px]">{s.n}</span>
              <span className="section-mark pt-1 text-right">{s.phase}</span>
            </div>
            {i < 2 && (
              <span aria-hidden className="absolute -right-[13px] top-12 z-10 hidden h-[26px] w-[26px] items-center justify-center rounded-full border border-ink bg-paper font-mono text-xs md:flex">→</span>
            )}
            <h3 className="mt-8 text-display-sm text-ink">{s.title}</h3>
            <p className="mt-3 text-[15px] leading-relaxed text-ink-slate">{s.body}</p>
            <div className="mt-7">{s.fig}</div>
            <dl className="mt-6 border-t border-rule">
              {s.spec.map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-4 border-b border-rule py-2">
                  <dt className="eyebrow shrink-0">{k}</dt>
                  <dd className="num min-w-0 text-balance text-right text-[12px] leading-snug text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          </motion.li>
        ))}
      </ol>

      {/* return line: repaid credit funds the next launch */}
      <div className="mt-2 flex items-center gap-3 text-ink-slate md:mt-0">
        <svg viewBox="0 0 1000 40" preserveAspectRatio="none" className="hidden h-10 w-full md:block" aria-hidden>
          <motion.path
            d="M985 0 V20 H15 V0"
            fill="none"
            className="stroke-ink"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            initial={reduce ? false : { opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 1.6, ease: [0.22, 1, 0.36, 1] }}
          />
        </svg>
      </div>
      <p className="flex flex-wrap items-baseline gap-x-3 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-slate md:-mt-1 md:justify-center">
        <span aria-hidden className="text-ink">↺</span>
        Repaid credit returns to the Credit Pool and funds the next launch&apos;s buyback
      </p>
    </div>
  );
}
