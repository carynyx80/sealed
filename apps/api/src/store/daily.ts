import { QUOTE_ASSETS, type BuybackEvent, type CreditLedgerEntry, type ProtocolStats, type RevenueResponse } from "@sealed/shared";

type Daily = RevenueResponse["daily"];

function dayKey(ts: number) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function emptyDays(days: number, nowSec: number): Daily {
  const out: Daily = [];
  for (let i = days - 1; i >= 0; i--) out.push({ date: dayKey(nowSec - i * 86400), feesUsd: 0, creditRepaidUsd: 0, burnedUsd: 0, holderPayoutsUsd: 0 });
  return out;
}

/** Aggregate real ledger + buyback rows into a daily USD series (uses reference USD prices per quote asset). */
export function aggregateDaily(ledger: CreditLedgerEntry[], buybacks: BuybackEvent[], days: number, nowSec: number): Daily {
  const out = emptyDays(days, nowSec);
  const byDate = new Map(out.map((d) => [d.date, d]));
  for (const e of ledger) {
    const d = byDate.get(dayKey(e.ts));
    if (!d) continue;
    const usd = e.amount * QUOTE_ASSETS[e.quoteAsset].demoUsdPrice;
    if (e.kind === "repayment") {
      d.creditRepaidUsd += usd;
      d.feesUsd += usd / 0.8;
    } else if (e.kind === "flywheel_holder") {
      d.holderPayoutsUsd += usd;
      d.feesUsd += usd / 0.5;
    }
  }
  for (const b of buybacks) {
    const d = byDate.get(dayKey(b.ts));
    if (d) d.burnedUsd += b.quoteSpent * QUOTE_ASSETS[b.quoteAsset].demoUsdPrice;
  }
  return out;
}

/** Demo: spread lifetime totals over the window with a smooth growth curve so dashboard charts look realistic. */
export function syntheticDaily(stats: ProtocolStats, days: number, nowSec: number): Daily {
  const out = emptyDays(days, nowSec);
  const weights = out.map((_, i) => Math.pow(1.18, i) * (0.85 + 0.3 * Math.abs(Math.sin(i * 1.7))));
  const sum = weights.reduce((a, b) => a + b, 0);
  out.forEach((d, i) => {
    const w = weights[i]! / sum;
    d.feesUsd = stats.totalFeesUsd * w;
    d.creditRepaidUsd = stats.totalCreditRepaidUsd * w;
    d.burnedUsd = stats.totalTokensBurnedUsd * w;
    d.holderPayoutsUsd = stats.holderPayoutsUsd * w;
  });
  return out;
}
