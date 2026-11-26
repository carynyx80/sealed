import { QUOTE_ASSETS, type QuoteAssetSymbol } from "@sealed/shared";
import clsx from "clsx";

const KIND_LABEL = { native: "Native", stable: "Stable", stock: "Tokenized stock" } as const;
const KIND_MARK = { native: "◎", stable: "$", stock: "§" } as const;

/** Quote-asset tag: mono ticker with a small kind glyph (◎ native · $ stable · § tokenized stock). */
export function QuoteBadge({ symbol, className, showKind = false }: { symbol: QuoteAssetSymbol; className?: string; showKind?: boolean }) {
  const q = QUOTE_ASSETS[symbol];
  return (
    <span className={clsx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-rule bg-sheet px-2 py-[5px] text-[11px] normal-case leading-none tracking-normal text-ink", className)} title={q.name}>
      <span aria-hidden className={clsx("flex h-3.5 w-3.5 items-center justify-center rounded-full font-mono text-[8px] leading-none", q.kind === "stock" ? "bg-ink text-paper" : q.kind === "stable" ? "border border-ink/60 text-ink" : "bg-paper-deep text-ink")}>{KIND_MARK[q.kind]}</span>
      <span className="num">{symbol}</span>
      {showKind && <span className="text-ink-muted">· {KIND_LABEL[q.kind]}</span>}
    </span>
  );
}
