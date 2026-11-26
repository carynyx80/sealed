"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import clsx from "clsx";
import { clampCrop, cropSide, MAX_ZOOM, type Crop, type DecodedImage } from "@/lib/upload/tokenImage";

/** CSS that places the source image so the crop square fills a `view`-px square. */
export function cropStyle(img: DecodedImage, crop: Crop, view: number): CSSProperties {
  const c = clampCrop(crop, img.width, img.height);
  const scale = view / cropSide(img.width, img.height, c.zoom);
  return {
    position: "absolute",
    left: 0,
    top: 0,
    width: img.width * scale,
    height: img.height * scale,
    maxWidth: "none",
    transform: `translate3d(${view / 2 - c.u * img.width * scale}px, ${view / 2 - c.v * img.height * scale}px, 0)`,
    transformOrigin: "0 0",
  };
}

/** Small live preview of the crop, at the sizes the mark is shown across the site. */
export function CropPreview({ img, crop, size }: { img: DecodedImage; crop: Crop; size: number }) {
  return (
    <span className="relative inline-block shrink-0 overflow-hidden rounded-full border border-rule bg-paper-deep" style={{ width: size, height: size }}>
      <img src={img.url} alt="" aria-hidden draggable={false} style={cropStyle(img, crop, size)} />
    </span>
  );
}

/** Pan (drag, arrow keys) and zoom (pinch, wheel, slider, + / -) a square crop inside a circular mask. */
export function CropBox({ img, crop, onChange, label }: { img: DecodedImage; crop: Crop; onChange: (c: Crop) => void; label: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(0);
  const drag = useRef<{ id: number; x: number; y: number; start: Crop } | null>(null);
  const cropRef = useRef(crop);
  cropRef.current = crop;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setView(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Wheel zoom needs a non-passive listener so the page doesn't scroll under the cursor.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = cropRef.current;
      changeRef.current(clampCrop({ ...c, zoom: c.zoom * Math.exp(-e.deltaY * 0.0015) }, img.width, img.height));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, [img.width, img.height]);

  const set = (c: Crop) => onChange(clampCrop(c, img.width, img.height));

  // Active pointers: one pointer pans; two pointers pinch-zoom around their midpoint (and pan with it).
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; mx: number; my: number; start: Crop } | null>(null);

  const startGesture = () => {
    const pts = [...pointers.current.values()];
    if (pts.length >= 2) {
      const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, start: cropRef.current };
      drag.current = null;
    } else if (pts.length === 1) {
      const [id] = [...pointers.current.keys()] as [number];
      pinch.current = null;
      drag.current = { id, x: pts[0]!.x, y: pts[0]!.y, start: cropRef.current };
    } else {
      pinch.current = null;
      drag.current = null;
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already released (or synthetic); dragging still works while inside the box */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startGesture();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId) || !view) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = pinch.current;
    if (p && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const zoom = p.start.zoom * ((Math.hypot(a.x - b.x, a.y - b.y) || 1) / p.dist);
      const scale = view / cropSide(img.width, img.height, zoom);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      set({ zoom, u: p.start.u - (mx - p.mx) / (scale * img.width), v: p.start.v - (my - p.my) / (scale * img.height) });
      return;
    }
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const scale = view / cropSide(img.width, img.height, d.start.zoom);
    set({ ...d.start, u: d.start.u - (e.clientX - d.x) / (scale * img.width), v: d.start.v - (e.clientY - d.y) / (scale * img.height) });
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    startGesture();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const side = cropSide(img.width, img.height, crop.zoom);
    const stepU = (side * 0.04) / img.width;
    const stepV = (side * 0.04) / img.height;
    const m: Record<string, Crop> = {
      ArrowLeft: { ...crop, u: crop.u - stepU },
      ArrowRight: { ...crop, u: crop.u + stepU },
      ArrowUp: { ...crop, v: crop.v - stepV },
      ArrowDown: { ...crop, v: crop.v + stepV },
      "+": { ...crop, zoom: crop.zoom * 1.1 },
      "=": { ...crop, zoom: crop.zoom * 1.1 },
      "-": { ...crop, zoom: crop.zoom / 1.1 },
      "0": { zoom: 1, u: 0.5, v: 0.5 },
    };
    const next = m[e.key];
    if (!next) return;
    e.preventDefault();
    set(next);
  };

  return (
    <div className="w-full max-w-[280px]">
      <div
        ref={boxRef}
        role="group"
        tabIndex={0}
        aria-label={`${label}. Drag or use arrow keys to move, pinch or plus and minus to zoom, 0 to reset.`}
        aria-roledescription="image crop"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKey}
        className="relative aspect-square w-full cursor-grab touch-none select-none overflow-hidden rounded-field border border-rule bg-paper-deep outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-signal/50 focus-visible:ring-offset-2 focus-visible:ring-offset-sheet"
      >
        {view > 0 && <img src={img.url} alt="" aria-hidden draggable={false} className="pointer-events-none" style={cropStyle(img, crop, view)} />}
        {/* circular mask + guides */}
        <span aria-hidden className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgba(15,15,13,0.55)]" />
        <span aria-hidden className="pointer-events-none absolute inset-0 rounded-full border border-paper/80" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-paper/25" />
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-paper/25" />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button type="button" aria-label="Zoom out" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-rule bg-sheet text-ink transition-colors hover:border-rule-strong disabled:opacity-40" disabled={crop.zoom <= 1.001} onClick={() => set({ ...crop, zoom: crop.zoom / 1.2 })}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M2 7h10" stroke="currentColor" strokeWidth="1.25" /></svg>
        </button>
        <label className="sr-only" htmlFor="crop-zoom">Zoom</label>
        <input
          id="crop-zoom"
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={crop.zoom}
          onChange={(e) => set({ ...crop, zoom: Number(e.target.value) })}
          aria-valuetext={`${crop.zoom.toFixed(1)} times`}
          className="h-11 min-w-0 flex-1 cursor-pointer accent-ink"
        />
        <button type="button" aria-label="Zoom in" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-rule bg-sheet text-ink transition-colors hover:border-rule-strong disabled:opacity-40" disabled={crop.zoom >= MAX_ZOOM - 0.001} onClick={() => set({ ...crop, zoom: crop.zoom * 1.2 })}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M2 7h10M7 2v10" stroke="currentColor" strokeWidth="1.25" /></svg>
        </button>
      </div>
      <p className={clsx("num mt-1 text-[11px] text-ink-muted")}>{crop.zoom.toFixed(2)}× · drag to position, pinch to zoom</p>
    </div>
  );
}
