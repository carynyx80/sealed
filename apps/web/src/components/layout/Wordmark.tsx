import clsx from "clsx";
import { SealMark } from "../ui/SealMark";

export function Wordmark({ className, size = "md" }: { className?: string; size?: "md" | "lg" }) {
  return (
    <span className={clsx("inline-flex items-center gap-2.5 text-ink", className)}>
      <SealMark size={size === "lg" ? 40 : 26} />
      <span className={clsx("font-display font-extrabold leading-none tracking-[-0.045em]", size === "lg" ? "text-[44px]" : "text-[22px]")}>Sealed</span>
    </span>
  );
}
