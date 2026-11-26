/* eslint-disable @next/next/no-img-element */
import clsx from "clsx";

export function TokenAvatar({ src, ticker, size = 40, className }: { src: string; ticker: string; size?: number; className?: string }) {
  return (
    <span className={clsx("inline-flex shrink-0 overflow-hidden rounded-full border border-rule bg-paper-deep", className)} style={{ width: size, height: size }}>
      {src ? <img src={src} alt={`${ticker} logo`} width={size} height={size} className="h-full w-full object-cover" /> : <span className="m-auto font-mono text-[11px] uppercase text-ink-slate">{ticker.slice(0, 2)}</span>}
    </span>
  );
}
