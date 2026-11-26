"use client";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import { QUOTE_ASSETS, type LaunchSummary } from "@sealed/shared";
import { fmtAmount, fmtPrice, fmtUsd } from "@/lib/format";
import { useReducedMotion } from "@/components/motion/reduced";
import { SPRING } from "../motion/spring";
import { RollingNumber } from "../motion/RollingNumber";
import { QuoteBadge } from "../ui/QuoteBadge";
import { TokenAvatar } from "../ui/TokenAvatar";
import { ArrowUpRight } from "../ui/Icons";
import { PHASE_LABEL, HiddenAmountBadge } from "./AuctionCard";
import { ChangeTag, RepaidMini } from "./LiveCard";
import { LobbyCountdown } from "./Ticker";

const AUCTION_COLS = "grid-cols-[2.25rem_minmax(12rem,2.2fr)_5.5rem_5rem_4.5rem_4.5rem_minmax(7rem,1fr)_7.5rem_5.5rem_1rem]";
const LIVE_COLS = "grid-cols-[2.25rem_minmax(12rem,2fr)_5.5rem_minmax(7rem,1fr)_4.5rem_minmax(8rem,1fr)_minmax(9rem,1.2fr)_5.5rem_1rem]";

function Head({ cols, labels }: { cols: string; labels: (string | [string, "right"])[] }) {
  return (
    <div role="row" className={clsx("grid items-end gap-4 border-b border-ink pb-2.5", cols)}>
      {labels.map((l, i) => {
        const [text, align] = Array.isArray(l) ? l : [l, "left"];
        return (
          <span key={i} role="columnheader" className={clsx("eyebrow", align === "right" && "text-right")}>{text}</span>
        );
      })}
    </div>
  );
}

function TokenCell({ l }: { l: LaunchSummary }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <TokenAvatar src={l.imageUri} ticker={l.ticker} size={32} />
      <span className="min-w-0">
        <span className="block truncate font-semibold tracking-[-0.01em] text-ink">{l.name}</span>
        <span className="num block text-[11px] text-ink-muted">${l.ticker}</span>
      </span>
    </span>
  );
}

/** Desktop ledger view of the lobby: ruled rows, mono figures, hairline dividers. */
export function LobbyLedger({ tab, rows }: { tab: "auctions" | "vaults" | "graduated"; rows: LaunchSummary[] }) {
  const reduce = useReducedMotion();
  const auctions = tab === "auctions";
  const cols = auctions ? AUCTION_COLS : LIVE_COLS;
  return (
    <div role="table" aria-label="Lobby ledger" className="text-sm">
      {auctions ? (
        <Head cols={cols} labels={["No.", "Token", "Quote", "Phase", ["Bids", "right"], ["Wallets", "right"], ["Escrowed", "right"], "Px · size", ["Closes", "right"], ""]} />
      ) : (
        <Head cols={cols} labels={["No.", "Token", "Quote", ["Price", "right"], ["24h", "right"], ["Credit left", "right"], "Credit repaid", ["Vol 24h", "right"], ""]} />
      )}
      <div role="rowgroup">
        <AnimatePresence initial={false} mode="popLayout">
          {rows.map((l, i) => {
            const a = l.auction;
            const m = l.market;
            const reveal = l.status === "reveal";
            return (
              <motion.div
                key={l.id}
                role="row"
                layout={!reduce}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ ...SPRING, delay: Math.min(i, 10) * 0.025 }}
              >
                <Link href={`/token/${l.mint}`} className={clsx("group grid items-center gap-4 border-b border-rule py-3.5 transition-colors hover:bg-sheet focus-visible:bg-sheet", cols)}>
                  <span role="cell" className="num text-[11px] text-ink-muted">{String(i + 1).padStart(2, "0")}</span>
                  <span role="cell" className="min-w-0"><TokenCell l={l} /></span>
                  <span role="cell"><QuoteBadge symbol={l.quoteAsset} /></span>
                  {auctions ? (
                    <>
                      <span role="cell" className={clsx("font-mono text-[11px] uppercase tracking-[0.06em]", reveal ? "text-burn" : "text-ink-slate")}>{PHASE_LABEL[l.status]}</span>
                      <span role="cell" className="text-right"><RollingNumber value={a.bidCount} format="int" /></span>
                      <span role="cell" className="text-right"><RollingNumber value={a.escrowedWallets} format="int" /></span>
                      <span role="cell" className="num truncate text-right text-ink-slate">{fmtAmount(a.totalEscrowed)}</span>
                      <span role="cell"><HiddenAmountBadge seed={l.id} variant="plain" /></span>
                      <span role="cell" className="text-right text-base"><LobbyCountdown to={reveal ? a.revealEndTs : a.commitEndTs} /></span>
                    </>
                  ) : (
                    <>
                      <span role="cell" className="num truncate text-right">{m ? fmtPrice(m.price) : "—"}</span>
                      <span role="cell" className="text-right">{m ? <ChangeTag pct={m.change24hPct} /> : "—"}</span>
                      <span role="cell" className="num truncate text-right">{l.vault ? <RollingNumber value={l.vault.balance < 0.005 ? 0 : l.vault.balance} digits={l.vault.balance >= 1000 ? 0 : 2} /> : "—"}</span>
                      <span role="cell" className="min-w-0">{l.credit ? <RepaidMini pct={l.credit.repaidPct} short /> : <span className="text-ink-muted">—</span>}</span>
                      <span role="cell" className="num truncate text-right text-ink-slate">{m ? fmtUsd(m.volume24h * QUOTE_ASSETS[l.quoteAsset].demoUsdPrice) : "—"}</span>
                    </>
                  )}
                  <span role="cell" className="text-ink-muted transition-colors group-hover:text-ink" aria-hidden><ArrowUpRight width={14} height={14} /></span>
                </Link>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
