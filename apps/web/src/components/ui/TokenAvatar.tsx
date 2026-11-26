"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { IMAGE_ROUTE_PREFIX, isRenderableImageSrc, resolveImageUrl } from "@/lib/upload/tokenImage";

/**
 * Round token mark. The initials are always laid out underneath; the image (uploaded API URL, external URL or a
 * data: URI) fades in over them once it loads, and is dropped on error, so a broken or slow image never shifts
 * layout and never leaves a broken-image glyph.
 */
export function TokenAvatar({
  src,
  ticker,
  size = 40,
  className,
  tone = "light",
  eager = false,
}: {
  src: string | null | undefined;
  ticker: string;
  size?: number;
  className?: string;
  /** "dark" for use on ink/night backgrounds. */
  tone?: "light" | "dark";
  /** Above-the-fold marks (e.g. the token room masthead) skip lazy loading. */
  eager?: boolean;
}) {
  const raw = typeof src === "string" ? src.trim() : "";
  const url = raw.startsWith(IMAGE_ROUTE_PREFIX) ? resolveImageUrl(raw) : raw;
  const usable = isRenderableImageSrc(url);
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const ref = useRef<HTMLImageElement>(null);

  // An image can finish (or fail) before hydration attaches onLoad/onError; settle that state on mount.
  useEffect(() => {
    const el = ref.current;
    if (!el || !el.complete) return;
    if (el.naturalWidth > 0) setLoaded(url);
    else setFailed(url);
  }, [url]);

  const show = usable && failed !== url;
  const initials = (ticker || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "··";
  const label = `${ticker ? ticker.toUpperCase() : "Token"} logo`;

  return (
    <span
      role={show ? undefined : "img"}
      aria-label={show ? undefined : label}
      className={clsx(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full border",
        tone === "dark" ? "border-paper/25 bg-paper/10" : "border-rule bg-paper-deep",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <span
        aria-hidden
        className={clsx("font-mono uppercase leading-none", tone === "dark" ? "text-paper/80" : "text-ink-slate", loaded === url && show && "invisible")}
        style={{ fontSize: Math.max(9, Math.round(size * 0.3)) }}
      >
        {initials}
      </span>
      {show && (
        <img
          ref={ref}
          key={url}
          src={url}
          alt={label}
          width={size}
          height={size}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(url)}
          onError={() => setFailed(url)}
          className={clsx("absolute inset-0 h-full w-full rounded-full object-cover transition-opacity duration-200", loaded === url ? "opacity-100" : "opacity-0")}
        />
      )}
    </span>
  );
}
