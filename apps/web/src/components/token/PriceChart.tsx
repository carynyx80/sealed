"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { PricePoint, QuoteAssetSymbol } from "@sealed/shared";
import { fmtAmount, fmtPct, fmtPrice } from "@/lib/format";

/* Print-style price chart: crisp 1px strokes on whole pixels, hatched area, right-hand price axis with tick
   marks, time axis with tick marks, hairline volume band, dashed sealed-clearing reference and a crosshair. */

const AXIS_W_FULL = 78; // right price axis
const AXIS_W_COMPACT = 66; // phones: tags are set in 10px mono, 66px fits 0.0₃8134-style prices
const TIME_H = 26; // bottom time axis
const VOL_H = 34; // volume band
const GAP = 10;
const TOP = 12;

const INK = "#0F0F0D";
const SLATE = "#5C5A54";
const MUTED = "#8F8C84";
const RULE = "#DEDAD1";
const SHEET = "#FCFBF8";

const px = (v: number) => Math.round(v) + 0.5;

function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function priceTicks(lo: number, hi: number, count: number) {
  const step = niceStep((hi - lo) / Math.max(1, count));
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(v);
  return out;
}

const TIME_STEPS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800];
function timeTicks(t0: number, t1: number, maxCount: number) {
  const span = Math.max(1, t1 - t0);
  const step = TIME_STEPS.find((s) => span / s <= maxCount) ?? 604800;
  const out: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
  return { ticks: out, step };
}

function dayOnly(ts: number) {
  return new Date(ts * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function hhmm(ts: number, withDay = false) {
  const d = new Date(ts * 1000);
  const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return withDay ? `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${t}` : t;
}

/** Measures the box. Its height is set by CSS (clamped to the viewport), so nothing shifts when JS measures it. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      setSize((p) => (p.w === Math.floor(r.width) && p.h === Math.floor(r.height) ? p : { w: Math.floor(r.width), h: Math.floor(r.height) }));
    };
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export function PriceChart({ points, quote, clearingPrice, height = 300 }: { points: PricePoint[]; quote: QuoteAssetSymbol; clearingPrice?: number | null; height?: number }) {
  const [wrap, { w: W, h: measuredH }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = measuredH || height;
  const compact = W > 0 && W < 520;
  const AXIS_W = compact ? AXIS_W_COMPACT : AXIS_W_FULL;
  // Touch: a tap or a sideways drag scrubs the crosshair; vertical drags still scroll the page (touch-action: pan-y).
  const touch = useRef<{ id: number; x: number; y: number; scrubbing: boolean } | null>(null);
  const clearT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(clearT.current), []);

  const geo = useMemo(() => {
    if (points.length < 2 || W <= 0) return null;
    const plotL = 0;
    const plotR = W - AXIS_W;
    const plotB = H - TIME_H - VOL_H - GAP;
    const volT = plotB + GAP;
    const volB = H - TIME_H;
    const xs = points.map((p) => p.ts);
    const ys = points.map((p) => p.price);
    if (clearingPrice) ys.push(clearingPrice);
    const t0 = Math.min(...xs), t1 = Math.max(...xs);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = (hi - lo) * 0.1 || hi * 0.05;
    lo = Math.max(0, lo - pad);
    hi += pad;
    const sx = (t: number) => plotL + 8 + ((t - t0) / Math.max(1, t1 - t0)) * (plotR - plotL - 16);
    const sy = (p: number) => TOP + (1 - (p - lo) / Math.max(1e-18, hi - lo)) * (plotB - TOP);
    const pts = points.map((p) => [sx(p.ts), sy(p.price)] as const);
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join("");
    const area = `${line}L${pts[pts.length - 1]![0].toFixed(2)},${plotB}L${pts[0]![0].toFixed(2)},${plotB}Z`;
    const vmax = Math.max(1e-12, ...points.map((p) => p.volume));
    const barW = Math.max(1, Math.min(6, ((plotR - plotL) / points.length) * 0.35));
    const yt = priceTicks(lo, hi, compact ? 3 : 4).filter((v) => sy(v) > TOP + 4 && sy(v) < plotB - 4);
    const tt = timeTicks(t0, t1, compact ? 3 : 6);
    return { plotL, plotR, plotB, volT, volB, sx, sy, pts, line, area, vmax, barW, yt, tt, t0, t1 };
  }, [points, clearingPrice, W, H, compact, AXIS_W]);

  const stats = useMemo(() => {
    if (points.length < 2) return null;
    const ps = points.map((p) => p.price);
    const open = ps[0]!, last = ps[ps.length - 1]!;
    return { open, last, high: Math.max(...ps), low: Math.min(...ps), vol: points.reduce((s, p) => s + p.volume, 0), chg: ((last - open) / open) * 100 };
  }, [points]);

  if (points.length < 2) {
    return (
      <div className="flex items-center justify-center rounded-field border border-dashed border-rule-strong text-[13px] text-ink-muted" style={{ height }}>
        <span className="font-mono text-[11px] uppercase tracking-[0.08em]">Chart opens at graduation</span>
      </div>
    );
  }

  const onMove = (clientX: number, rectLeft: number) => {
    if (!geo) return;
    const x = Math.min(geo.plotR, clientX - rectLeft);
    let best = 0, bd = Infinity;
    geo.pts.forEach(([p], i) => {
      const d = Math.abs(p - x);
      if (d < bd) { bd = d; best = i; }
    });
    setHover(best);
  };

  const idx = hover ?? points.length - 1;
  const cur = points[idx]!;
  const spanDays = geo ? geo.t1 - geo.t0 > 86400 : false;

  // Axis tags: keep the clearing tag from colliding with the last-price tag.
  let lastY = geo ? geo.sy(stats!.last) : 0;
  let clrY = geo && clearingPrice ? geo.sy(clearingPrice) : null;
  if (clrY !== null && Math.abs(clrY - lastY) < 18) {
    const mid = (clrY + lastY) / 2;
    if (clrY >= lastY) { clrY = mid + 9; lastY = mid - 9; } else { clrY = mid - 9; lastY = mid + 9; }
  }

  return (
    <div>
      {/* readout */}
      <div className="mb-3 flex min-h-[2.5rem] flex-wrap content-start items-baseline gap-x-4 gap-y-1 font-mono text-[11px] text-ink-muted sm:min-h-0">
        <span className={clsx("inline-block w-[3.25rem] uppercase tracking-[0.08em]", hover !== null ? "text-ink" : "")}>{hover !== null ? "Cursor" : "Last"}</span>
        <span className="num text-ink">{hhmm(cur.ts, spanDays)}</span>
        <span>
          <span className="num text-[13px] text-ink">{fmtPrice(cur.price)}</span> {quote}
        </span>
        <span>vol <span className="num text-ink-slate">{fmtAmount(cur.volume)}</span></span>
        {clearingPrice ? (
          <span>
            vs clearing{" "}
            <span className={clsx("num", cur.price >= clearingPrice ? "text-gain" : "text-burn")}>{fmtPct(((cur.price - clearingPrice) / clearingPrice) * 100, 1, true)}</span>
          </span>
        ) : null}
      </div>

      <div ref={wrap} className="relative w-full" style={{ height: `clamp(200px, min(58vw, 60svh), ${height}px)` }}>
        {geo && (
          <svg
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            className="block touch-pan-y select-none"
            onPointerMove={(e) => {
              const left = e.currentTarget.getBoundingClientRect().left;
              if (e.pointerType === "mouse") return onMove(e.clientX, left);
              const t = touch.current;
              if (!t || t.id !== e.pointerId) return;
              const dx = Math.abs(e.clientX - t.x), dy = Math.abs(e.clientY - t.y);
              if (!t.scrubbing && dx > 6 && dx > dy) t.scrubbing = true;
              if (t.scrubbing) onMove(e.clientX, left);
            }}
            onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
            onPointerDown={(e) => {
              if (e.pointerType === "mouse") return;
              clearTimeout(clearT.current);
              touch.current = { id: e.pointerId, x: e.clientX, y: e.clientY, scrubbing: false };
            }}
            onPointerUp={(e) => {
              const t = touch.current;
              if (!t || t.id !== e.pointerId) return;
              // A tap (no real movement) pins the crosshair at that point.
              if (!t.scrubbing && Math.abs(e.clientX - t.x) < 8 && Math.abs(e.clientY - t.y) < 8) onMove(e.clientX, e.currentTarget.getBoundingClientRect().left);
              touch.current = null;
              clearTimeout(clearT.current);
              clearT.current = setTimeout(() => setHover(null), 2600);
            }}
            onPointerCancel={() => {
              // The browser took over for a vertical scroll.
              touch.current = null;
              setHover(null);
            }}
            role="img"
            aria-label={`Price of the token in ${quote}. Last ${fmtPrice(stats!.last)}, high ${fmtPrice(stats!.high)}, low ${fmtPrice(stats!.low)}${clearingPrice ? `, sealed clearing price ${fmtPrice(clearingPrice)}` : ""}.`}
            shapeRendering="crispEdges"
          >
            <defs>
              <pattern id="pc-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="5" stroke={RULE} strokeWidth="1" />
              </pattern>
            </defs>

            {/* price gridlines + axis ticks */}
            {geo.yt.map((v) => {
              const y = px(geo.sy(v));
              return (
                <g key={v}>
                  <line x1={geo.plotL} x2={geo.plotR} y1={y} y2={y} stroke={RULE} strokeWidth="1" strokeDasharray="1 3" />
                  <line x1={geo.plotR} x2={geo.plotR + 4} y1={y} y2={y} stroke={SLATE} strokeWidth="1" />
                  <text x={geo.plotR + 8} y={y + 3.5} fontSize="10" fill={MUTED} fontFamily="var(--font-mono)">{fmtPrice(v)}</text>
                </g>
              );
            })}
            {/* frame: price axis spine, plot baseline, time axis */}
            <line x1={px(geo.plotR)} x2={px(geo.plotR)} y1={TOP - 6} y2={geo.volB} stroke={INK} strokeWidth="1" />
            <line x1={geo.plotL} x2={geo.plotR} y1={px(geo.plotB)} y2={px(geo.plotB)} stroke={RULE} strokeWidth="1" />
            <line x1={geo.plotL} x2={geo.plotR} y1={px(geo.volB)} y2={px(geo.volB)} stroke={INK} strokeWidth="1" />
            {geo.tt.ticks.map((t) => {
              const x = px(geo.sx(t));
              if (x < 18 || x > geo.plotR - 18) return null;
              return (
                <g key={t}>
                  <line x1={x} x2={x} y1={geo.volB} y2={geo.volB + 5} stroke={INK} strokeWidth="1" />
                  <text x={x} y={geo.volB + 17} fontSize="10" fill={MUTED} textAnchor="middle" fontFamily="var(--font-mono)">{geo.tt.step >= 86400 ? (compact ? dayOnly(t) : hhmm(t, true)) : hhmm(t)}</text>
                </g>
              );
            })}
            {/* minor ticks at each sample */}
            {geo.pts.map(([x], i) => (
              <line key={i} x1={px(x)} x2={px(x)} y1={geo.volB} y2={geo.volB + 2.5} stroke={MUTED} strokeWidth="1" />
            ))}
            <text x={geo.plotL} y={geo.volT + 8} fontSize="9" fill={MUTED} fontFamily="var(--font-mono)" letterSpacing="0.08em">VOL</text>

            {/* volume band */}
            {points.map((p, i) => {
              const h = Math.max(1, (p.volume / geo.vmax) * (VOL_H - 4));
              const x = geo.pts[i]![0];
              return <rect key={p.ts} x={Math.round(x - geo.barW / 2)} y={Math.round(geo.volB - h)} width={Math.round(geo.barW)} height={Math.round(h)} fill={i === hover ? INK : MUTED} opacity={i === hover ? 1 : 0.55} />;
            })}

            {/* area + line */}
            <path d={geo.area} fill="url(#pc-hatch)" shapeRendering="geometricPrecision" />
            <path d={geo.line} fill="none" stroke={INK} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" shapeRendering="geometricPrecision" />

            {/* sealed clearing reference */}
            {clearingPrice && clrY !== null ? (
              <g>
                <line x1={geo.plotL} x2={geo.plotR} y1={px(geo.sy(clearingPrice))} y2={px(geo.sy(clearingPrice))} stroke={SLATE} strokeWidth="1" strokeDasharray="5 3" />
                {!compact && (
                  <text x={geo.plotL + 2} y={px(geo.sy(clearingPrice)) - 5} fontSize="9" fill={SLATE} fontFamily="var(--font-mono)" letterSpacing="0.08em">SEALED CLEARING</text>
                )}
                <rect x={geo.plotR + 1} y={Math.round(clrY - 8)} width={AXIS_W - 2} height="16" fill={SHEET} stroke={SLATE} strokeWidth="1" />
                <text x={geo.plotR + 6} y={clrY + 3.5} fontSize="10" fill={SLATE} fontFamily="var(--font-mono)">{fmtPrice(clearingPrice)}</text>
              </g>
            ) : null}

            {/* last price guide + tag */}
            <line x1={px(geo.pts[geo.pts.length - 1]![0])} x2={geo.plotR} y1={px(geo.sy(stats!.last))} y2={px(geo.sy(stats!.last))} stroke={INK} strokeWidth="1" strokeDasharray="1 2" />
            <rect x={geo.plotR + 1} y={Math.round(lastY - 8)} width={AXIS_W - 2} height="16" fill={INK} />
            <text x={geo.plotR + 6} y={lastY + 3.5} fontSize="10" fill={SHEET} fontFamily="var(--font-mono)">{fmtPrice(stats!.last)}</text>

            {/* crosshair */}
            {hover !== null && (() => {
              const [hx, hy] = geo.pts[hover]!;
              const X = px(hx), Y = px(hy);
              const label = hhmm(points[hover]!.ts, spanDays);
              const lw = label.length * 6.2 + 12;
              const lx = Math.min(Math.max(X - lw / 2, 0), geo.plotR - lw);
              return (
                <g pointerEvents="none">
                  <line x1={X} x2={X} y1={TOP - 6} y2={geo.volB} stroke={INK} strokeWidth="1" strokeDasharray="2 2" />
                  <line x1={geo.plotL} x2={geo.plotR} y1={Y} y2={Y} stroke={INK} strokeWidth="1" strokeDasharray="2 2" />
                  <rect x={geo.plotR + 1} y={Math.round(hy - 8)} width={AXIS_W - 2} height="16" fill={INK} />
                  <text x={geo.plotR + 6} y={hy + 3.5} fontSize="10" fill={SHEET} fontFamily="var(--font-mono)">{fmtPrice(points[hover]!.price)}</text>
                  <rect x={Math.round(lx)} y={geo.volB + 4} width={Math.round(lw)} height="16" fill={INK} />
                  <text x={lx + lw / 2} y={geo.volB + 15.5} fontSize="10" fill={SHEET} textAnchor="middle" fontFamily="var(--font-mono)">{label}</text>
                  <circle cx={hx} cy={hy} r="3.5" fill={SHEET} stroke={INK} strokeWidth="1" shapeRendering="geometricPrecision" />
                </g>
              );
            })()}
          </svg>
        )}
      </div>

      {stats && (
        <dl className="mt-4 grid grid-cols-2 gap-px border-t border-ink bg-rule min-[400px]:grid-cols-3 sm:grid-cols-6">
          {[
            ["Open", fmtPrice(stats.open)],
            ["High", fmtPrice(stats.high)],
            ["Low", fmtPrice(stats.low)],
            ["Last", fmtPrice(stats.last)],
            ["Δ range", fmtPct(stats.chg, 1, true)],
            [`Vol ${quote}`, fmtAmount(stats.vol)],
          ].map(([k, v], i) => (
            <div key={k} className={clsx("min-w-0 bg-sheet py-2.5 pr-2", i % 2 === 0 ? "pl-0" : "pl-3", i % 3 === 0 ? "min-[400px]:pl-0" : "min-[400px]:pl-3", i === 0 ? "sm:pl-0" : "sm:pl-3")}>
              <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">{k}</dt>
              <dd className={clsx("num mt-0.5 truncate text-[13px]", k === "Δ range" ? (stats.chg >= 0 ? "text-gain" : "text-burn") : "text-ink")}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
