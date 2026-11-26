"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useReducedMotion } from "@/components/motion/reduced";
import Link from "next/link";
import clsx from "clsx";
import { useEffect, useMemo, useState } from "react";
import { QUOTE_ASSETS, type LaunchSummary } from "@sealed/shared";
import { useLaunches } from "@/lib/live";
import { PillTabs } from "../motion/PillTabs";
import { SPRING } from "../motion/spring";
import { Skeleton } from "../ui/Skeleton";
import { GridIcon, LedgerIcon } from "../ui/Icons";
import { AuctionCard } from "./AuctionCard";
import { LiveCard } from "./LiveCard";
import { LobbyLedger } from "./LobbyLedger";

type Tab = "auctions" | "vaults" | "graduated";
type QuoteFilter = "all" | "stocks" | "SOL" | "USDC";
type View = "ledger" | "cards";

const inTab = (l: LaunchSummary, t: Tab) =>
  t === "auctions" ? l.status === "commit" || l.status === "reveal" || l.status === "clearing" : t === "vaults" ? l.status === "live" : l.status === "flywheel";

const inQuote = (l: LaunchSummary, q: QuoteFilter) => (q === "all" ? true : q === "stocks" ? QUOTE_ASSETS[l.quoteAsset].kind === "stock" : l.quoteAsset === q);

const VIEW_KEY = "sealed.lobby.view";

export function LobbyGrid() {
  const { data, loading } = useLaunches();
  const [tab, setTab] = useState<Tab>("auctions");
  const [quote, setQuote] = useState<QuoteFilter>("all");
  const [view, setView] = useState<View>("ledger");
  const reduce = useReducedMotion();

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(VIEW_KEY);
      if (v === "ledger" || v === "cards") setView(v);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const chooseView = (v: View) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };

  const launches = data ?? [];
  const counts = useMemo(
    () => ({
      auctions: launches.filter((l) => inTab(l, "auctions") && inQuote(l, quote)).length,
      vaults: launches.filter((l) => inTab(l, "vaults") && inQuote(l, quote)).length,
      graduated: launches.filter((l) => inTab(l, "graduated") && inQuote(l, quote)).length,
    }),
    [launches, quote],
  );
  const shown = useMemo(() => {
    const xs = launches.filter((l) => inTab(l, tab) && inQuote(l, quote));
    if (tab === "auctions") xs.sort((a, b) => (a.status === "reveal" ? a.auction.revealEndTs : a.auction.commitEndTs) - (b.status === "reveal" ? b.auction.revealEndTs : b.auction.commitEndTs));
    else xs.sort((a, b) => (b.market?.volume24h ?? 0) * QUOTE_ASSETS[b.quoteAsset].demoUsdPrice - (a.market?.volume24h ?? 0) * QUOTE_ASSETS[a.quoteAsset].demoUsdPrice);
    return xs;
  }, [launches, tab, quote]);

  const isLoading = loading && !data;
  const empty = !isLoading && shown.length === 0;

  const cards = (
    <motion.div layout={!reduce} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {isLoading ? (
        Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[300px]" />)
      ) : (
        <AnimatePresence mode="popLayout" initial={false}>
          {shown.map((l, i) => (
            <motion.div
              key={l.id}
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
              transition={{ ...SPRING, delay: Math.min(i, 8) * 0.035 }}
            >
              {tab === "auctions" ? <AuctionCard launch={l} index={i} /> : <LiveCard launch={l} index={i} />}
            </motion.div>
          ))}
        </AnimatePresence>
      )}
    </motion.div>
  );

  return (
    <section id="lobby" className="scroll-mt-24 pt-20 sm:pt-28">
      <div className="grid gap-6 lg:grid-cols-12 lg:items-end">
        <div className="lg:col-span-7">
          <p className="section-mark">§ 04 — The lobby</p>
          <h2 className="mt-4 text-display-lg text-ink">
            What&apos;s on the <span className="accent">block</span> today
          </h2>
        </div>
        <p className="max-w-md text-[15px] leading-relaxed text-ink-slate lg:col-span-5 lg:justify-self-end">
          Sealed lots in their commit window, vaults buying back right now, and graduated tokens paying holders. Figures update live.
        </p>
      </div>

      <div className="mt-10">
        <PillTabs
          variant="rule"
          layoutId="lobby-tab"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "auctions", label: "Sealed Auctions Live", count: counts.auctions },
            { id: "vaults", label: "Active Buyback Vaults", count: counts.vaults },
            { id: "graduated", label: "Graduated Flywheels", count: counts.graduated },
          ]}
        />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="eyebrow hidden sm:inline">Quote</span>
            <PillTabs
              layoutId="lobby-quote"
              size="sm"
              value={quote}
              onChange={setQuote}
              tabs={[
                { id: "all", label: "All" },
                { id: "stocks", label: "Tokenized Stocks" },
                { id: "SOL", label: "SOL" },
                { id: "USDC", label: "USDC" },
              ]}
            />
          </div>
          <div className="hidden items-center gap-0.5 rounded-full border border-rule bg-sheet p-[3px] xl:inline-flex" role="group" aria-label="View">
            {(["ledger", "cards"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => chooseView(v)}
                className={clsx("inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium capitalize transition-colors", view === v ? "bg-ink text-paper" : "text-ink-slate hover:text-ink")}
              >
                {v === "ledger" ? <LedgerIcon width={13} height={13} /> : <GridIcon width={13} height={13} />}
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-8">
        {view === "ledger" ? (
          <>
            <div className="hidden xl:block">
              {isLoading ? (
                <div className="space-y-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
              ) : (
                !empty && (
                  <div className="no-scrollbar overflow-x-auto">
                    <div className="min-w-[66rem]">
                      <LobbyLedger tab={tab} rows={shown} />
                    </div>
                  </div>
                )
              )}
            </div>
            <div className="xl:hidden">{cards}</div>
          </>
        ) : (
          cards
        )}
      </div>

      {empty && (
        <div className="mt-2 grid gap-6 border-y border-rule py-12 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <p className="text-display-sm text-ink">Nothing on this page yet.</p>
            <p className="mt-2 max-w-md text-sm text-ink-slate">No launches match this filter right now. Try another quote asset, or open a sealed auction yourself.</p>
          </div>
          <Link href="/launch" className="btn-primary justify-self-start">Launch a token</Link>
        </div>
      )}
      <p className="fine mt-6">Bid amounts in sealed lots are hidden until the reveal window. Escrow totals are public on-chain. Vol 24h in USD at reference prices.</p>
    </section>
  );
}
