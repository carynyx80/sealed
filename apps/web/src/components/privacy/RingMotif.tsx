"use client";
// Owned by helius-privacy-agent. The privacy ring mark: concentric hairline circles, the ring layer dashed and slowly
// rotating. Decorative unless `title` is given. Respects prefers-reduced-motion via `motion-reduce:`.
import clsx from "clsx";

export function RingMark({ size = 28, active = false, className, title }: { size?: number; active?: boolean; className?: string; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={clsx("shrink-0", className)} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <circle cx="16" cy="16" r="15" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" />
      <g className={clsx("origin-center", active && "animate-ring motion-reduce:animate-none")} style={{ transformBox: "fill-box" }}>
        <circle cx="16" cy="16" r="11" stroke="currentColor" strokeWidth="1.25" strokeDasharray="1.6 2.4" />
      </g>
      <circle cx="16" cy="16" r="6.5" stroke="currentColor" strokeWidth="1" />
      <circle cx="16" cy="16" r="2.2" fill="currentColor" />
    </svg>
  );
}

/** Large annotated ring for the home-page explainer (night band). */
export function RingDiagram({ className }: { className?: string }) {
  const label = "font-mono text-[9px] uppercase tracking-[0.12em]";
  return (
    <svg viewBox="0 0 400 400" fill="none" className={clsx("h-auto w-full", className)} role="img" aria-labelledby="ring-diagram-title">
      <title id="ring-diagram-title">
        Concentric rings: your bid at the centre, sealed by a keccak commitment, inside the Helius Privacy Ring, inside the public chain.
      </title>
      <defs>
        <path id="ring-path-outer" d="M200 200 m-182 0 a182 182 0 1 1 364 0 a182 182 0 1 1 -364 0" />
        <path id="ring-path-mid" d="M200 200 m-131 0 a131 131 0 1 1 262 0 a131 131 0 1 1 -262 0" />
        <path id="ring-path-inner" d="M200 200 m-79 0 a79 79 0 1 1 158 0 a79 79 0 1 1 -158 0" />
      </defs>

      {/* public chain — static hairline with tick marks */}
      <circle cx="200" cy="200" r="190" stroke="#2E2D29" strokeWidth="1" />
      {Array.from({ length: 72 }, (_, i) => {
        const a = (i / 72) * Math.PI * 2;
        const r1 = 190;
        const r2 = i % 6 === 0 ? 182 : 186;
        const p = (r: number, f: (x: number) => number) => Math.round((200 + r * f(a)) * 100) / 100; // stable SSR/CSR
        return <line key={i} x1={p(r1, Math.cos)} y1={p(r1, Math.sin)} x2={p(r2, Math.cos)} y2={p(r2, Math.sin)} stroke="#2E2D29" strokeWidth="1" />;
      })}
      <text className={label} fill="#8F8C84">
        <textPath href="#ring-path-outer" startOffset="3%">public chain · addresses · buyback drips · fees</textPath>
      </text>

      {/* Helius Privacy Ring — dashed, slow rotation */}
      <g className="origin-center animate-ring-slow motion-reduce:animate-none" style={{ transformBox: "fill-box" }}>
        <circle cx="200" cy="200" r="140" stroke="#2E3FE0" strokeWidth="1.25" strokeDasharray="3 6" />
      </g>
      <g className="origin-center animate-ring-rev motion-reduce:animate-none" style={{ transformBox: "fill-box" }}>
        <circle cx="200" cy="200" r="124" stroke="#2E3FE0" strokeOpacity="0.45" strokeWidth="1" strokeDasharray="1 9" />
      </g>
      <text className={label} fill="#E9ECFF">
        <textPath href="#ring-path-mid" startOffset="17%">helius privacy ring · private deposits · withdrawals</textPath>
      </text>

      {/* commitment */}
      <circle cx="200" cy="200" r="88" stroke="#EDEBE4" strokeOpacity="0.7" strokeWidth="1" />
      <text className={label} fill="#EDEBE4" fillOpacity="0.8">
        <textPath href="#ring-path-inner" startOffset="8%">keccak-256 · max price · bid size</textPath>
      </text>

      {/* the bid */}
      <circle cx="200" cy="200" r="30" stroke="#EDEBE4" strokeWidth="1" />
      <circle cx="200" cy="200" r="6" fill="#EDEBE4" />
      <path d="M150 200h-30M250 200h30" stroke="#EDEBE4" strokeOpacity="0.5" strokeWidth="1" />
    </svg>
  );
}
