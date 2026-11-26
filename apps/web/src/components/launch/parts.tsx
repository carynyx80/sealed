"use client";
import { motion } from "framer-motion";
import clsx from "clsx";
import type { KeyboardEvent, ReactNode } from "react";
import { QUOTE_ASSET_LIST, type QuoteAsset, type QuoteAssetSymbol } from "@sealed/shared";
import { IS_MAINNET } from "@/lib/config";
import { quoteAssetOffered } from "@/lib/quoteAssets";
import { SPRING } from "../motion/spring";
import { CheckIcon } from "../ui/Icons";

/** Underlined "typeset form" field. */
export const lineInput =
  "w-full rounded-none border-0 border-b border-rule bg-transparent px-0 py-2 text-ink outline-none transition-colors placeholder:text-ink-muted/80 hover:border-rule-strong focus:border-ink";

export function Clause({ n, label, hint, error, htmlFor, children, className }: { n: string; label: ReactNode; hint?: ReactNode; error?: string; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[3rem_minmax(0,1fr)]", className)}>
      <span className="num pt-0.5 text-[11px] text-ink-muted">{n}</span>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          {htmlFor ? (
            <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink-soft">{label}</label>
          ) : (
            <span className="text-[13px] font-medium text-ink-soft">{label}</span>
          )}
          {hint && <span className="num min-w-0 text-right text-[11px] text-ink-muted">{hint}</span>}
        </div>
        {children}
        {error && (
          <p role="alert" className="num mt-1.5 text-[11px] text-burn">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export function SectionHead({ mark, title, accent, lede }: { mark: string; title: string; accent: string; lede?: ReactNode }) {
  return (
    <header className="border-b border-rule pb-6">
      <p className="section-mark">{mark}</p>
      <h2 className="mt-3 text-display-md text-ink">
        {title} <span className="accent">{accent}</span>
      </h2>
      {lede && <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-slate">{lede}</p>}
    </header>
  );
}

const STEP_ROMAN = ["01", "02", "03"];

export function StepRail({ steps, step, onGo }: { steps: readonly string[]; step: number; onGo: (i: number) => void }) {
  return (
    <nav aria-label="Launch steps">
      <ol className="grid grid-cols-3 border-t border-rule">
        {steps.map((s, i) => {
          const state = i < step ? "done" : i === step ? "current" : "todo";
          return (
            <li key={s} className={clsx("relative", i > 0 && "border-l border-rule")}>
              {state === "current" && <motion.span layoutId="launch-step-rule" className="absolute inset-x-0 -top-px h-[2px] bg-ink" transition={SPRING} />}
              {state === "done" && <span className="absolute inset-x-0 -top-px h-px bg-ink" />}
              <button
                type="button"
                disabled={state === "todo"}
                onClick={() => state === "done" && onGo(i)}
                aria-current={state === "current" ? "step" : undefined}
                className={clsx("group block w-full px-2 pb-1 pt-3 text-left sm:px-4 sm:pt-4", state === "done" && "cursor-pointer", state === "todo" && "cursor-default")}
              >
                <span className={clsx("num flex items-center gap-1.5 text-[11px] tracking-[0.08em]", state === "todo" ? "text-ink-muted" : "text-ink")}>
                  § {STEP_ROMAN[i]}
                  {state === "done" && <CheckIcon width={11} height={11} className="text-gain" />}
                  <span className="hidden text-ink-muted sm:inline">· {state === "done" ? "complete" : state === "current" ? "in draft" : "pending"}</span>
                </span>
                <span className={clsx("mt-1 block truncate text-[13px] font-medium sm:text-base", state === "todo" ? "text-ink-muted" : "text-ink", state === "done" && "group-hover:underline group-hover:underline-offset-4")}>{s}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const KIND_LABEL: Record<QuoteAsset["kind"], string> = { native: "Native", stable: "Stablecoin", stock: "Tokenized equity" };

export function QuoteAssetList({ value, onChange }: { value: QuoteAssetSymbol; onChange: (s: QuoteAssetSymbol) => void }) {
  const offered = QUOTE_ASSET_LIST.filter((q) => quoteAssetOffered(q.symbol));
  const groups: { title: string; items: QuoteAsset[] }[] = [
    { title: "Currencies", items: offered.filter((q) => q.kind !== "stock") },
    { title: "Tokenized equities", items: offered.filter((q) => q.kind === "stock") },
  ].filter((g) => g.items.length > 0);
  const flat = groups.flatMap((g) => g.items);
  const onKey = (e: KeyboardEvent, sym: QuoteAssetSymbol) => {
    const i = flat.findIndex((q) => q.symbol === sym);
    const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = flat[(i + d + flat.length) % flat.length]!;
    onChange(next.symbol);
    document.getElementById(`quote-${next.symbol}`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Quote asset" className="mt-3 border-t border-ink">
      {groups.map((g) => (
        <div key={g.title}>
          <p className="eyebrow border-b border-rule py-2">{g.title}</p>
          {g.items.map((q) => {
            const on = q.symbol === value;
            return (
              <button
                key={q.symbol}
                id={`quote-${q.symbol}`}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                onClick={() => onChange(q.symbol)}
                onKeyDown={(e) => onKey(e, q.symbol)}
                className={clsx(
                  "group grid w-full grid-cols-[1rem_4.25rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-rule py-3 text-left outline-none transition-colors focus-visible:bg-signal-tint/60 sm:grid-cols-[1rem_5.5rem_minmax(0,1fr)_auto_5.5rem] sm:gap-4",
                  on ? "bg-paper/70" : "hover:bg-paper/50",
                )}
              >
                <span className={clsx("flex h-3.5 w-3.5 items-center justify-center rounded-full border transition-colors", on ? "border-ink" : "border-rule-strong group-hover:border-ink-muted")}>
                  {on && <motion.span layoutId="quote-dot" className="h-1.5 w-1.5 rounded-full bg-ink" transition={SPRING} />}
                </span>
                <span className={clsx("num text-sm", on ? "text-ink" : "text-ink-soft")}>{q.symbol}</span>
                <span className="min-w-0 truncate text-sm text-ink-slate">{q.name.replace(" (tokenized)", "")}</span>
                <span className="hidden text-[11px] text-ink-muted sm:block">{KIND_LABEL[q.kind]}</span>
                <span className="num text-right text-xs text-ink-muted">{IS_MAINNET ? "" : `$${q.demoUsdPrice.toFixed(2)}`}</span>
              </button>
            );
          })}
        </div>
      ))}
      <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
        {IS_MAINNET
          ? "Mainnet launches quote in SOL or USDC. Tokenized equities switch on once custody supports their token program. "
          : "Reference prices are indicative. "}
        Bidders escrow, and holders are later paid, in the asset chosen here.
      </p>
    </div>
  );
}

/** Term-sheet row. */
export function Term({ k, children, note }: { k: string; children: ReactNode; note?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-3 border-b border-rule py-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
      <dt className="text-[13px] text-ink-slate">
        {k}
        {note && <sup className="num ml-0.5 text-[9px] text-ink-muted">{note}</sup>}
      </dt>
      <dd className="num min-w-0 break-words text-[13px] text-ink">{children}</dd>
    </div>
  );
}
