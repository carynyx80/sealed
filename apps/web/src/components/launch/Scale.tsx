"use client";
import clsx from "clsx";

export interface ScaleMark {
  at: number;
  label: string;
  tone?: "burn" | "muted";
}

/**
 * A ruled, print-style slider. The visible scale may extend past `max` (the domain runs to `domainMax`):
 * the excess is hatched and the native input only covers the permitted part of the track, so the handle
 * physically stops at the cap rule. Keyboard + screen-reader behaviour comes from the native range input.
 */
export function Scale({
  id,
  min,
  max,
  domainMax = max,
  step,
  value,
  onChange,
  ticks,
  tickLabel,
  cap,
  marks = [],
  zone,
  valueText,
}: {
  id: string;
  min: number;
  max: number;
  domainMax?: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  ticks: number[];
  tickLabel: (v: number) => string;
  /** Hard rule drawn at `max`, labelled. */
  cap?: { label: string; note?: string };
  marks?: ScaleMark[];
  /** Tinted band, e.g. a range only some networks allow. */
  zone?: { from: number; to: number; label: string };
  valueText: string;
}) {
  const span = Math.max(1e-9, domainMax - min);
  const pct = (v: number) => ((Math.min(domainMax, Math.max(min, v)) - min) / span) * 100;
  const allowed = pct(max);
  const v = Math.min(max, Math.max(min, value));

  return (
    <div className="select-none pb-7 pt-6">
      <div className="relative h-9">
        {zone && (
          <div className="absolute inset-y-1 bg-paper-deep" style={{ left: `${pct(zone.from)}%`, width: `${pct(zone.to) - pct(zone.from)}%` }}>
            <span className="num absolute left-1.5 top-0.5 hidden whitespace-nowrap text-[10px] text-ink-muted sm:block">{zone.label}</span>
          </div>
        )}
        {domainMax > max && (
          <div
            aria-hidden
            className="absolute inset-y-1 right-0"
            style={{
              left: `${allowed}%`,
              backgroundImage: "repeating-linear-gradient(135deg, var(--rule-strong) 0 1px, transparent 1px 6px)",
            }}
          >
            {cap?.note && <span className="num absolute bottom-0.5 right-1.5 hidden whitespace-nowrap sm:block bg-sheet px-1 text-[10px] uppercase tracking-[0.08em] text-ink-muted">{cap.note}</span>}
          </div>
        )}
        {/* baseline + fill */}
        <div aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-rule-strong" />
        <div aria-hidden className="absolute left-0 top-1/2 h-[2px] -translate-y-1/2 bg-ink transition-[width] duration-150" style={{ width: `${pct(v)}%` }} />
        {marks.map((m) => (
          <div key={m.at} aria-hidden className="absolute inset-y-0" style={{ left: `${pct(m.at)}%` }}>
            <div className={clsx("h-full border-l border-dashed", m.tone === "burn" ? "border-burn" : "border-ink-muted")} />
            <span className={clsx("num absolute -top-5 -translate-x-1/2 whitespace-nowrap text-[10px] uppercase tracking-[0.08em]", m.tone === "burn" ? "text-burn" : "text-ink-muted")}>{m.label}</span>
          </div>
        ))}
        {cap && (
          <div aria-hidden className="absolute -inset-y-1" style={{ left: `${allowed}%` }}>
            <div className="h-full w-px -translate-x-1/2 bg-burn" />
            <span className={clsx("num absolute -top-5 whitespace-nowrap text-[10px] uppercase tracking-[0.08em] text-burn", allowed > 80 ? "right-1.5" : "left-1.5")}>{cap.label}</span>
          </div>
        )}
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={v}
          aria-valuetext={valueText}
          onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value))))}
          className="peer absolute -inset-y-1 left-0 z-10 m-0 h-11 cursor-ew-resize touch-pan-y appearance-none bg-transparent opacity-0 [&::-moz-range-thumb]:h-11 [&::-moz-range-thumb]:w-1 [&::-webkit-slider-thumb]:h-11 [&::-webkit-slider-thumb]:w-1 [&::-webkit-slider-thumb]:appearance-none"
          style={{ width: `${allowed}%` }}
        />
        {/* the needle */}
        <div aria-hidden className="pointer-events-none absolute inset-y-0 transition-[left] duration-150" style={{ left: `${pct(v)}%` }}>
          <div className="mx-auto h-full w-px -translate-x-1/2 bg-ink" />
          <div className="absolute left-0 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-ink bg-sheet" />
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-y-0 rounded-sm opacity-0 ring-2 ring-signal/30 ring-offset-2 ring-offset-sheet peer-focus-visible:opacity-100" style={{ left: 0, width: `${allowed}%` }} />
      </div>
      {/* tick ruler */}
      <div aria-hidden className="relative mt-1 h-px">
        {ticks.map((t, i) => (
          <div key={t} className="absolute top-0" style={{ left: `${pct(t)}%` }}>
            <div className="h-1.5 w-px bg-ink-muted" />
            <span
              className={clsx(
                "num absolute top-2.5 whitespace-nowrap text-[10px] text-ink-muted",
                i === 0 ? "left-0" : i === ticks.length - 1 ? "right-0" : "-translate-x-1/2",
                ticks.length > 5 && i % 2 === 1 && "hidden sm:block",
              )}
            >
              {tickLabel(t)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
