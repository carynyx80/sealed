"use client";
import { useInView, type MotionProps } from "framer-motion";
import { useRef, type RefObject } from "react";
import { useReducedMotion } from "@/components/motion/reduced";
import { SPRING } from "@/components/motion/spring";

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Reveal-once motion props for SVG figures. One in-view trigger per figure (attach `ref` to the <svg>), so elements
 * that start at zero size (scaleX 0) still animate. With reduced motion, `initial` is false and the final state renders.
 */
export function useFig() {
  const ref = useRef<SVGSVGElement>(null);
  const inView = useInView(ref as RefObject<Element>, { once: true, margin: "-40px" });
  const reduce = useReducedMotion();
  const on = inView || reduce;
  // `as unknown as MotionProps`: pathLength is an SVG-only target the generic MotionProps type does not list.
  const make = (from: Record<string, number>, to: Record<string, number>, transition: object, style?: object): MotionProps =>
    ({ initial: reduce ? false : from, animate: on ? to : from, transition, ...(style ? { style } : {}) }) as unknown as MotionProps;
  return {
    ref,
    reduce,
    /** Stroke draws on. */
    draw: (delay = 0, duration = 1.1) =>
      make({ pathLength: 0, opacity: 0 }, { pathLength: 1, opacity: 1 }, { pathLength: { duration, delay, ease: EASE }, opacity: { duration: 0.2, delay } }),
    /** Fades in, optionally rising by `y`. */
    fade: (delay = 0, y = 0) => make({ opacity: 0, y }, { opacity: 1, y: 0 }, { ...SPRING, delay }),
    /** Grows horizontally from the left edge of its own box. */
    growX: (delay = 0) => make({ scaleX: 0 }, { scaleX: 1 }, { duration: 0.9, delay, ease: EASE }, { transformBox: "fill-box", originX: 0 }),
    /** Grows vertically from the bottom edge of its own box. */
    growY: (delay = 0) => make({ scaleY: 0 }, { scaleY: 1 }, { duration: 0.9, delay, ease: EASE }, { transformBox: "fill-box", originY: 1 }),
  };
}
