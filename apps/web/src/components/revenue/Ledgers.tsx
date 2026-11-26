"use client";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import type { ReactNode } from "react";
import { QUOTE_ASSETS, type BuybackEvent, type CreditLedgerEntry, type CreditLedgerKind, type Network } from "@sealed/shared";
import { useReducedMotion } from "@/components/motion/reduced";
import { fmtAgo, fmtAmount, fmtCompact, fmtUsd, shortAddr, solscanTx } from "@/lib/format";
import { SPRING } from "../motion/spring";
import { ArrowUpRight } from "../ui/Icons";
import { TokenAvatar } from "../ui/TokenAvatar";

export const utcStamp = (ts: number) => {
  const iso = new Date(ts * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
};

const KIND: Record<CreditLedgerKind, { label: string; mark: string }> = {
  advance: { label: "Credit advance", mark: "bg-ink" },
  repayment: { label: "Repayment", mark: "bg-gain" },
  flywheel_holder: { label: "Holder payout", mark: "bg-gain" },
  flywheel_platform_burn: { label: "Platform burn", mark: "bg-burn" },
  flywheel_treasury: { label: "Treasury", mark: "bg-ink-muted" },
  platform_ops: { label: "Platform ops", mark: "bg-ink-muted" },
};

const th = "pb-2 pt-3 text-[10px] font-normal uppercase tracking-[0.08em] text-ink-muted font-mono";
const td = "py-2.5 align-top";

function TxLink({ sig, network }: { sig: string; network: Network }) {
  return (
    <a
      href={solscanTx(sig, network)}
      target="_blank"
      rel="noreferrer"
      title={`View ${sig} on Solscan`}
      className="num inline-flex items-center gap-1 text-ink-slate decoration-rule-strong underline-offset-4 hover:text-ink hover:underline"
    >
      {shortAddr(sig, 4)}
      <ArrowUpRight width={11} height={11} className="shrink-0" />
    </a>
  );
}

function Row({ id, children, reduce }: { id: string; children: ReactNode; reduce: boolean }) {
  return (
    <motion.tr
      key={id}
      layout={reduce ? false : "position"}
      initial={reduce ? false : { opacity: 0, backgroundColor: "rgba(10,125,82,0.10)" }}
      animate={{ opacity: 1, backgroundColor: "rgba(10,125,82,0)" }}
      transition={{ ...SPRING, backgroundColor: { duration: 1.6 } }}
      className="border-b border-rule"
    >
      {children}
    </motion.tr>
  );
}

/** launchId to imageUri, so ledger rows can show each token's mark. */
export type TokenImages = Record<string, string>;

export function BuybackTable({ rows, network, now, images = {} }: { rows: BuybackEvent[]; network: Network; now: number | null; images?: TokenImages }) {
  const reduce = useReducedMotion();
  return (
    <table className="w-full table-fixed text-[12px]">
      <thead>
        <tr className="border-b border-ink text-left">
          <th className={clsx(th, "w-[22%] sm:w-[16%]")}>Time</th>
          <th className={th}>Token</th>
          <th className={clsx(th, "w-[30%] text-right sm:w-[24%]")}>Spent</th>
          <th className={clsx(th, "hidden w-[18%] text-right sm:table-cell")}>Burned</th>
          <th className={clsx(th, "w-[25%] text-right sm:w-[20%]")}>Tx</th>
        </tr>
      </thead>
      <tbody>
        <AnimatePresence initial={false}>
          {rows.map((b) => (
            <Row key={b.id} id={b.id} reduce={reduce}>
              <td className={clsx(td, "num text-ink-muted")} title={utcStamp(b.ts)}>{now === null ? "…" : fmtAgo(b.ts, now)}</td>
              <td className={clsx(td, "truncate")}>
                <TokenAvatar src={images[b.launchId]} ticker={b.ticker} size={18} className="mr-1.5 align-[-4px]" />
                <span className="font-medium text-ink">${b.ticker}</span>
                <span className="num ml-1.5 hidden text-[10px] text-ink-muted sm:inline">#{b.dripIndex}</span>
              </td>
              <td className={clsx(td, "num truncate text-right text-ink")}>
                {fmtAmount(b.quoteSpent)} <span className="text-ink-muted">{b.quoteAsset}</span>
              </td>
              <td className={clsx(td, "num hidden truncate text-right text-burn sm:table-cell")}>{fmtCompact(b.tokensBurned, 2)}</td>
              <td className={clsx(td, "text-right")}><TxLink sig={b.signature} network={network} /></td>
            </Row>
          ))}
        </AnimatePresence>
      </tbody>
    </table>
  );
}

export function CreditLedgerTable({ rows, network, now, images = {} }: { rows: CreditLedgerEntry[]; network: Network; now: number | null; images?: TokenImages }) {
  const reduce = useReducedMotion();
  return (
    <table className="w-full table-fixed text-[12px]">
      <thead>
        <tr className="border-b border-ink text-left">
          <th className={clsx(th, "hidden w-[16%] sm:table-cell")}>Time</th>
          <th className={th}>Entry</th>
          <th className={clsx(th, "w-[20%] sm:w-[17%]")}>Token</th>
          <th className={clsx(th, "w-[30%] text-right sm:w-[26%]")}>Amount</th>
          <th className={clsx(th, "w-[25%] text-right sm:w-[20%]")}>Tx</th>
        </tr>
      </thead>
      <tbody>
        <AnimatePresence initial={false}>
          {rows.map((e) => (
            <Row key={e.id} id={e.id} reduce={reduce}>
              <td className={clsx(td, "num hidden text-ink-muted sm:table-cell")} title={utcStamp(e.ts)}>{now === null ? "…" : fmtAgo(e.ts, now)}</td>
              <td className={clsx(td, "truncate")}>
                <span className={clsx("mr-2 inline-block h-1.5 w-1.5 -translate-y-px", KIND[e.kind].mark)} aria-hidden />
                <span className="text-ink-soft">{KIND[e.kind].label}</span>
              </td>
              <td className={clsx(td, "truncate font-medium text-ink")}>
                <TokenAvatar src={images[e.launchId]} ticker={e.ticker} size={18} className="mr-1.5 hidden align-[-4px] sm:inline-flex" />
                ${e.ticker}
              </td>
              <td className={clsx(td, "text-right")}>
                <span className="num block truncate text-ink">{fmtAmount(e.amount)} <span className="text-ink-muted">{e.quoteAsset}</span></span>
                <span className="num block text-[10px] text-ink-muted">≈ {fmtUsd(e.amount * QUOTE_ASSETS[e.quoteAsset].demoUsdPrice)}</span>
              </td>
              <td className={clsx(td, "text-right")}><TxLink sig={e.signature} network={network} /></td>
            </Row>
          ))}
        </AnimatePresence>
      </tbody>
    </table>
  );
}
