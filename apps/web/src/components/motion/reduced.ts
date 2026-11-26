"use client";
import { useEffect, useState } from "react";
import { useReducedMotion as useFramerReducedMotion } from "framer-motion";

/**
 * Hydration-safe reduced-motion flag: `false` on the server and first client render (so markup
 * matches), then the real preference. Global <MotionConfig reducedMotion="user"> also neutralises
 * transform animations for users who prefer reduced motion.
 */
export function useReducedMotion(): boolean {
  const pref = useFramerReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? !!pref : false;
}
