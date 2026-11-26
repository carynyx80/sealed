"use client";
import Link from "next/link";
import clsx from "clsx";
import { QUOTE_ASSETS, type LaunchSummary } from "@sealed/shared";
import { fmtPct, fmtPrice, fmtUsd } from "@/lib/format";
import { SpringCard } from "../motion/SpringCard";
import { RollingNumber } from "../motion/RollingNumber";
import { QuoteBadge } from "../ui/QuoteBadge";
import { TokenAvatar } from "../ui/TokenAvatar";
import { Bar } from "../ui/Bar";
import { PHASE_LABEL } from "./AuctionCard";
import { LobbyCountdown } from "./Ticker";

export function ChangeTag({ pct, className }: { pct: number; className?: string }) {
  const up = pct >= 0;
  return (
    <span className={clsx("num inline-flex items-center gap-1 whitespace-nowrap text-xs", up ? "text-gain" : "text-burn", className)}>
      <span aria-hidden>{up ? "▲" : "▼"}</span>
      {fmtPct(Math.abs(pct), 1)}
    </span>
  );
}

/** Credit repaid mini bar with a 100% flip mark. */
export function RepaidMini({ pct, className, short = false }: { pct: number; className?: string; short?: boolean }) {
  const fly = pct >= 100;
  return (
    <div className={clsx("min-w-0", className)}>
      <div className="flex items-baseline justify-between gap-3 text-[11px]">
        <span className="truncate text-ink-slate">{short ? (fly ? "Flywheel on" : "Repaying") : fly ? "Credit repaid · flywheel on" : "Credit repaid"}</span>
        <RollingNumber value={Math.min(100, pct)} format="pct" className={fly ? "text-gain" : "text-ink"} />
      </div>
      <Bar pct={pct} height={4} tone={fly ? "gain" : "ink"} ticks className="mt-1.5" label="Credit repaid" />
    </div>
  );
}

export function LiveCard({ launch, index }: { launch: LaunchSummary; index?: number }) {
  const m = launch.market;
  const v = launch.vault;
  const fly = launch.status === "flywheel";
  return (
    <Link href={`/token/${launch.mint}`} className="block h-full rounded-card focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/40">
      <SpringCard className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-rule px-5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-muted">
          <span>No. {index !== undefined ? String(index + 1).padStart(2, "0") : "—"} · <span className={fly ? "text-gain" : "text-ink"}>{PHASE_LABEL[launch.status]}</span></span>
          <QuoteBadge symbol={launch.quoteAsset} />
        </div>
        <div className="flex flex-1 flex-col p-5">
          <div className="flex min-w-0 items-center gap-3">
            <TokenAvatar src={launch.imageUri} ticker={launch.ticker} size={40} />
            <div className="min-w-0">
              <p className="truncate text-display-sm text-ink">{launch.name}</p>
              <p className="num mt-0.5 text-xs text-ink-muted">${launch.ticker}</p>
            </div>
          </div>

          <div className="mt-5 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <p className="eyebrow">Price</p>
              <p className="mt-1.5 truncate text-[28px] leading-none tracking-[-0.03em]">
                <span className="num">{m ? fmtPrice(m.price) : "—"}</span> <span className="num text-xs tracking-normal text-ink-muted">{launch.quoteAsset}</span>
              </p>
            </div>
            <div className="text-right">
              <p className="eyebrow">24h</p>
              <div className="mt-1.5">{m ? <ChangeTag pct={m.change24hPct} /> : <span className="num text-xs text-ink-muted">—</span>}</div>
            </div>
          </div>
          {m && <p className="fine mt-1.5">MC <span className="num text-ink-slate">{fmtUsd(m.priceUsd * launch.totalSupply)}</span> · Vol 24h <span className="num text-ink-slate">{fmtUsd(m.volume24h * QUOTE_ASSETS[launch.quoteAsset].demoUsdPrice)}</span></p>}

          <div className="mt-auto space-y-3 pt-6">
            {v && (
              <div className="flex items-baseline justify-between gap-3 border-t border-rule pt-3 text-[11px]">
                <span className="text-ink-slate">Buyback credit remaining</span>
                <span className="whitespace-nowrap"><RollingNumber value={v.balance < 0.005 ? 0 : v.balance} digits={v.balance >= 1000 ? 0 : 2} className="text-ink" /> <span className="num text-ink-muted">{launch.quoteAsset}</span></span>
              </div>
            )}
            {v && !fly && v.balance > 0 && (
              <div className="flex items-baseline justify-between gap-3 text-[11px]">
                <span className="text-ink-slate">Next burn drip</span>
                <LobbyCountdown to={v.nextDripTs} className="text-ink" />
              </div>
            )}
            {launch.credit && <RepaidMini pct={launch.credit.repaidPct} />}
          </div>
        </div>
      </SpringCard>
    </Link>
  );
}
