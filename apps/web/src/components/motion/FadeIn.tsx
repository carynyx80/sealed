"use client";
import { motion } from "framer-motion";
import { useReducedMotion } from "@/components/motion/reduced";
import type { ReactNode } from "react";
import { SPRING } from "./spring";

export function FadeIn({ children, delay = 0, y = 16, className, as = "div" }: { children: ReactNode; delay?: number; y?: number; className?: string; as?: "div" | "section" | "li" }) {
  const reduce = useReducedMotion();
  const M = as === "section" ? motion.section : as === "li" ? motion.li : motion.div;
  return (
    <M
      className={className}
      initial={reduce ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ ...SPRING, delay }}
    >
      {children}
    </M>
  );
}
