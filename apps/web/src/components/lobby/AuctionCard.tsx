"use client";
import Link from "next/link";
import clsx from "clsx";
import type { LaunchSummary } from "@sealed/shared";
import { fmtAmount, fmtPrice } from "@/lib/format";
import { SpringCard } from "../motion/SpringCard";
import { RollingNumber } from "../motion/RollingNumber";
import { QuoteBadge } from "../ui/QuoteBadge";
import { TokenAvatar } from "../ui/TokenAvatar";
import { RingIcon } from "../ui/Icons";
import { LobbyCountdown, hash32, useElapsed } from "./Ticker";

export const PHASE_LABEL: Record<LaunchSummary["status"], string> = {
  commit: "Commit",
  reveal: "Reveal",
  clearing: "Clearing",
  live: "Vault live",
  flywheel: "Flywheel",
  failed: "Refunded",
};

/** "Amounts hidden" — redaction bars plus the ring glyph. */
export function HiddenAmountBadge({ seed, className, variant = "pill" }: { seed: string; className?: string; variant?: "pill" | "plain" }) {
  const h = hash32(seed);
  if (variant === "plain") {
    return (
      <span className={clsx("inline-flex items-center gap-2", className)} title="Bid prices and sizes are hidden until reveal">
        <RingIcon width={13} height={13} className="shrink-0 text-signal" />
        <span className="sr-only">Amounts hidden</span>
        <span aria-hidden className="flex items-center gap-1">
          <span className="redact h-[8px]" style={{ width: 28 + (h % 26) }} />
          <span className="redact-soft h-[8px]" style={{ width: 14 + ((h >>> 5) % 16) }} />
        </span>
      </span>
    );
  }
  return (
    <span className={clsx("inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-signal/25 bg-signal-tint px-2.5 py-[5px] text-[11px] font-medium leading-none text-signal-ink", className)}>
      <RingIcon width={12} height={12} />
      Amounts hidden
      <span aria-hidden className="flex items-center gap-[3px]">
        <span className="redact h-[7px]" style={{ width: 10 + (h % 10) }} />
        <span className="redact h-[7px]" style={{ width: 6 + ((h >>> 5) % 8) }} />
      </span>
    </span>
  );
}

export function AuctionCard({ launch, index }: { launch: LaunchSummary; index?: number }) {
  const a = launch.auction;
  const reveal = launch.status === "reveal";
  const clearing = launch.status === "clearing";
  const start = reveal ? a.commitEndTs : a.commitStartTs;
  const end = reveal ? a.revealEndTs : a.commitEndTs;
  const elapsed = useElapsed(start, end);
  return (
    <Link href={`/token/${launch.mint}`} className="block h-full rounded-card focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/40">
      <SpringCard className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-rule px-5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-muted">
          <span>Lot {index !== undefined ? String(index + 1).padStart(2, "0") : "—"} · <span className={reveal ? "text-burn" : "text-ink"}>{PHASE_LABEL[launch.status]}</span></span>
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
          <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-ink-slate">{launch.description}</p>
          <div className="mt-4">
            <HiddenAmountBadge seed={launch.id} />
          </div>

          <div className="mt-auto pt-6">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="eyebrow">{clearing ? "Clearing" : reveal ? "Reveal ends" : "Closes in"}</p>
                <p className="mt-1.5 text-[34px] leading-none tracking-[-0.03em]">
                  <LobbyCountdown to={end} />
                </p>
              </div>
              <div className="grid grid-cols-2 gap-x-5 text-right">
                <p className="eyebrow">Bids</p>
                <p className="eyebrow">Wallets</p>
                <RollingNumber value={a.bidCount} format="int" className="mt-1.5 block text-lg leading-none" />
                <RollingNumber value={a.escrowedWallets} format="int" className="mt-1.5 block text-lg leading-none" />
              </div>
            </div>
            <div className="mt-4 h-[2px] w-full bg-paper-deep" aria-hidden>
              <div className={clsx("h-full transition-[width] duration-1000 ease-linear", reveal ? "bg-burn" : "bg-ink")} style={{ width: `${(elapsed ?? 0) * 100}%` }} />
            </div>
            <p className="fine mt-3">
              Floor <span className="num text-ink-slate">{fmtPrice(a.floorPrice)}</span> · Target <span className="num text-ink-slate">{fmtAmount(a.targetRaise)}</span> {launch.quoteAsset}
            </p>
          </div>
        </div>
      </SpringCard>
    </Link>
  );
}
