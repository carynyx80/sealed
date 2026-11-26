"use client";
import { motion } from "framer-motion";
import clsx from "clsx";
import { SPRING } from "../motion/spring";

export function Toggle({ checked, onChange, label, id, tone = "ink" }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string; tone?: "ink" | "signal" | "gain" }) {
  const on = tone === "signal" ? "border-signal bg-signal" : tone === "gain" ? "border-gain bg-gain" : "border-ink bg-ink";
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={clsx("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors", checked ? on : "border-rule-strong bg-paper-deep")}
    >
      <motion.span layout transition={SPRING} className={clsx("mx-0.5 h-5 w-5 rounded-full bg-sheet shadow-[0_1px_2px_rgba(15,15,13,0.2)]", checked ? "ml-auto" : "")} />
    </button>
  );
}
