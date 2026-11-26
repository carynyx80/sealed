/**
 * Docs diagrams. Inline SVG with 1.25px hairlines and currentColor, or ruled HTML where text must reflow on a
 * 375px screen. SVG viewBoxes are kept narrow (≤ 360 units) so labels stay legible at phone width.
 * All numbers come from @sealed/shared, never hard-coded.
 */
import clsx from "clsx";
import { BPS_DENOMINATOR, FLYWHEEL_SPLIT, REPAY_SPLIT, type ClearingResult } from "@sealed/shared";

const pct = (bps: number) => `${(bps / BPS_DENOMINATOR) * 100}%`;
const pctNum = (bps: number) => (bps / BPS_DENOMINATOR) * 100;

/* ---------------------------------------------------------------- capital loop */

/** Where the credit capital travels: Credit Pool → vault → burns; fees → repay → Credit Pool → next launch. */
export function CapitalLoop() {
  const box = "fill-[#FCFBF8] stroke-[#0F0F0D]";
  const t = "fill-[#0F0F0D] font-sans text-[length:calc(11.5px*var(--k,1))] font-semibold";
  const s = "fill-[#5C5A54] font-mono text-[length:calc(9px*var(--k,1))] uppercase tracking-[0.06em]";
  return (
    <svg viewBox="0 0 360 300" className="mx-auto h-auto w-full max-w-[460px] [--k:1.2] sm:[--k:1]" role="img" aria-labelledby="loop-t loop-d">
      <title id="loop-t">The Sealed capital loop</title>
      <desc id="loop-d">
        The protocol credit pool advances credit into the launch buyback vault. The vault buys and burns through the pool. Trading fees collect in
        the fee collector and repay the credit pool, which funds the next launch.
      </desc>
      <defs>
        <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 8 4 0 8" fill="none" stroke="#0F0F0D" strokeWidth="1.25" />
        </marker>
      </defs>
      {/* dashed seal ring in the middle */}
      <circle cx="180" cy="150" r="46" fill="none" stroke="#C9C4B8" strokeWidth="1.25" strokeDasharray="2.2 3" />
      <circle cx="180" cy="150" r="5" fill="#0F0F0D" />
      <text x="180" y="212" textAnchor="middle" className={s}>
        one launch
      </text>

      {/* nodes */}
      <g>
        <rect x="8" y="16" width="150" height="54" rx="10" className={box} strokeWidth="1.25" />
        <text x="20" y="38" className={t}>Protocol Credit Pool</text>
        <text x="20" y="56" className={s}>credit_pool · quote</text>

        <rect x="202" y="16" width="150" height="54" rx="10" className={box} strokeWidth="1.25" />
        <text x="214" y="38" className={t}>Buyback vault</text>
        <text x="214" y="56" className={s}>non-withdrawable</text>

        <rect x="202" y="230" width="150" height="54" rx="10" className={box} strokeWidth="1.25" />
        <text x="214" y="252" className={t}>Locked pool</text>
        <text x="214" y="270" className={s}>1% fee · tokens burned</text>

        <rect x="8" y="230" width="150" height="54" rx="10" className={box} strokeWidth="1.25" />
        <text x="20" y="252" className={t}>Fee collector</text>
        <text x="20" y="270" className={s}>split by splitFees</text>
      </g>

      {/* edges */}
      <path d="M160 43 H198" stroke="#0F0F0D" strokeWidth="1.25" markerEnd="url(#arr)" />
      <text x="179" y="36" textAnchor="middle" className={s}>advance</text>
      <path d="M277 72 V226" stroke="#0F0F0D" strokeWidth="1.25" markerEnd="url(#arr)" />
      <text x="286" y="150" className={s}>drip</text>
      <path d="M200 257 H162" stroke="#0F0F0D" strokeWidth="1.25" markerEnd="url(#arr)" />
      <text x="181" y="250" textAnchor="middle" className={s}>fees</text>
      <path d="M83 228 V74" stroke="#0F0F0D" strokeWidth="1.25" markerEnd="url(#arr)" />
      <text x="74" y="150" textAnchor="end" className={s}>repay</text>
      <text x="74" y="162" textAnchor="end" className={s}>{pct(REPAY_SPLIT.creditRepayBps)}</text>
    </svg>
  );
}

/* ---------------------------------------------------------------- phases */

export function PhaseTrack({ phases }: { phases: Array<{ n: string; title: string; body: string; facts: string[] }> }) {
  return (
    <ol className="mt-6 grid border-t border-ink md:grid-cols-4">
      {phases.map((p, i) => (
        <li key={p.n} className={clsx("min-w-0 border-b border-rule py-5 md:pr-4", i > 0 && "md:border-l md:pl-4")}>
          <p className="numeral text-[2.75rem] leading-none text-ink">{p.n}</p>
          <p className="mt-3 text-[15px] font-semibold text-ink">{p.title}</p>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-slate">{p.body}</p>
          <ul className="mt-3 space-y-1">
            {p.facts.map((f) => (
              <li key={f} className="num text-[11.5px] text-ink-soft">
                {f}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

/* ---------------------------------------------------------------- preimage */

export function PreimageLayout() {
  const segs = [
    { name: "bidder", bytes: 32, from: 0, note: "Ed25519 pubkey" },
    { name: "max_price", bytes: 8, from: 32, note: "u64 LE · tick price" },
    { name: "bid_amount", bytes: 8, from: 40, note: "u64 LE · quote atoms" },
    { name: "salt", bytes: 32, from: 48, note: "32 random bytes" },
  ];
  return (
    <div>
      <div className="flex h-11 w-full overflow-hidden rounded-field border border-ink" role="img" aria-label="80-byte preimage: 32-byte bidder, 8-byte max_price, 8-byte bid_amount, 32-byte salt">
        {segs.map((s, i) => (
          <div
            key={s.name}
            style={{ width: `${(s.bytes / 80) * 100}%` }}
            className={clsx("flex min-w-0 items-center justify-center font-mono text-[10px] text-ink", i > 0 && "border-l border-ink", s.name === "salt" ? "redact-soft-bg" : "", i % 2 ? "bg-paper-deep" : "bg-sheet")}
          >
            <span className="truncate px-1">{s.bytes}</span>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-muted">
        <span>0</span>
        <span>80 bytes →</span>
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {segs.map((s) => (
          <div key={s.name} className="flex min-w-0 items-baseline gap-3 border-b border-rule pb-2">
            <dt className="num w-16 shrink-0 text-[11px] text-ink-muted">
              {s.from} to {s.from + s.bytes - 1}
            </dt>
            <dd className="min-w-0 text-[13px] text-ink-soft">
              <span className="font-mono text-ink">{s.name}</span> · {s.note}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ---------------------------------------------------------------- tick histogram */

export function TickHistogram({
  floor,
  tick,
  buckets,
  result,
  shownTicks = 8,
  unitLabel,
}: {
  floor: bigint;
  tick: bigint;
  buckets: bigint[];
  result: ClearingResult;
  shownTicks?: number;
  unitLabel: string;
}) {
  const W = 360;
  const H = 210;
  const left = 34;
  const bottom = 172;
  const top = 22;
  const colW = (W - left - 8) / shownTicks;
  const max = buckets.slice(0, shownTicks).reduce((a, b) => (b > a ? b : a), 1n);
  const h = (v: bigint) => (Number(v) / Number(max)) * (bottom - top);
  const priceOf = (i: number) => floor + tick * BigInt(i);
  const fillFrac = (i: number): number => {
    const p = priceOf(i);
    if (buckets[i] === 0n || p < result.clearingPrice || result.marginalTick < 0) return 0;
    if (result.rule === "pro_rata_all") return Number(result.fillNum) / Number(result.fillDen);
    if (p > result.clearingPrice) return 1;
    return Number(result.fillNum) / Number(result.fillDen);
  };
  // x of the clearing price on the tick axis (linear between tick centres)
  const pIndex = Number(result.clearingPrice - floor) / Number(tick);
  const px = left + colW * (pIndex + 0.5);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-[560px] [--k:1.2] sm:[--k:1]" role="img" aria-labelledby="hist-t">
      <title id="hist-t">Revealed demand per price tick, with the uniform clearing price marked</title>
      {/* y grid */}
      {[0, 0.5, 1].map((f) => (
        <line key={f} x1={left} x2={W - 8} y1={bottom - f * (bottom - top)} y2={bottom - f * (bottom - top)} stroke="#DEDAD1" strokeWidth="1" />
      ))}
      <text x={left - 6} y={top + 3} textAnchor="end" className="fill-[#8F8C84] font-mono text-[length:calc(8.5px*var(--k,1))]">
        {(Number(max) / 1000).toFixed(0)}k
      </text>
      <text x={left - 6} y={bottom + 3} textAnchor="end" className="fill-[#8F8C84] font-mono text-[length:calc(8.5px*var(--k,1))]">
        0
      </text>
      {Array.from({ length: shownTicks }, (_, i) => {
        const x = left + colW * i + 6;
        const w = colW - 12;
        const bh = h(buckets[i] ?? 0n);
        const ff = fillFrac(i);
        return (
          <g key={i}>
            {bh > 0 && (
              <>
                <rect x={x} y={bottom - bh} width={w} height={bh} fill="#FCFBF8" stroke="#0F0F0D" strokeWidth="1.25" />
                {ff > 0 && <rect x={x} y={bottom - bh * ff} width={w} height={bh * ff} fill="#0F0F0D" />}
              </>
            )}
            <line x1={x + w / 2} x2={x + w / 2} y1={bottom} y2={bottom + 4} stroke="#8F8C84" strokeWidth="1" />
            <text x={x + w / 2} y={bottom + 15} textAnchor="middle" className="fill-[#5C5A54] font-mono text-[length:calc(9px*var(--k,1))]">
              {priceOf(i).toString()}
            </text>
            <text x={x + w / 2} y={bottom + 26} textAnchor="middle" className="fill-[#8F8C84] font-mono text-[length:calc(8.5px*var(--k,1))]">
              t{i}
            </text>
          </g>
        );
      })}
      <line x1={left} x2={W - 8} y1={bottom} y2={bottom} stroke="#0F0F0D" strokeWidth="1.25" />
      {/* clearing price */}
      <line x1={px} x2={px} y1={top - 10} y2={bottom} stroke="#2E3FE0" strokeWidth="1.25" strokeDasharray="3 3" />
      <text x={px + 4} y={top - 4} className="fill-[#2E3FE0] font-mono text-[length:calc(9px*var(--k,1))]">
        P = {result.clearingPrice.toString()} {unitLabel}
      </text>
    </svg>
  );
}

/* ---------------------------------------------------------------- fee splits */

function SplitBar({ parts, title, caption }: { parts: Array<{ label: string; bps: number; tone: string }>; title: string; caption: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[14px] font-semibold text-ink">{title}</p>
        <p className="eyebrow shrink-0">{caption}</p>
      </div>
      <div className="mt-2 flex h-9 w-full overflow-hidden rounded-field border border-ink">
        {parts.map((p, i) => (
          <div key={p.label} style={{ width: pct(p.bps) }} className={clsx("flex min-w-0 items-center px-2 font-mono text-[11px]", p.tone, i > 0 && "border-l border-ink")}>
            <span className="truncate">{pctNum(p.bps)}%</span>
          </div>
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center gap-1.5 text-[12.5px] text-ink-slate">
            <span className={clsx("h-2.5 w-2.5 shrink-0 rounded-[2px] border border-ink", p.tone)} aria-hidden />
            {p.label} <span className="num text-ink">{pctNum(p.bps)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FeeSplitDiagram() {
  return (
    <div className="space-y-6">
      <SplitBar
        title="Phase A · repaying"
        caption="credit outstanding > 0"
        parts={[
          { label: "Credit repayment → Credit Pool", bps: REPAY_SPLIT.creditRepayBps, tone: "bg-ink text-paper" },
          { label: "Platform burn / ops", bps: REPAY_SPLIT.platformBurnOpsBps, tone: "bg-paper-deep text-ink" },
        ]}
      />
      <SplitBar
        title="Phase B · flywheel"
        caption="credit outstanding = 0"
        parts={[
          { label: "Holders (quote asset)", bps: FLYWHEEL_SPLIT.holderPayoutBps, tone: "bg-gain text-white" },
          { label: "Platform buyback-burn", bps: FLYWHEEL_SPLIT.platformBuybackBurnBps, tone: "bg-ink text-paper" },
          { label: "Treasury", bps: FLYWHEEL_SPLIT.treasuryBps, tone: "bg-paper-deep text-ink" },
        ]}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- timeline */

export function Timeline({ segments }: { segments: Array<{ label: string; sub: string; weight: number; tone?: "ink" | "soft" | "line" }> }) {
  const total = segments.reduce((a, s) => a + s.weight, 0);
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full border border-ink">
        {segments.map((s, i) => (
          <div
            key={s.label}
            style={{ width: `${(s.weight / total) * 100}%` }}
            className={clsx(i > 0 && "border-l border-ink", s.tone === "ink" ? "bg-ink" : s.tone === "soft" ? "bg-ink-muted" : "bg-sheet")}
          />
        ))}
      </div>
      <ol className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {segments.map((s, i) => (
          <li key={s.label} className="min-w-0 border-l border-rule pl-3">
            <p className="num text-[10.5px] text-ink-muted">{String(i + 1).padStart(2, "0")}</p>
            <p className="text-[13.5px] font-semibold text-ink">{s.label}</p>
            <p className="text-[12.5px] leading-snug text-ink-slate">{s.sub}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------------------------------------------------------------- architecture */

export function ArchitectureMap() {
  const col = "min-w-0 rounded-card border border-rule bg-sheet p-4";
  const node = "border-t border-rule py-2.5 first:border-t-0 first:pt-0";
  const nm = "text-[13.5px] font-semibold text-ink";
  const ds = "text-[12.5px] leading-snug text-ink-slate";
  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] md:items-stretch">
      <div className={col}>
        <p className="eyebrow mb-3">Browser · Vercel</p>
        <div className={node}>
          <p className={nm}>apps/web</p>
          <p className={ds}>Next.js 15 App Router, Tailwind, framer-motion</p>
        </div>
        <div className={node}>
          <p className={nm}>Wallet Adapter</p>
          <p className={ds}>SIWS sign-in; deposit transfer with memo</p>
        </div>
        <div className={node}>
          <p className={nm}>Bid vault</p>
          <p className={ds}>AES-GCM salts in IndexedDB</p>
        </div>
      </div>
      <Connector label="REST · WS" />
      <div className={col}>
        <p className="eyebrow mb-3">API · Railway</p>
        <div className={node}>
          <p className={nm}>Fastify REST + /ws</p>
          <p className={ds}>/api/*, /llms.txt, event hub</p>
        </div>
        <div className={node}>
          <p className={nm}>Ledger engine</p>
          <p className={ds}>auctions, pool, drips, fee splits, rewards (double-entry)</p>
        </div>
        <div className={node}>
          <p className={nm}>Postgres · Redis</p>
          <p className={ds}>ledger of record; memory store in local development</p>
        </div>
      </div>
      <Connector label="RPC" />
      <div className={col}>
        <p className="eyebrow mb-3">Solana</p>
        <div className={node}>
          <p className={nm}>Company wallet</p>
          <p className={ds}>holds deposits; pays withdrawals</p>
        </div>
        <div className={node}>
          <p className={nm}>Helius</p>
          <p className={ds}>RPC, deposit detection, Privacy Rings</p>
        </div>
        <div className={node}>
          <p className={nm}>sealed_launchpad</p>
          <p className={ds}>Anchor program · onchain mode (roadmap)</p>
        </div>
      </div>
    </div>
  );
}

function Connector({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-1 md:flex-col md:py-0" aria-hidden>
      <svg width="40" height="14" viewBox="0 0 40 14" className="hidden md:block">
        <path d="M2 7h34M30 2l6 5-6 5" fill="none" stroke="#0F0F0D" strokeWidth="1.25" />
      </svg>
      <svg width="14" height="22" viewBox="0 0 14 22" className="md:hidden">
        <path d="M7 1v18M2 14l5 6 5-6" fill="none" stroke="#0F0F0D" strokeWidth="1.25" />
      </svg>
      <span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-muted md:[writing-mode:horizontal-tb]">{label}</span>
    </div>
  );
}

/* ---------------------------------------------------------------- sequence (relayer) */

export function Sequence({ lanes, steps }: { lanes: string[]; steps: Array<{ from: number; to: number; label: string; note?: string }> }) {
  return (
    <div>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(0, 1fr))` }}>
        {lanes.map((l) => (
          <p key={l} className="truncate border-b border-ink pb-2 text-center font-mono text-[10px] uppercase tracking-[0.06em] text-ink">
            {l}
          </p>
        ))}
      </div>
      <ol className="mt-1">
        {steps.map((s, i) => {
          const a = Math.min(s.from, s.to);
          const b = Math.max(s.from, s.to);
          const n = lanes.length;
          const leftPct = ((a + 0.5) / n) * 100;
          const widthPct = ((b - a) / n) * 100;
          const self = s.from === s.to;
          return (
            <li key={i} className="border-b border-rule py-2.5">
              <div className="relative h-4">
                {lanes.map((_, j) => (
                  <span key={j} className="absolute top-0 h-4 w-px bg-rule" style={{ left: `${((j + 0.5) / n) * 100}%` }} aria-hidden />
                ))}
                {self ? (
                  <span className="absolute top-1.5 h-1 w-1 -translate-x-1/2 rounded-full bg-ink" style={{ left: `${((s.from + 0.5) / n) * 100}%` }} aria-hidden />
                ) : (
                  <span className="absolute top-2 h-px bg-ink" style={{ left: `${leftPct}%`, width: `${widthPct}%` }} aria-hidden>
                    <span className={clsx("absolute -top-[3px] h-0 w-0 border-y-[3.5px] border-y-transparent", s.to > s.from ? "right-0 border-l-[6px] border-l-ink" : "left-0 border-r-[6px] border-r-ink")} />
                  </span>
                )}
              </div>
              <p className="mt-1 text-[13px] leading-snug text-ink-soft">
                <span className="num mr-2 text-[10.5px] text-ink-muted">{String(i + 1).padStart(2, "0")}</span>
                {s.label}
                {s.note && <span className="text-ink-muted">: {s.note}</span>}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
