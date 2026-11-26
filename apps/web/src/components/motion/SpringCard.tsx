"use client";
import { motion } from "framer-motion";
import { useReducedMotion } from "@/components/motion/reduced";
import clsx from "clsx";
import type { ReactNode } from "react";
import { SPRING } from "./spring";

/** Hairline card that lifts 2px and darkens its rule on hover. Borders over shadows. */
export function SpringCard({ children, className, hover = true, layout = false }: { children: ReactNode; className?: string; hover?: boolean; layout?: boolean }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      layout={layout && !reduce}
      className={clsx("card transition-[border-color,box-shadow] duration-200", hover && "hover:border-rule-strong hover:shadow-lift", className)}
      whileHover={hover && !reduce ? { y: -2 } : undefined}
      transition={SPRING}
    >
      {children}
    </motion.div>
  );
}
