"use client";
import Link from "next/link";
import clsx from "clsx";
import type { ReactNode } from "react";
import type { Network, ProtocolStats } from "@sealed/shared";
import { useNow, useRevenue } from "@/lib/live";
import { IS_MAINNET, NETWORK } from "@/lib/config";
import { fmtAgo, fmtInt, fmtUsd } from "@/lib/format";
import { RollingNumber } from "../motion/RollingNumber";
import { FadeIn } from "../motion/FadeIn";
import { Skeleton } from "../ui/Skeleton";
import { FlameIcon } from "../ui/Icons";
import { DailyChart } from "./DailyChart";
import { BuybackTable, CreditLedgerTable, utcStamp } from "./Ledgers";

export function RevenueDashboard() {
  const { data } = useRevenue();
  const now = useNow();
  const network: Network = IS_MAINNET ? "mainnet" : data?.stats.network ?? NETWORK;
  const s = data?.stats;

  return (
    <div className="pb-16 pt-10 sm:pt-16">
      {/* masthead */}
      <header className="grid gap-8 border-b border-ink pb-8 lg:grid-cols-12 lg:items-end">
        <div className="lg:col-span-8">
          <p className="section-mark">§ Public ledger — Statement of protocol revenue</p>
          <h1 className="mt-4 text-display-lg text-ink">
            Revenue, credit
            <br /> &amp; <span className="accent">burn.</span>
          </h1>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-slate">
            Every fee, credit advance, repayment and buyback, posted as it happens and linked to the transaction that made it. Read it like a balance sheet; verify it on Solscan.
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 text-[12px] lg:col-span-4 lg:grid-cols-1">
          <MetaRow k="As of">{s ? utcStamp(s.updatedTs).slice(11) : "—"}</MetaRow>
          <MetaRow k="Date">{s ? utcStamp(s.updatedTs).slice(0, 10) : "—"}</MetaRow>
          <MetaRow k="Network">{network}</MetaRow>
          <MetaRow k="Source">
            <span className="inline-flex items-center gap-1.5">
              <span className={clsx("h-1.5 w-1.5 rounded-full", s ? "bg-gain motion-safe:animate-pulse-soft" : "bg-rule-strong")} />
              {!s ? "connecting" : s.isDemo ? "simulated" : "indexed"}
            </span>
          </MetaRow>
        </dl>
      </header>

      {!data || !s ? (
        <LoadingState />
      ) : (
        <>
          {/* § 01 headline figures */}
          <section aria-labelledby="h-figures" className="mt-10">
            <div className="flex items-baseline justify-between gap-4">
              <h2 id="h-figures" className="section-mark">§ 01 — Headline figures, cumulative</h2>
              <span className="num hidden text-[11px] text-ink-muted sm:inline">USD unless stated</span>
            </div>
            <div className="mt-3 grid gap-px border-y border-ink bg-rule sm:grid-cols-2 lg:grid-cols-4">
              <Figure i={0} label="Total protocol fees" note="1" value={<RollingNumber value={s.totalFeesUsd} format="usd" />}>
                on <span className="num text-ink-soft">{fmtUsd(s.totalVolumeUsd)}</span> traded volume
              </Figure>
              <Figure i={1} label="Credit deployed" note="2" value={<RollingNumber value={s.totalCreditDeployedUsd} format="usd" />}>
                <span className="num text-ink-soft">{fmtUsd(s.activeBuybackCreditUsd)}</span> still buying back
              </Figure>
              <Figure i={2} label="Credit repaid" note="3" value={<RollingNumber value={s.totalCreditRepaidUsd} format="usd" className="text-gain" />}>
                <Solvency stats={s} />
              </Figure>
              <Figure
                i={3}
                label={<span className="inline-flex items-center gap-1.5"><FlameIcon width={12} height={12} className="text-burn" /> Platform tokens burned</span>}
                note="4"
                value={<RollingNumber value={s.platformTokensBurned} format="compact" digits={2} />}
              >
                plus <span className="num text-ink-soft">{fmtUsd(s.totalTokensBurnedUsd)}</span> of launch tokens bought &amp; burned
              </Figure>
            </div>
            <ol className="mt-4 grid gap-x-8 gap-y-1 text-[11px] leading-relaxed text-ink-muted sm:grid-cols-2">
              <li><span className="num mr-1.5">1</span>1% pool fee on every trade, routed to each token&apos;s fee-collector PDA.</li>
              <li><span className="num mr-1.5">2</span>Fee-credit lines of 10–15% of raise, advanced into locked buyback vaults at graduation.</li>
              <li><span className="num mr-1.5">3</span>Solvency = credit-pool assets ÷ outstanding credit; ≥ 1.00× is fully covered.</li>
              <li><span className="num mr-1.5">4</span>Platform token, bought on the open market from flywheel fees and burned permanently.</li>
            </ol>
          </section>

          {/* § 02 night band — where fees go */}
          <FadeIn as="section" className="card-night mt-12 overflow-hidden">
            <div className="grid gap-10 p-6 sm:p-10 lg:grid-cols-12">
              <div className="lg:col-span-5">
                <p className="num text-[11px] uppercase tracking-[0.08em] text-night-muted">§ 02 — Fee waterfall</p>
                <h2 className="mt-4 text-display-md text-night-text">
                  Fees repay the credit first, then <span className="accent">pay holders</span> for good.
                </h2>
                <p className="mt-4 max-w-md text-[13px] leading-relaxed text-night-muted">
                  Each token&apos;s fees follow the same two-stage order, enforced by the program. Wallets that buy in the graduation slot are excluded from payouts.
                </p>
              </div>
              <div className="space-y-8 lg:col-span-7">
                <Waterfall
                  title="Priority 1 — until credit is 100% repaid"
                  parts={[
                    { pct: 80, label: "Credit repayment", tone: "bg-night-text" },
                    { pct: 20, label: "Platform burn & ops", tone: "bg-burn" },
                  ]}
                />
                <Waterfall
                  title="Priority 2 — permanent flywheel"
                  parts={[
                    { pct: 50, label: "Holder payouts", tone: "bg-gain" },
                    { pct: 35, label: "Platform buyback & burn", tone: "bg-burn" },
                    { pct: 15, label: "Treasury & credit pool", tone: "bg-night-muted" },
                  ]}
                />
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-px border-t border-night-rule bg-night-rule sm:grid-cols-3 lg:grid-cols-6">
              {(
                [
                  ["Holder payouts", fmtUsd(s.holderPayoutsUsd)],
                  ["Active credit", fmtUsd(s.activeBuybackCreditUsd)],
                  ["Live auctions", fmtInt(s.liveAuctions)],
                  ["Active vaults", fmtInt(s.activeVaults)],
                  ["Flywheels", fmtInt(s.graduatedFlywheels)],
                  ["Snipers excluded", fmtInt(s.snipersBlocked)],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="bg-night px-6 py-5 sm:px-8">
                  <dt className="text-[11px] text-night-muted">{k}</dt>
                  <dd className="num mt-1.5 text-xl text-night-text sm:text-2xl">{v}</dd>
                </div>
              ))}
            </dl>
          </FadeIn>

          {/* § 03 chart */}
          <FadeIn as="section" className="card mt-12 p-5 sm:p-8">
            <DailyChart daily={data.daily} />
          </FadeIn>

          {/* § 04 / § 05 ledgers */}
          <div className="mt-12 grid gap-12 lg:grid-cols-2 lg:gap-10">
            <FadeIn as="section" className="min-w-0">
              <LedgerHead mark="§ 04" title="Recent buybacks" count={Math.min(12, data.recentBuybacks.length)} now={now} ts={data.recentBuybacks[0]?.ts} />
              <BuybackTable rows={data.recentBuybacks.slice(0, 12)} network={network} now={now} />
              <p className="mt-3 text-[11px] text-ink-muted">Programmatic vault drips: quote asset spent on the open market, tokens received burned in the same transaction.</p>
            </FadeIn>
            <FadeIn as="section" className="min-w-0" delay={0.05}>
              <LedgerHead mark="§ 05" title="Credit ledger" count={Math.min(12, data.ledger.length)} now={now} ts={data.ledger[0]?.ts} />
              <CreditLedgerTable rows={data.ledger.slice(0, 12)} network={network} now={now} />
              <p className="mt-3 text-[11px] text-ink-muted">Advances out of, and repayments into, the Protocol Credit Pool, with flywheel distributions once a line is repaid.</p>
            </FadeIn>
          </div>

          <footer className="mt-14 flex flex-col gap-2 border-t border-ink pt-4 text-[11px] text-ink-muted sm:flex-row sm:items-baseline sm:justify-between">
            <p>
              {s.isDemo ? "Simulated figures on " : "Indexed from "}
              <span className="num text-ink-slate">{network}</span>. Transaction links open Solscan{network === "mainnet" ? "" : <> with <span className="num">?cluster={network === "localnet" ? "custom" : "devnet"}</span></>}.
            </p>
            <p className="num">
              Compiled {utcStamp(s.updatedTs)} · <Link className="underline decoration-rule-strong underline-offset-4 hover:text-ink" href="/">Lobby</Link>
            </p>
          </footer>
        </>
      )}
    </div>
  );
}

function MetaRow({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-rule py-2">
      <dt className="text-ink-muted">{k}</dt>
      <dd className="num text-right text-ink">{children}</dd>
    </div>
  );
}

function Figure({ i, label, note, value, children }: { i: number; label: ReactNode; note: string; value: ReactNode; children: ReactNode }) {
  return (
    <div
      className={clsx(
        "min-w-0 bg-paper py-6 sm:px-6",
        i % 2 === 0 && "sm:pl-0",
        i === 2 && "lg:pl-6",
        i === 3 && "lg:pr-0",
      )}
    >
      <p className="text-[13px] text-ink-slate">
        {label}
        <sup className="num ml-0.5 text-[9px] text-ink-muted">{note}</sup>
      </p>
      <p className="mt-4 text-[clamp(2.25rem,4.2vw,3.25rem)] leading-none tracking-[-0.045em] text-ink">{value}</p>
      <div className="mt-3 text-[12px] leading-relaxed text-ink-muted">{children}</div>
    </div>
  );
}

function Solvency({ stats }: { stats: ProtocolStats }) {
  const share = Math.min(100, (stats.totalCreditRepaidUsd / Math.max(1, stats.totalCreditDeployedUsd)) * 100);
  const ok = stats.solvencyRatio >= 1;
  return (
    <div>
      <div className="relative h-[7px]" role="img" aria-label={`${share.toFixed(1)}% of deployed credit repaid`}>
        <div className="absolute inset-x-0 top-[3px] h-px bg-rule-strong" />
        <div className="absolute left-0 top-[2px] h-[3px] bg-gain" style={{ width: `${share}%` }} />
        {[25, 50, 75].map((t) => <div key={t} className="absolute top-0 h-[7px] w-px bg-rule-strong" style={{ left: `${t}%` }} />)}
      </div>
      <p className="mt-2 flex items-baseline justify-between gap-2">
        <span><span className="num text-ink-soft">{share.toFixed(1)}%</span> of deployed</span>
        <span>
          solvency <span className={clsx("num", ok ? "text-gain" : "text-burn")}>{stats.solvencyRatio.toFixed(2)}×</span>
        </span>
      </p>
    </div>
  );
}

function Waterfall({ title, parts }: { title: string; parts: { pct: number; label: string; tone: string }[] }) {
  return (
    <div>
      <p className="text-[12px] text-night-muted">{title}</p>
      <div className="mt-3 flex h-2 w-full gap-[3px]">
        {parts.map((p) => <div key={p.label} className={p.tone} style={{ width: `${p.pct}%` }} />)}
      </div>
      <div className="mt-3 flex w-full gap-[3px]">
        {parts.map((p) => (
          <div key={p.label} className="min-w-0 border-l border-night-rule pl-2" style={{ width: `${p.pct}%` }}>
            <p className="num text-lg leading-none text-night-text sm:text-xl">{p.pct}%</p>
            <p className="mt-1 text-[11px] leading-snug text-night-muted">{p.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function LedgerHead({ mark, title, count, now, ts }: { mark: string; title: string; count: number; now: number | null; ts?: number }) {
  return (
    <div className="mb-1 flex items-end justify-between gap-3">
      <div>
        <p className="section-mark">{mark} — {count} most recent</p>
        <h2 className="mt-2 text-display-sm text-ink">{title}</h2>
      </div>
      <p className="num pb-1 text-right text-[11px] text-ink-muted">
        {ts && now !== null ? <>last entry {fmtAgo(ts, now)}</> : "—"}
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="mt-10" aria-busy="true" aria-label="Loading ledger">
      <div className="grid border-t border-ink sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className={clsx("border-b border-rule py-6 sm:px-6 lg:border-b-0", i > 0 && "lg:border-l", i % 2 === 0 && "sm:pl-0")}>
            <Skeleton className="h-3 w-28 rounded-sm" />
            <Skeleton className="mt-5 h-10 w-40 rounded-sm" />
            <Skeleton className="mt-4 h-3 w-36 rounded-sm" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-12 h-64 rounded-card" />
      <Skeleton className="mt-12 h-80 rounded-card" />
    </div>
  );
}

