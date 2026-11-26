"use client";
// Owned by web-offchain-agent. Internal (offchain ledger) balances as a ruled ledger with Deposit / Withdraw.
import Link from "next/link";
import clsx from "clsx";
import { isQuoteAssetSymbol, type BalanceRow } from "@sealed/shared";
import { openDeposit, openWithdraw, useCustodyAccount } from "@/lib/custody";
import { fmtUsd } from "@/lib/format";
import { IS_MAINNET } from "@/lib/config";
import { CustodyGate } from "./SignInButton";
import { assetUsd } from "./parts";

function fmtBal(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: n === 0 ? 2 : 0, maximumFractionDigits: n >= 1000 ? 2 : 6 });
}

export function BalancesPanel({ className }: { className?: string }) {
  return (
    <section className={clsx("card overflow-hidden", className)} aria-labelledby="balances-title">
      <div className="flex flex-wrap items-baseline justify-between gap-3 p-5 sm:p-6">
        <div>
          <p className="section-mark">§ 01 · Balances</p>
          <h2 id="balances-title" className="mt-2 font-display text-display-sm text-ink">Internal ledger</h2>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">Held by Sealed · recorded offchain</span>
      </div>
      <div className="px-5 pb-5 sm:px-6 sm:pb-6">
        <CustodyGate>
          <Rows />
        </CustodyGate>
      </div>
    </section>
  );
}

function Rows() {
  const acc = useCustodyAccount();
  if (!acc.data) {
    return acc.error ? (
      <p className="rounded-field border border-burn/20 bg-burn-tint p-3 text-[12px] text-burn">{acc.error}</p>
    ) : (
      <div className="space-y-2" aria-hidden>
        {[0, 1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-field bg-paper-deep" />)}
      </div>
    );
  }
  const rows = [...acc.data.balances].sort((a, b) => Number(b.asset.startsWith("tok:") ? 0 : 1) - Number(a.asset.startsWith("tok:") ? 0 : 1));
  const quote = rows.filter((r) => isQuoteAssetSymbol(r.asset));
  const totalUsd = quote.reduce((s, r) => s + assetUsd(r.asset as never, r.available + r.locked), 0);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4 border-t border-ink pt-4">
        <div>
          <p className="eyebrow">Quote assets · est. value</p>
          <p className="numeral mt-1 text-[2.5rem] leading-none text-ink sm:text-[3rem]">{fmtUsd(totalUsd, false)}</p>
          <p className="fine mt-1">{IS_MAINNET ? "At indicative reference prices" : "At demo reference prices"}; launched tokens excluded.</p>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <button type="button" className="btn-primary min-h-[44px] flex-1 sm:flex-none" onClick={() => openDeposit((quote[0]?.asset as "SOL") ?? "SOL")}>Deposit</button>
          <button type="button" className="btn-ghost min-h-[44px] flex-1 sm:flex-none" disabled={!quote.some((r) => r.available > 0)} onClick={() => openWithdraw((quote.find((r) => r.available > 0)?.asset as "SOL") ?? "SOL")}>Withdraw</button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="mt-5 border-t border-rule pt-4 text-[13px] leading-relaxed text-ink-slate">
          No balances yet. Deposit SOL or USDC to bid in sealed auctions and trade graduated tokens.
        </p>
      ) : (
        <div className="mt-5" role="table" aria-label="Balances">
          <div role="row" className="hidden grid-cols-[1.4fr_1fr_1fr_1fr_auto] gap-4 border-y border-rule py-2 sm:grid">
            {["Asset", "Available", "Locked", "≈ USD", ""].map((h, i) => (
              <span key={i} role="columnheader" className={clsx("eyebrow", i > 0 && i < 4 && "text-right")}>{h}</span>
            ))}
          </div>
          {rows.map((r) => <Row key={r.asset} r={r} />)}
        </div>
      )}
      <p className="fine mt-3">
        Locked = deposits backing open sealed bids and withdrawals not yet sent. Updated{" "}
        <span className="num">{new Date(acc.ts || Date.now()).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>.
      </p>
    </>
  );
}

function Row({ r }: { r: BalanceRow }) {
  const isQuote = isQuoteAssetSymbol(r.asset);
  const usd = isQuote ? assetUsd(r.asset as never, r.available + r.locked) : null;
  const launchId = r.launchId ?? (r.asset.startsWith("tok:") ? r.asset.slice(4) : null);
  return (
    <div role="row" className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-rule py-3 sm:grid-cols-[1.4fr_1fr_1fr_1fr_auto] sm:items-center sm:gap-4">
      <span role="cell" className="flex min-w-0 items-baseline gap-2">
        <span className="font-mono text-[13px] text-ink">{isQuote ? r.symbol : `$${r.symbol}`}</span>
        {!isQuote && <span className="eyebrow">token</span>}
      </span>
      <span role="cell" className="num text-right text-[14px] text-ink sm:text-right">
        {fmtBal(r.available)}
        <span className="ml-1 text-[10px] text-ink-muted sm:hidden">avail.</span>
      </span>
      <span role="cell" className="num text-[12px] text-ink-slate sm:text-right sm:text-[13px]">
        <span className="mr-1 text-[10px] text-ink-muted sm:hidden">locked</span>
        {fmtBal(r.locked)}
      </span>
      <span role="cell" className="num text-right text-[12px] text-ink-slate sm:text-[13px]">{usd === null ? "n/a" : fmtUsd(usd, false)}</span>
      <span role="cell" className="col-span-2 mt-1 flex justify-end gap-1.5 sm:col-span-1 sm:mt-0">
        {isQuote ? (
          <>
            <button type="button" className="chip min-h-[44px] px-3.5 hover:border-rule-strong hover:text-ink sm:min-h-[36px]" onClick={() => openDeposit(r.asset as "SOL")}>Deposit</button>
            <button type="button" className="chip min-h-[44px] px-3.5 hover:border-rule-strong hover:text-ink disabled:opacity-40 sm:min-h-[36px]" disabled={r.available <= 0} onClick={() => openWithdraw(r.asset as "SOL")}>Withdraw</button>
          </>
        ) : launchId ? (
          <Link href={`/token/${launchId}`} className="chip min-h-[44px] px-3.5 hover:border-rule-strong hover:text-ink sm:min-h-[36px]">Trade</Link>
        ) : null}
      </span>
    </div>
  );
}
