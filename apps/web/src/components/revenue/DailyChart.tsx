"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import clsx from "clsx";
import { useReducedMotion } from "@/components/motion/reduced";
import type { RevenueResponse } from "@sealed/shared";
import { fmtCompact, fmtUsd } from "@/lib/format";
import { SPRING } from "../motion/spring";

type Metric = "feesUsd" | "creditRepaidUsd" | "burnedUsd" | "holderPayoutsUsd";
const METRICS: { id: Metric; label: string; stroke: string }[] = [
  { id: "feesUsd", label: "Fees", stroke: "var(--ink)" },
  { id: "creditRepaidUsd", label: "Credit repaid", stroke: "var(--gain)" },
  { id: "burnedUsd", label: "Burned", stroke: "var(--burn)" },
  { id: "holderPayoutsUsd", label: "Holder payouts", stroke: "var(--gain)" },
];

const H = 260;
const PAD = { t: 16, b: 28, l: 0, r: 52 };

function niceStep(max: number, n = 4) {
  const raw = max / n;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const r = raw / mag;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ""}`;

/** Print-style daily chart: hairline columns, right-hand value axis, tick ruler, crosshair readout in the header. */
export function DailyChart({ daily }: { daily: RevenueResponse["daily"] }) {
  const [metric, setMetric] = useState<Metric>("feesUsd");
  const [hover, setHover] = useState<number | null>(null);
  const [w, setW] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  const m = METRICS.find((x) => x.id === metric)!;
  const vals = daily.map((d) => d[metric]);
  const total = vals.reduce((a, b) => a + b, 0);
  const step = niceStep(Math.max(1, ...vals));
  const top = Math.max(step, Math.ceil(Math.max(1, ...vals) / step) * step);
  const n = Math.max(1, daily.length);
  const iw = Math.max(0, w - PAD.l - PAD.r);
  const ih = H - PAD.t - PAD.b;
  const slot = iw / n;
  const bw = Math.max(1, Math.min(9, slot * 0.3));
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  const yTicks = useMemo(() => Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step), [top, step]);
  const xEvery = n > 20 ? (w < 520 ? 7 : 5) : w < 520 ? 3 : 2;
  const avg = total / n;
  const sel = hover ?? n - 1;
  const selDay = daily[sel];

  return (
    <div>
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="section-mark">§ 03 · Daily, last {daily.length} days</p>
          <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="num text-3xl tracking-[-0.03em] text-ink sm:text-4xl">{selDay ? fmtUsd(selDay[metric], false) : "…"}</span>
            <span className="num text-[12px] text-ink-muted">
              {selDay ? dayLabel(selDay.date) : ""} {hover === null && "· latest"} · {m.label.toLowerCase()}
            </span>
          </p>
          <p className="num mt-1 text-[11px] text-ink-muted">
            Period total {fmtUsd(total)} · daily mean {fmtUsd(avg)}
          </p>
        </div>
        <div role="tablist" aria-label="Chart metric" className="no-scrollbar -mx-1 flex max-w-full gap-1 overflow-x-auto">
          {METRICS.map((x) => {
            const on = x.id === metric;
            return (
              <button
                key={x.id}
                role="tab"
                aria-selected={on}
                type="button"
                onClick={() => setMetric(x.id)}
                className={clsx("relative shrink-0 whitespace-nowrap px-2 pb-2 pt-1 text-[13px] transition-colors", on ? "text-ink" : "text-ink-muted hover:text-ink-slate")}
              >
                {x.label}
                {on && <motion.span layoutId="rev-metric-rule" className="absolute inset-x-2 bottom-0 h-px bg-ink" transition={SPRING} />}
              </button>
            );
          })}
        </div>
      </div>

      <div ref={wrap} className="relative mt-6 border-t border-rule" style={{ height: H }}>
        {w > 0 && (
          <svg width={w} height={H} className="block" role="img" aria-label={`Daily ${m.label} in USD, ${daily.length} days`} onMouseLeave={() => setHover(null)}>
            {/* value grid + right axis */}
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={PAD.l + iw} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} stroke={t === 0 ? "var(--ink)" : "var(--rule)"} strokeWidth={1} strokeDasharray={t === 0 ? undefined : "1 3"} />
                <line x1={PAD.l + iw} x2={PAD.l + iw + 4} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} stroke="var(--muted)" strokeWidth={1} />
                <text x={PAD.l + iw + 8} y={y(t) + 3} className="fill-ink-muted font-mono text-[10px]">
                  {t === 0 ? "0" : `$${fmtCompact(t, t >= 1000 && t % 1000 ? 1 : 0)}`}
                </text>
              </g>
            ))}
            {/* mean */}
            <line x1={PAD.l} x2={PAD.l + iw} y1={Math.round(y(avg)) + 0.5} y2={Math.round(y(avg)) + 0.5} stroke={m.stroke} strokeWidth={1} strokeDasharray="6 4" opacity={0.55} />
            <text x={PAD.l + 2} y={y(avg) - 4} className="font-mono text-[10px]" fill={m.stroke} opacity={0.8}>mean</text>
            {/* columns */}
            {daily.map((d, i) => {
              const cx = PAD.l + slot * i + slot / 2;
              const yy = y(d[metric]);
              const active = hover === null || hover === i;
              return (
                <g key={d.date} onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)}>
                  <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={ih} fill="transparent" />
                  {hover === i && <line x1={Math.round(cx) + 0.5} x2={Math.round(cx) + 0.5} y1={PAD.t} y2={PAD.t + ih} stroke="var(--rule-strong)" strokeWidth={1} />}
                  <motion.rect
                    x={cx - bw / 2}
                    width={bw}
                    fill={m.stroke}
                    fillOpacity={active ? (hover === i ? 1 : 0.88) : 0.22}
                    initial={reduce ? false : { height: 0, y: PAD.t + ih }}
                    animate={{ height: Math.max(0, PAD.t + ih - yy), y: yy }}
                    transition={{ ...SPRING, delay: reduce ? 0 : i * 0.012 }}
                  />
                  {/* x ticks */}
                  <line x1={Math.round(cx) + 0.5} x2={Math.round(cx) + 0.5} y1={PAD.t + ih} y2={PAD.t + ih + (i % xEvery === 0 ? 5 : 3)} stroke="var(--muted)" strokeWidth={1} />
                  {i % xEvery === 0 && (
                    <text x={i === 0 ? PAD.l : cx} y={H - 6} textAnchor={i === 0 ? "start" : "middle"} className="fill-ink-muted font-mono text-[10px]">
                      {dayLabel(d.date)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      <p className="mt-2 text-[11px] text-ink-muted">USD at indicative prices, UTC days. Hover or tap a column to read its value.</p>
    </div>
  );
}
