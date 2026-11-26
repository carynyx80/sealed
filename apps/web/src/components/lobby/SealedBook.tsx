"use client";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { useMemo } from "react";
import type { LaunchSummary } from "@sealed/shared";
import { fmtAmount, fmtInt } from "@/lib/format";
import { useReducedMotion } from "@/components/motion/reduced";
import { SPRING } from "../motion/spring";
import { LobbyCountdown, fakeHex, hash32 } from "./Ticker";
import { TokenAvatar } from "../ui/TokenAvatar";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ROWS = 7;

function wallet(seed: string) {
  let s = "";
  for (let i = 0; i < 8; i++) s += B58[hash32(`${seed}w${i}`) % B58.length];
  return `${s.slice(0, 4)}…${s.slice(4)}`;
}

const COLS = "grid-cols-[3.25rem_minmax(0,1fr)_4.25rem_3.25rem] sm:grid-cols-[3.5rem_5.5rem_minmax(0,1fr)_5rem_4rem]";

/**
 * "The sealed book": the live auction rendered as a printed order book whose prices and sizes are
 * redacted. Bid numbers, bidders and commitment hashes are illustrative (derived deterministically from
 * the launch + bid count) while the ticker, bid count, wallets, escrow total and countdown are live.
 */
export function SealedBook({ launch }: { launch: LaunchSummary | null }) {
  const reduce = useReducedMotion();
  const id = launch?.id ?? "sealed";
  const count = launch?.auction.bidCount ?? 0;
  const rows = useMemo(
    () =>
      Array.from({ length: launch ? Math.min(ROWS, Math.max(count, 0)) : ROWS }, (_, i) => {
        const n = (launch ? count : ROWS) - i;
        const seed = `${id}:${n}`;
        const h = hash32(seed);
        return { n, wallet: wallet(seed), commit: `0x${fakeHex(seed, 4)}…${fakeHex(`${seed}t`, 4)}`, price: 34 + (h % 58), size: 22 + ((h >>> 8) % 70) };
      }),
    [id, count, launch],
  );
  const a = launch?.auction;
  const reveal = launch?.status === "reveal";

  return (
    <div className="relative">
      {/* concentric seal behind the book, bleeding off its corner */}
      <svg aria-hidden viewBox="0 0 400 400" className="pointer-events-none absolute -right-20 -top-20 h-[300px] w-[300px] text-signal sm:-right-28 sm:-top-28 sm:h-[400px] sm:w-[400px]">
        <circle cx="200" cy="200" r="198" fill="none" stroke="currentColor" strokeOpacity=".16" />
        <circle cx="200" cy="200" r="160" fill="none" stroke="currentColor" strokeOpacity=".26" />
        <g className="origin-center animate-ring-slow motion-reduce:animate-none" style={{ transformBox: "fill-box" }}>
          <circle cx="200" cy="200" r="124" fill="none" stroke="currentColor" strokeOpacity=".7" strokeDasharray="3 7" />
        </g>
        <circle cx="200" cy="200" r="88" fill="none" stroke="currentColor" strokeOpacity=".34" />
      </svg>

      <Link
        href={launch ? `/token/${launch.mint}` : "#lobby"}
        aria-label={launch ? `Open the ${launch.name} sealed auction` : "Browse sealed auctions"}
        className="relative block overflow-hidden rounded-card border border-ink bg-sheet shadow-lift transition-transform duration-300 hover:-translate-y-0.5"
      >
        {/* masthead */}
        <div className="flex items-center justify-between gap-3 bg-ink px-4 py-2.5 text-paper sm:px-5">
          <span className="flex min-w-0 items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.08em]">
            {launch && <TokenAvatar src={launch.imageUri} ticker={launch.ticker} size={20} tone="dark" />}
            <span className="truncate">Sealed book <span className="text-paper/40">/</span> {launch ? `$${launch.ticker}` : "awaiting lot"}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-paper/70">
            <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-signal-bright" /> {reveal ? "Reveal" : "Commit"} window
          </span>
        </div>

        {/* headline numbers */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4 border-b border-rule px-4 pb-4 pt-5 sm:px-5">
          <div className="min-w-0">
            <p className="eyebrow">{reveal ? "Reveal closes in" : "Book closes in"}</p>
            <p className="mt-2 text-[44px] leading-none tracking-[-0.04em] sm:text-[56px]">{a ? <LobbyCountdown to={reveal ? a.revealEndTs : a.commitEndTs} /> : <span className="num">--:--</span>}</p>
          </div>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-right">
            <dt className="eyebrow">Bids</dt>
            <dt className="eyebrow">Wallets</dt>
            <dd className="num text-lg leading-none">{a ? fmtInt(count) : "…"}</dd>
            <dd className="num text-lg leading-none">{a ? fmtInt(a.escrowedWallets) : "…"}</dd>
          </dl>
        </div>

        {/* the book */}
        <div className="px-4 sm:px-5">
          <div className={`grid ${COLS} gap-3 border-b border-rule py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted`}>
            <span>No.</span>
            <span className="hidden sm:block">Bidder</span>
            <span>Commitment</span>
            <span>Max px</span>
            <span>Size</span>
          </div>
          <ul className="relative">
            <AnimatePresence initial={false}>
              {rows.map((r) => (
                <motion.li
                  key={r.n}
                  layout={!reduce}
                  initial={reduce ? false : { opacity: 0, y: -10, backgroundColor: "rgba(46,63,224,0.10)" }}
                  animate={{ opacity: 1, y: 0, backgroundColor: "rgba(46,63,224,0)" }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  transition={{ ...SPRING, backgroundColor: { duration: 1.8 } }}
                  className={`grid ${COLS} items-center gap-3 border-b border-rule py-[9px] text-[12px] last:border-b-0`}
                >
                  <span className="num text-ink-muted">#{String(Math.max(r.n, 0)).padStart(4, "0")}</span>
                  <span className="num hidden truncate text-ink-slate sm:block">{r.wallet}</span>
                  <span className="num truncate text-ink">{r.commit}</span>
                  <span className="flex"><span className="redact" style={{ width: `${r.price}%` }} /></span>
                  <span className="flex"><span className="redact-soft" style={{ width: `${r.size}%` }} /></span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </div>

        {/* clearing line */}
        <div className="mx-4 mb-1 mt-2 flex items-center gap-3 sm:mx-5" aria-hidden>
          <span className="flex-1 border-t border-dashed border-signal" />
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-signal">One clearing price · sealed</span>
          <span className="w-5 border-t border-dashed border-signal" />
        </div>

        {/* fine print */}
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-rule bg-paper px-4 py-3 sm:px-5">
          <span className="text-[11px] text-ink-slate">
            Escrowed (public) <span className="num text-ink">{a && launch ? `${fmtAmount(a.totalEscrowed)} ${launch.quoteAsset}` : "…"}</span>
          </span>
          <span className="fine">Prices &amp; sizes hidden until reveal¹</span>
        </div>
      </Link>
    </div>
  );
}
