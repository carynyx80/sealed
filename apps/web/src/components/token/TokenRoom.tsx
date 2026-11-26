"use client";
import Link from "next/link";
import clsx from "clsx";
import type { ReactNode } from "react";
import { CREDIT_TIERS, NUM_PRICE_TICKS, QUOTE_ASSETS, type LaunchSummary } from "@sealed/shared";
import { useLaunchRoom, useNow } from "@/lib/live";
import { fmtAmount, fmtCompact, fmtInt, fmtPct, fmtPrice, fmtTime, fmtUsd, shortAddr, solscanAccount } from "@/lib/format";
import { OneClickJupiterSwap } from "../swap/OneClickJupiterSwap";
import { CommitBidCard } from "../auction/CommitBidCard";
import { CommitRevealBadge, PrivacyBadge } from "../auction/CommitRevealBadge";
import { Countdown } from "../auction/Countdown";
import { BuybackCountdownCard } from "../vault/BuybackCountdownCard";
import { CreditRepayMeter } from "../vault/CreditRepayMeter";
import { RewardsCard } from "../vault/RewardsCard";
import { FadeIn } from "../motion/FadeIn";
import { RollingNumber } from "../motion/RollingNumber";
import { QuoteBadge } from "../ui/QuoteBadge";
import { TokenAvatar } from "../ui/TokenAvatar";
import { Skeleton } from "../ui/Skeleton";
import { ArrowUpRight } from "../ui/Icons";
import { PriceChart } from "./PriceChart";
import { TradeTape } from "./TradeTape";
import { FlywheelBreakdown } from "./FlywheelBreakdown";
import { LedgerRow, SealRing, SectionHead } from "./RoomParts";

/*
 * Token Room. Desktop: asymmetric 12-col bento (8 main / 4 rail). Mobile: one column whose order is set per item
 * (the two column wrappers become `display: contents` below lg so their children can interleave).
 */
/** Mobile stacking order (static class names so Tailwind can see them); lg+ falls back to DOM order. */
const ORDER = {
  1: "order-1 lg:order-none",
  2: "order-2 lg:order-none",
  3: "order-3 lg:order-none",
  4: "order-4 lg:order-none",
  5: "order-5 lg:order-none",
  6: "order-6 lg:order-none",
  7: "order-7 lg:order-none",
  8: "order-8 lg:order-none",
} as const;

export function TokenRoom({ idOrMint }: { idOrMint: string }) {
  const { data, loading, error } = useLaunchRoom(idOrMint);

  if (loading || (!data && !error)) return <RoomSkeleton />;
  if (!data?.launch) {
    return (
      <div className="py-24 sm:py-32">
        <p className="section-mark">§ Token room — 404</p>
        <h1 className="mt-4 max-w-3xl font-display text-display-lg text-ink">
          No launch at this <span className="accent">address.</span>
        </h1>
        <p className="num mt-5 break-all text-[13px] text-ink-muted">{idOrMint}</p>
        <Link href="/" className="btn-primary mt-8">Back to the lobby</Link>
      </div>
    );
  }
  const L = data.launch;
  const graduated = L.status === "live" || L.status === "flywheel";
  const ord = (n: keyof typeof ORDER) => ORDER[n];
  const vaultBuys = data.trades.filter((t) => t.isBuyback).length;

  return (
    <div className="pb-16 pt-6 sm:pt-10">
      <Masthead launch={L} />
      <KeyFigures launch={L} />

      <div className="mt-6 flex flex-col gap-4 sm:gap-5 lg:mt-8 lg:grid lg:grid-cols-12 lg:items-start lg:gap-6">
        {/* ------------------------------------------------------------------ main column */}
        <div className="contents lg:col-span-8 lg:flex lg:min-w-0 lg:flex-col lg:gap-6">
          {graduated ? (
            <>
              <FadeIn className={clsx("card min-w-0 p-5 sm:p-6", ord(3))}>
                <SectionHead
                  mark="01 — Price"
                  title={<><span className="num">{L.ticker}</span><span className="text-ink-muted"> / </span><span className="num">{L.quoteAsset}</span></>}
                  aside={<ChartLegend />}
                />
                <div className="mt-5">
                  <PriceChart points={data.chart} quote={L.quoteAsset} clearingPrice={L.auction.clearingPrice} height={300} />
                </div>
              </FadeIn>

              <div className="contents xl:grid xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] xl:items-start xl:gap-6">
                <FadeIn className={clsx("card min-w-0 p-5 sm:p-6", ord(5))}>
                  <SectionHead
                    mark="02 — Tape"
                    title="Trades & buybacks"
                    aside={
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-2 w-2 bg-gain" aria-hidden /> vault buy &amp; burn
                        <span className="text-ink-slate"> · {vaultBuys} of {Math.min(14, data.trades.length)}</span>
                      </span>
                    }
                  />
                  <div className="mt-5">
                    <TradeTape trades={data.trades} quote={L.quoteAsset} ticker={L.ticker} network={L.network} />
                  </div>
                  <p className="mt-3 font-mono text-[10px] leading-relaxed text-ink-muted">Each row links to Solscan. Programmatic buys execute from the vault on a fixed cadence and are burned in the same transaction.</p>
                </FadeIn>
                <FadeIn className={clsx("card min-w-0 p-5 sm:p-6", ord(8))} delay={0.04}>
                  <SectionHead mark="03 — Particulars" title="Market" />
                  <MarketParticulars launch={L} />
                </FadeIn>
              </div>

              <FadeIn className={clsx("card min-w-0 p-5 sm:p-6", ord(7))}>
                <SectionHead mark="04 — Fees" title={<>Holder <span className="accent">flywheel</span></>} aside={<span>1% pool fee · Fee Collector PDA</span>} />
                <div className="mt-4">
                  <FlywheelBreakdown launch={L} />
                </div>
              </FadeIn>
            </>
          ) : (
            <>
              <SealedBook launch={L} className={ord(2)} />
              <AuctionTerms launch={L} className={ord(3)} />
              <AfterAuction launch={L} className={ord(4)} />
              <FadeIn className={clsx("card min-w-0 p-5 sm:p-6", ord(5))}>
                <SectionHead mark="04 — Fees" title={<>Holder <span className="accent">flywheel</span></>} aside={<span>from the first trade</span>} />
                <div className="mt-4">
                  <FlywheelBreakdown launch={L} />
                </div>
              </FadeIn>
            </>
          )}
        </div>

        {/* ------------------------------------------------------------------ right rail */}
        <aside className="contents lg:col-span-4 lg:flex lg:min-w-0 lg:flex-col lg:gap-6" aria-label={graduated ? "Trade and vault" : "Auction"}>
          {graduated ? (
            <>
              <div className={clsx("min-w-0", ord(1))}>
                <OneClickJupiterSwap launch={L} />
              </div>
              <div className={clsx("min-w-0", ord(2))}>
                <BuybackCountdownCard launch={L} />
              </div>
              {L.credit && (
                <div className={clsx("min-w-0", ord(4))}>
                  <CreditRepayMeter credit={L.credit} quote={L.quoteAsset} />
                </div>
              )}
              <div className={clsx("min-w-0", ord(6))}>
                <RewardsCard launch={L} />
              </div>
            </>
          ) : L.status === "commit" || L.status === "reveal" ? (
            <div className={clsx("min-w-0", ord(1))}>
              <CommitBidCard launch={L} />
            </div>
          ) : (
            <section className={clsx("card min-w-0 p-5 sm:p-6", ord(1))}>
              <div className="flex items-center justify-between gap-2">
                <p className="section-mark">§ Auction — {L.status === "clearing" ? "Clearing" : "Closed"}</p>
                <CommitRevealBadge status={L.status} />
              </div>
              <h2 className="mt-3 font-display text-display-sm text-ink">
                {L.status === "clearing" ? <>Computing the <span className="accent">clearing</span> price</> : <>Refunds are <span className="accent">open</span></>}
              </h2>
              <p className="mt-3 text-[13px] leading-relaxed text-ink-slate">
                {L.status === "clearing"
                  ? "Reveals are closed. The uniform clearing price is being computed and the pool is about to graduate."
                  : "This auction did not reach its minimum. Every deposit is refundable in full."}
              </p>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- masthead */

function Masthead({ launch: L }: { launch: LaunchSummary }) {
  const now = useNow();
  const m = L.market;
  const graduated = L.status === "live" || L.status === "flywheel";
  const up = (m?.change24hPct ?? 0) >= 0;
  const vsClear = m && L.auction.clearingPrice ? ((m.price - L.auction.clearingPrice) / L.auction.clearingPrice) * 100 : null;

  return (
    <FadeIn>
      {/* dateline */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-ink pb-2.5 font-mono text-[11px] text-ink-muted">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-ink-slate transition-colors hover:text-ink">← Lobby</Link>
          <span aria-hidden>/</span>
          <span className="uppercase tracking-[0.08em]">Token room</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3">
          <a href={solscanAccount(L.mint, L.network)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 transition-colors hover:text-ink">
            mint {shortAddr(L.mint, 4)} <ArrowUpRight width={11} height={11} strokeWidth={1.25} />
          </a>
          <span className="hidden sm:inline">· {L.network}</span>
          <span className="hidden sm:inline">· as of <span className="num text-ink-slate">{now === null ? "--:--:--" : fmtTime(now)}</span></span>
        </div>
      </div>

      <div className="grid gap-x-10 gap-y-6 pt-6 sm:pt-8 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-7">
          <div className="flex flex-wrap items-center gap-2">
            <TokenAvatar src={L.imageUri} ticker={L.ticker} size={36} />
            <CommitRevealBadge status={L.status} />
            <QuoteBadge symbol={L.quoteAsset} showKind />
            {L.isDemo && <span className="rounded-full border border-dashed border-rule-strong px-2.5 py-1 font-mono text-[10px] uppercase leading-none tracking-[0.06em] text-ink-muted">Demo</span>}
          </div>
          <h1 className="mt-5 break-words font-display text-display-lg text-ink">{L.name}</h1>
          <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="num text-xl text-ink">${L.ticker}</span>
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">
              quoted in {QUOTE_ASSETS[L.quoteAsset].name}
            </span>
          </p>
          {L.description && <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-slate">{L.description}</p>}
        </div>

        <div className="min-w-0 border-t border-rule pt-5 lg:col-span-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-1">
          {graduated && m ? (
            <>
              <p className="eyebrow">Last price · {L.quoteAsset}</p>
              <p className="num mt-2 break-all text-[clamp(2.5rem,6vw,4.25rem)] leading-[0.95] tracking-[-0.04em] text-ink">{fmtPrice(m.price)}</p>
              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[13px]", up ? "bg-gain-tint text-gain" : "bg-burn-tint text-burn")}>
                  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden className={up ? "" : "rotate-180"}><path d="M4 0.5 7.5 7H0.5Z" fill="currentColor" /></svg>
                  {fmtPct(m.change24hPct, 2, true)}
                  <span className="text-[10px] opacity-70">24h</span>
                </span>
                <span className="num text-[13px] text-ink-slate">≈ {m.priceUsd < 0.01 ? `$${m.priceUsd.toPrecision(3)}` : fmtUsd(m.priceUsd, false)} USD</span>
              </div>
              {vsClear !== null && (
                <p className="mt-3 font-mono text-[11px] text-ink-muted">
                  <span className={vsClear >= 0 ? "text-gain" : "text-burn"}>{fmtPct(vsClear, 1, true)}</span> vs sealed clearing {fmtPrice(L.auction.clearingPrice ?? 0)}
                </p>
              )}
            </>
          ) : L.status === "commit" || L.status === "reveal" ? (
            <>
              <p className="eyebrow">{L.status === "reveal" ? "Reveal closes in" : "Commit closes in"}</p>
              <Countdown to={L.status === "reveal" ? L.auction.revealEndTs : L.auction.commitEndTs} className="mt-2 text-[clamp(2.75rem,7vw,4.75rem)] leading-[0.95] tracking-[-0.04em] text-ink" />
              <div className="mt-4 flex items-center gap-3">
                <SealRing size={26} />
                <p className="text-[13px] leading-snug text-ink-slate">
                  <span className="num text-ink">{fmtInt(L.auction.bidCount)}</span> sealed bids. Prices and sizes stay hidden until reveal.
                </p>
              </div>
            </>
          ) : (
            <>
              <p className="eyebrow">{L.status === "clearing" ? "Status" : "Outcome"}</p>
              <p className="mt-2 font-display text-display-md text-ink">{L.status === "clearing" ? "Clearing" : "Refunded in full"}</p>
              <p className="mt-2 font-mono text-[11px] text-ink-muted">{fmtInt(L.auction.revealedCount)} of {fmtInt(L.auction.bidCount)} bids revealed</p>
            </>
          )}
        </div>
      </div>
    </FadeIn>
  );
}

/* Hairline stat grid under the masthead. gap-px on a `rule` ground gives crisp 1px dividers at every breakpoint. */
function KeyFigures({ launch: L }: { launch: LaunchSummary }) {
  const q = L.quoteAsset;
  const a = L.auction;
  const m = L.market;
  const usd = QUOTE_ASSETS[q].demoUsdPrice;
  const cells: [string, ReactNode, ReactNode?][] = m
    ? [
        ["24h volume", <RollingNumber key="v" value={m.volume24h} />, q],
        ["Liquidity", fmtAmount(m.liquidityQuote), q],
        ["Market cap", fmtUsd(m.marketCapQuote * usd), "USD"],
        ["Holders", <RollingNumber key="h" value={m.holders} format="int" />],
        ["Clearing", fmtPrice(a.clearingPrice ?? 0), q],
        ["Raised sealed", fmtAmount(a.totalRaised ?? 0), q],
      ]
    : [
        ["Bids", <RollingNumber key="b" value={a.bidCount} format="int" />],
        ["Escrowed wallets", <RollingNumber key="w" value={a.escrowedWallets} format="int" />],
        ["Total escrowed", <RollingNumber key="e" value={a.totalEscrowed} />, q],
        ["For sale", fmtCompact(a.tokensForSale), L.ticker],
        ["Floor", fmtPrice(a.floorPrice), q],
        ["Target · cap", `${fmtCompact(a.targetRaise)}–${fmtCompact(a.clearingCap)}`, q],
      ];
  return (
    <FadeIn delay={0.04} className="mt-8">
      <dl className="grid grid-cols-2 gap-px border-y border-rule bg-rule sm:grid-cols-3 lg:grid-cols-6">
        {cells.map(([k, v, unit]) => (
          <div key={k} className="min-w-0 bg-paper px-3 py-3.5 sm:px-4 sm:py-4">
            <dt className="eyebrow">{k}</dt>
            <dd className="mt-1.5 flex min-w-0 items-baseline gap-1.5">
              <span className="num truncate text-lg text-ink sm:text-xl">{v}</span>
              {unit && <span className="shrink-0 font-mono text-[10px] text-ink-muted">{unit}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </FadeIn>
  );
}

function ChartLegend() {
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className="inline-flex items-center gap-1.5">
        <svg width="18" height="6" aria-hidden><line x1="0" x2="18" y1="3.5" y2="3.5" stroke="#0F0F0D" strokeWidth="1.25" /></svg> price
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="18" height="6" aria-hidden><line x1="0" x2="18" y1="3.5" y2="3.5" stroke="#5C5A54" strokeWidth="1" strokeDasharray="5 3" /></svg> sealed clearing
      </span>
      <span className="hidden sm:inline">5m bars</span>
    </span>
  );
}

function MarketParticulars({ launch: L }: { launch: LaunchSummary }) {
  const m = L.market!;
  const a = L.auction;
  const q = L.quoteAsset;
  return (
    <dl className="mt-4">
      <LedgerRow k="Price (USD)" v={`$${m.priceUsd.toPrecision(4)}`} />
      <LedgerRow k="Liquidity" v={`${fmtAmount(m.liquidityQuote)} ${q}`} note="locked LP" />
      <LedgerRow k="Clearing price" v={`${fmtPrice(a.clearingPrice ?? 0)} ${q}`} />
      <LedgerRow k="Raised" v={`${fmtAmount(a.totalRaised ?? 0)} ${q}`} note="sealed" />
      <LedgerRow k="Bids revealed" v={`${fmtInt(a.revealedCount)} / ${fmtInt(a.bidCount)}`} />
      <LedgerRow k="Credit tier" v={`${L.creditTier} · ${fmtPct(CREDIT_TIERS[L.creditTier] / 100, 1)}`} />
      <LedgerRow k="Creator allocation" v={`${(L.creatorAllocationBps / 100).toFixed(2)}%`} note="cap 2%" />
      <LedgerRow k="Graduation slot" v={fmtInt(m.graduationSlot)} />
      <LedgerRow
        k="Creator"
        v={
          <a className="underline decoration-rule-strong underline-offset-2 transition-colors hover:text-ink hover:decoration-ink" href={solscanAccount(L.creator, L.network)} target="_blank" rel="noreferrer">
            {shortAddr(L.creator)}
          </a>
        }
      />
    </dl>
  );
}

/* ---------------------------------------------------------------------------------------- auction sections */

const REDACT = [72, 54, 88, 61, 79, 46, 68, 83];

function SealedBook({ launch: L, className }: { launch: LaunchSummary; className?: string }) {
  const a = L.auction;
  const rows = Math.min(8, Math.max(3, a.bidCount));
  return (
    <FadeIn className={clsx("card min-w-0 p-5 sm:p-6", className)}>
      <SectionHead mark="01 — Order book" title={<>The book is <span className="accent">sealed</span></>} aside={<PrivacyBadge />} />
      <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-ink-slate">
        Every bid is a keccak256 commitment. Nobody (not the creator, not the protocol) can read a price or a size until the reveal window, so there is nothing to copy or front-run.
      </p>

      <div className="mt-5 grid grid-cols-[2rem_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.8fr)] gap-x-3 border-b border-ink pb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
        <span>#</span>
        <span>Max price</span>
        <span>Amount</span>
        <span className="text-right">State</span>
      </div>
      <ul aria-label={`${a.bidCount} sealed bids; contents hidden`}>
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="grid grid-cols-[2rem_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.8fr)] items-center gap-x-3 border-b border-rule py-2.5" aria-hidden>
            <span className="num text-[11px] text-ink-muted">{String(i + 1).padStart(3, "0")}</span>
            <span className="h-2.5 bg-ink" style={{ width: `${REDACT[i % REDACT.length]}%` }} />
            <span className="h-2.5 bg-ink" style={{ width: `${REDACT[(i + 3) % REDACT.length]! - 8}%` }} />
            <span className="text-right font-mono text-[10px] uppercase tracking-[0.06em] text-signal">sealed</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <SealRing size={22} />
          <p className="font-mono text-[11px] text-ink-muted">
            showing {rows} of <span className="text-ink">{fmtInt(a.bidCount)}</span> commitments
          </p>
        </div>
        <p className="font-mono text-[11px] text-ink-muted">
          public escrow <span className="num text-ink">{fmtAmount(a.totalEscrowed)}</span> {L.quoteAsset}
        </p>
      </div>
    </FadeIn>
  );
}

function AuctionTerms({ launch: L, className }: { launch: LaunchSummary; className?: string }) {
  const a = L.auction;
  const q = L.quoteAsset;
  const commitMin = Math.round((a.commitEndTs - a.commitStartTs) / 60);
  const revealMin = Math.round((a.revealEndTs - a.commitEndTs) / 60);
  return (
    <FadeIn className={clsx("card min-w-0 p-5 sm:p-6", className)}>
      <SectionHead mark="02 — Terms" title="Auction terms" aside={<span>enforced on-chain</span>} />
      <div className="mt-4 grid gap-x-10 md:grid-cols-2">
        <dl>
          <LedgerRow k="Floor price" v={`${fmtPrice(a.floorPrice)} ${q}`} />
          <LedgerRow k="Tick size" v={`${fmtPrice(a.tickSize)} ${q}`} note={`${NUM_PRICE_TICKS} ticks`} />
          <LedgerRow k="Tokens for sale" v={fmtCompact(a.tokensForSale, 2)} />
          <LedgerRow k="Total supply" v={fmtCompact(L.totalSupply, 2)} />
        </dl>
        <dl className="border-t border-rule md:border-t-0">
          <LedgerRow k="Target raise" v={`${fmtAmount(a.targetRaise)} ${q}`} />
          <LedgerRow k="Clearing cap" v={`${fmtAmount(a.clearingCap)} ${q}`} />
          <LedgerRow k="Windows" v={`${commitMin}m commit · ${revealMin}m reveal`} />
          <LedgerRow k="Creator allocation" v={`${(L.creatorAllocationBps / 100).toFixed(2)}%`} note="cap 2%" />
        </dl>
      </div>
    </FadeIn>
  );
}

function AfterAuction({ launch: L, className }: { launch: LaunchSummary; className?: string }) {
  const pct = CREDIT_TIERS[L.creditTier] / 100;
  return (
    <FadeIn className={clsx("card-night min-w-0 p-5 sm:p-7", className)}>
      <SectionHead night mark="03 — At graduation" title={<>Day-one <span className="accent">buyback</span> credit</>} aside={<span className="uppercase">{L.creditTier} tier</span>} />
      <div className="mt-6 grid items-end gap-6 sm:grid-cols-[auto_minmax(0,1fr)]">
        <p className="num text-[clamp(3.5rem,9vw,6rem)] leading-[0.85] tracking-[-0.05em] text-night-text">
          {pct.toFixed(pct % 1 ? 1 : 0)}
          <span className="text-[0.4em] text-night-muted">%</span>
        </p>
        <p className="max-w-md text-[13px] leading-relaxed text-night-muted">
          of the raise is advanced by the Credit Pool into a locked, non-withdrawable vault. From the first block of trading it buys and burns{" "}
          <span className="num text-night-text">${L.ticker}</span> every few minutes. Fees then repay the credit, 80/20, until the permanent holder flywheel switches on.
        </p>
      </div>
    </FadeIn>
  );
}

/* ---------------------------------------------------------------------------------------------- skeleton */

function RoomSkeleton() {
  return (
    <div className="pb-16 pt-6 sm:pt-10" aria-busy="true" aria-label="Loading token room">
      <Skeleton className="h-4 w-full rounded-none" />
      <div className="mt-8 grid gap-8 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-7">
          <Skeleton className="h-7 w-64 rounded-full" />
          <Skeleton className="h-16 w-4/5 rounded-field" />
          <Skeleton className="h-5 w-40 rounded-field" />
        </div>
        <div className="space-y-3 lg:col-span-5">
          <Skeleton className="h-4 w-32 rounded-field" />
          <Skeleton className="h-16 w-3/4 rounded-field" />
        </div>
      </div>
      <Skeleton className="mt-8 h-20 w-full rounded-none" />
      <div className="mt-8 grid gap-6 lg:grid-cols-12">
        <div className="space-y-6 lg:col-span-8">
          <Skeleton className="h-96 rounded-card" />
          <Skeleton className="h-72 rounded-card" />
        </div>
        <div className="space-y-6 lg:col-span-4">
          <Skeleton className="h-[420px] rounded-card" />
          <Skeleton className="h-64 rounded-card" />
        </div>
      </div>
    </div>
  );
}
