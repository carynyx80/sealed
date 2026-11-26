"use client";
import clsx from "clsx";
import { motion } from "framer-motion";
import type { LaunchSummary } from "@sealed/shared";
import { useNow } from "@/lib/live";
import { fmtInt } from "@/lib/format";
import { SPRING_SOFT } from "../motion/spring";

const STEPS = [
  { id: "commit", label: "Commit" },
  { id: "reveal", label: "Reveal" },
  { id: "clearing", label: "Clear" },
  { id: "live", label: "Graduate" },
] as const;

function stepIndex(s: LaunchSummary["status"]) {
  if (s === "commit") return 0;
  if (s === "reveal") return 1;
  if (s === "clearing") return 2;
  return 3;
}

/** Phase timeline Commit → Reveal → Clear → Graduate as a ruled scale, with progress through the current window. */
export function ClearingProgress({ launch, className }: { launch: LaunchSummary; className?: string }) {
  const now = useNow();
  const a = launch.auction;
  const idx = stepIndex(launch.status);
  let pct = 100;
  if (now !== null && launch.status === "commit") pct = ((now - a.commitStartTs) / Math.max(1, a.commitEndTs - a.commitStartTs)) * 100;
  else if (now !== null && launch.status === "reveal") pct = ((now - a.commitEndTs) / Math.max(1, a.revealEndTs - a.commitEndTs)) * 100;
  else if (now === null) pct = 0;
  pct = Math.max(0, Math.min(100, pct));
  return (
    <div className={clsx("space-y-3", className)}>
      <ol className="grid grid-cols-4">
        {STEPS.map((s, i) => {
          const fill = i < idx ? 100 : i === idx ? pct : 0;
          const current = i === idx;
          return (
            <li key={s.id} className="min-w-0">
              <div className="relative h-[3px] bg-rule" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill)} aria-label={`${s.label} progress`}>
                <motion.div
                  className={clsx("h-full", current && launch.status === "reveal" ? "bg-burn" : "bg-ink")}
                  initial={false}
                  animate={{ width: `${fill}%` }}
                  transition={SPRING_SOFT}
                />
                <span className="absolute -top-1 left-0 h-[11px] w-px bg-ink-slate" aria-hidden />
              </div>
              <span className={clsx("mt-2 block min-w-0 pr-1 font-mono text-[10px] uppercase tracking-[0.08em]", current ? "text-ink" : i < idx ? "text-ink-slate" : "text-ink-muted")}>
                {/* number above label: the four narrow columns never wrap unevenly (rail is ~300px at lg) */}
                <span className="block text-ink-muted">{String(i + 1).padStart(2, "0")}</span>
                <span className="block truncate">{s.label}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {launch.status === "reveal" && (
        <p className="text-[12px] text-ink-slate">
          <span className="num text-ink">{fmtInt(a.revealedCount)}</span> of <span className="num">{fmtInt(a.bidCount)}</span> bids revealed. The auto-reveal relayer submits sealed reveals the moment the window opens.
        </p>
      )}
    </div>
  );
}
