"use client";
import { useNow, useStats } from "@/lib/live";
import { fmtTime } from "@/lib/format";
import { RollingDigits } from "../motion/RollingDigits";
import { SealMark } from "../ui/SealMark";

/** Night band: the protocol's tape. Large odometer numerals, ruled columns, an "as of" stamp. */
export function StatsStrip() {
  const { data } = useStats();
  const now = useNow();
  const lead = [
    { label: "Total volume", value: data?.totalVolumeUsd, fmt: "usd" as const, note: "All pools, lifetime" },
    { label: "Active buyback credit", value: data?.activeBuybackCreditUsd, fmt: "usd" as const, note: "Locked in vaults now" },
    { label: "Total burned", value: data?.totalTokensBurnedUsd, fmt: "usd" as const, note: "Bought & burned, USD", burn: true },
  ];
  const minor = [
    { label: "Sealed auctions live", value: data?.liveAuctions },
    { label: "Active vaults", value: data?.activeVaults },
    { label: "Graduated flywheels", value: data?.graduatedFlywheels },
    { label: "Snipers blocked", value: data?.snipersBlocked },
  ];
  const repaid = data && data.totalCreditDeployedUsd > 0 ? (data.totalCreditRepaidUsd / data.totalCreditDeployedUsd) * 100 : null;

  return (
    <section aria-label="Protocol statistics" className="bleed bg-night text-night-text">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-night-rule pb-3 font-mono text-[10.5px] uppercase tracking-[0.08em] text-night-muted">
          <span className="flex items-center gap-2.5"><SealMark size={16} spin className="text-night-text" /> § 01 · Protocol tape</span>
          <span suppressHydrationWarning>As of {now !== null ? fmtTime(now) : "--:--:--"} · live</span>
        </div>

        <div className="grid md:grid-cols-3">
          {lead.map((s, i) => (
            <div key={s.label} className={`min-w-0 border-b border-night-rule py-7 md:border-b-0 md:py-9 ${i > 0 ? "md:border-l md:pl-8" : ""} ${i < 2 ? "md:pr-8" : ""}`}>
              <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-night-muted">{s.label}</p>
              <p className={`mt-4 text-[clamp(2.5rem,5.2vw,4.5rem)] leading-none tracking-[-0.04em] ${s.burn ? "text-burn-bright" : "text-night-text"}`}>
                {s.value !== undefined ? <RollingDigits value={s.value} format={s.fmt} /> : <span className="num text-night-muted">…</span>}
              </p>
              <p className="mt-3 text-[12px] text-night-muted">{s.note}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 border-t border-night-rule sm:grid-cols-5">
          {minor.map((s, i) => (
            <div key={s.label} className={`py-4 ${i % 2 === 1 ? "border-l border-night-rule pl-4" : ""} ${i >= 2 ? "border-t border-night-rule sm:border-t-0" : ""} sm:border-l sm:pl-5 ${i === 0 ? "sm:border-l-0 sm:pl-0" : ""}`}>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-night-muted">{s.label}</p>
              <p className="mt-1.5 text-2xl">{s.value !== undefined ? <RollingDigits value={s.value} format="int" /> : <span className="num text-night-muted">…</span>}</p>
            </div>
          ))}
          <div className="col-span-2 border-t border-night-rule py-4 sm:col-span-1 sm:border-l sm:border-t-0 sm:pl-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-night-muted">Credit repaid, all pools</p>
            <p className="mt-1.5 text-2xl">{repaid !== null ? <RollingDigits value={repaid} format="pct" /> : <span className="num text-night-muted">…</span>}</p>
            <div className="mt-2 h-[3px] w-full bg-night-rule">
              <div className="h-full bg-night-text transition-[width] duration-700" style={{ width: `${Math.min(100, repaid ?? 0)}%` }} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
