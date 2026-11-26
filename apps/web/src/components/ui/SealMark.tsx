import clsx from "clsx";

/**
 * The Sealed mark: three concentric hairline rings, the middle one dashed (the "seal"), cut by a
 * horizontal clearing line — every hidden bid resolves to one uniform price. `spin` slowly rotates the dashed ring.
 */
export function SealMark({ size = 28, className, spin = false, title }: { size?: number; className?: string; spin?: boolean; title?: string }) {
  // Large marks keep hairline strokes instead of scaling them up.
  const ve = size > 64 ? ("non-scaling-stroke" as const) : undefined;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={clsx("shrink-0", className)} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <circle cx="16" cy="16" r="15" stroke="currentColor" strokeWidth="1.25" vectorEffect={ve} />
      <g className={spin ? "origin-center animate-ring motion-reduce:animate-none" : undefined} style={{ transformBox: "fill-box" }}>
        <circle cx="16" cy="16" r="10.5" stroke="currentColor" strokeWidth="1.25" strokeDasharray={ve ? "1.2 1.6" : "2.2 2.2"} vectorEffect={ve} />
      </g>
      <circle cx="16" cy="16" r="5" fill="currentColor" />
      <path d="M1 16h9M22 16h9" stroke="currentColor" strokeWidth="1.25" vectorEffect={ve} />
    </svg>
  );
}
