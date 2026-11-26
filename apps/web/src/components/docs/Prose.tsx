/**
 * Docs typography + layout primitives (server-safe, no hooks). Every docs page is plain typed TSX built from these,
 * so the whole docs site shares one rhythm: § marks, hairline rules, mono numerals, one Caslon accent per headline.
 */
import clsx from "clsx";
import Link from "next/link";
import type { ReactNode } from "react";
import { scrollShade } from "./scrollShade";

/* ---------------------------------------------------------------- status */

export type Status = "live" | "chain-pending" | "chain-passing" | "offchain-passing" | "planned" | "partial" | "dev" | "rolling";

const STATUS: Record<Status, { label: string; cls: string; dot: string }> = {
  live: { label: "Live", cls: "border-gain/30 bg-gain-tint text-gain", dot: "bg-gain" },
  "chain-passing": { label: "On-chain · tests passing", cls: "border-ink/20 bg-sheet text-ink", dot: "bg-ink" },
  "chain-pending": { label: "On-chain · tests passing (not deployed)", cls: "border-rule-strong bg-sheet text-ink-soft", dot: "border border-ink-soft bg-transparent" },
  "offchain-passing": { label: "Off-chain · tests passing", cls: "border-rule-strong bg-sheet text-ink-soft", dot: "bg-ink-soft" },
  planned: { label: "Planned", cls: "border-dashed border-rule-strong bg-transparent text-ink-muted", dot: "bg-rule-strong" },
  dev: { label: "Live · needs operator key", cls: "border-signal/30 bg-signal-tint text-signal-ink", dot: "bg-signal" },
  rolling: { label: "Rolling out", cls: "border-dashed border-signal/40 bg-signal-tint text-signal-ink", dot: "bg-signal" },
  partial: { label: "Partial", cls: "border-burn/30 bg-burn-tint text-burn", dot: "bg-burn" },
};

export function StatusBadge({ status, label, className }: { status: Status; label?: string; className?: string }) {
  const s = STATUS[status];
  return (
    <span className={clsx("inline-flex max-w-full items-center gap-1.5 rounded-[9px] border px-2 py-0.5 font-mono text-[10px] uppercase leading-4 tracking-[0.06em] sm:whitespace-nowrap sm:rounded-full", s.cls, className)}>
      <span className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", s.dot)} aria-hidden />
      <span className="min-w-0">{label ?? s.label}</span>
    </span>
  );
}

export function StatusLegend() {
  const order: Array<[Status, string]> = [
    ["rolling", "Part of the switch to Solana mainnet. Being deployed now; check /api/health and /api/custody/info on the hosted API before relying on it."],
    ["live", "Built, tested and running in the production web app and API on Solana mainnet."],
    ["chain-pending", "Implemented in the Anchor program. anchor build succeeds, the 15 Rust unit tests and the 18-test anchor suite (with --features test-mode) pass locally. Not deployed."],
    ["offchain-passing", "TypeScript implementation with unit, invariant or e2e tests that pass today."],
    ["dev", "Built, tested and deployed on Railway, but only active once the operator has set its secret (COMPANY_WALLET_SECRET_KEY for payouts, HELIUS_API_KEY for deposit detection). /api/custody/info reports payoutsEnabled."],
    ["partial", "Code exists but a known gap stops it working end to end. The gap is described next to the badge."],
    ["planned", "Designed, not built."],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-3 border-y border-rule py-4 sm:grid-cols-2">
      {order.map(([s, d]) => (
        <div key={s} className="min-w-0">
          <dt>
            <StatusBadge status={s} />
          </dt>
          <dd className="mt-1.5 text-[13px] leading-relaxed text-ink-slate">{d}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------------------------------------------------------------- page header */

export function DocHeader({ n, kicker, title, lede, children }: { n: string; kicker: string; title: ReactNode; lede: ReactNode; children?: ReactNode }) {
  return (
    <header className="border-b border-ink pb-8">
      <p className="section-mark">
        § {n} · {kicker}
      </p>
      <h1 className="mt-4 text-display-lg [overflow-wrap:anywhere]">{title}</h1>
      <p className="mt-5 max-w-[40rem] text-[17px] leading-relaxed text-ink-slate">{lede}</p>
      {children && <div className="mt-6 flex flex-wrap gap-2">{children}</div>}
    </header>
  );
}

/** One Caslon-italic accent word inside a headline. */
export function Accent({ children }: { children: ReactNode }) {
  return <span className="accent">{children}</span>;
}

/* ---------------------------------------------------------------- headings + text */

export function H2({ id, n, children }: { id: string; n?: string; children: ReactNode }) {
  return (
    <h2 id={id} data-toc="2" className="group mt-14 scroll-mt-16 border-t border-rule pt-6 text-[1.6rem] font-bold leading-tight tracking-[-0.03em] text-ink lg:scroll-mt-4">
      {n && <span className="num mr-3 align-[0.2em] text-[11px] font-normal tracking-[0.08em] text-ink-muted">§ {n}</span>}
      <a href={`#${id}`} className="outline-none hover:underline hover:decoration-rule-strong hover:decoration-1 hover:underline-offset-[6px] focus-visible:underline">
        {children}
      </a>
    </h2>
  );
}

export function H3({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} data-toc="3" className="mt-9 scroll-mt-16 text-[1.125rem] font-semibold tracking-[-0.015em] text-ink lg:scroll-mt-4">
      <a href={`#${id}`} className="outline-none hover:underline hover:decoration-rule-strong hover:decoration-1 hover:underline-offset-4">
        {children}
      </a>
    </h3>
  );
}

export function P({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={clsx("mt-4 text-[15px] leading-[1.7] text-ink-soft", className)}>{children}</p>;
}

export function UL({ children }: { children: ReactNode }) {
  return <ul className="mt-4 space-y-2 text-[15px] leading-[1.65] text-ink-soft [&>li]:relative [&>li]:pl-5 [&>li]:before:absolute [&>li]:before:left-0 [&>li]:before:top-[0.72em] [&>li]:before:h-px [&>li]:before:w-2.5 [&>li]:before:bg-ink-muted">{children}</ul>;
}

export function OL({ children }: { children: ReactNode }) {
  return <ol className="mt-4 list-none space-y-3 text-[15px] leading-[1.65] text-ink-soft [counter-reset:step] [&>li]:relative [&>li]:pl-9 [&>li]:[counter-increment:step] [&>li]:before:absolute [&>li]:before:left-0 [&>li]:before:top-[0.2em] [&>li]:before:font-mono [&>li]:before:text-[11px] [&>li]:before:text-ink-muted [&>li]:before:content-[counter(step,decimal-leading-zero)]">{children}</ol>;
}

/** Inline code / identifiers. Breaks anywhere so long identifiers never force horizontal scroll. */
export function C({ children }: { children: ReactNode }) {
  return <code className="rounded-[4px] border border-rule bg-paper-deep px-[0.3em] py-[0.05em] font-mono text-[0.86em] text-ink [overflow-wrap:anywhere]">{children}</code>;
}

/** Mono numeral inline. */
export function N({ children }: { children: ReactNode }) {
  return <span className="num text-ink">{children}</span>;
}

export function A({ href, children }: { href: string; children: ReactNode }) {
  const external = /^https?:/.test(href);
  if (external)
    return (
      <a href={href} target="_blank" rel="noreferrer" className="font-medium text-ink underline decoration-rule-strong decoration-1 underline-offset-4 [overflow-wrap:anywhere] hover:decoration-ink">
        {children}
      </a>
    );
  return (
    <Link href={href} className="font-medium text-ink underline decoration-rule-strong decoration-1 underline-offset-4 [overflow-wrap:anywhere] hover:decoration-ink">
      {children}
    </Link>
  );
}

/** Repo path (not a link: the docs site does not assume a public repo URL). */
export function Path({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[0.86em] text-ink-slate [overflow-wrap:anywhere]">{children}</span>;
}

/* ---------------------------------------------------------------- blocks */

export function Note({ title, tone = "plain", children }: { title?: string; tone?: "plain" | "warn" | "signal"; children: ReactNode }) {
  return (
    <aside
      className={clsx(
        "mt-6 rounded-card border px-5 py-4 text-[14px] leading-relaxed",
        tone === "plain" && "border-rule bg-paper-deep text-ink-soft",
        tone === "warn" && "border-burn/30 bg-burn-tint/60 text-ink-soft",
        tone === "signal" && "border-signal/25 bg-signal-tint text-ink-soft",
      )}
    >
      {title && <p className={clsx("eyebrow mb-1.5", tone === "warn" && "text-burn", tone === "signal" && "text-signal")}>{title}</p>}
      <div className="[&>p+p]:mt-2">{children}</div>
    </aside>
  );
}

/** Display formula in mono. Wraps instead of scrolling. */
export function Formula({ children, caption }: { children: ReactNode; caption?: ReactNode }) {
  return (
    <figure className="mt-5 border-l-2 border-ink pl-4">
      <div className="font-mono text-[13px] leading-[1.9] text-ink [overflow-wrap:anywhere]">{children}</div>
      {caption && <figcaption className="fine mt-1">{caption}</figcaption>}
    </figure>
  );
}

export function Table({ head, rows, caption, dense, colClass }: { head: ReactNode[]; rows: ReactNode[][]; caption?: ReactNode; dense?: boolean; colClass?: string[] }) {
  return (
    <figure className="mt-6 min-w-0">
      <div className="max-w-full overflow-x-auto overscroll-x-contain rounded-card border border-rule [scrollbar-width:thin]" style={scrollShade()} tabIndex={0} role="region" aria-label="Table (scrolls horizontally on small screens)">
        <table className="w-full border-collapse text-left text-[13.5px]">
          <thead>
            <tr className="border-b border-rule bg-paper-deep/60">
              {head.map((h, i) => (
                <th key={i} scope="col" className={clsx("eyebrow whitespace-nowrap px-4 py-2.5 font-normal", colClass?.[i])}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-rule last:border-0 align-top">
                {r.map((c, j) => (
                  <td key={j} className={clsx("px-4 text-ink-soft", dense ? "py-2" : "py-3", colClass?.[j])}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {caption && <figcaption className="fine mt-2">{caption}</figcaption>}
    </figure>
  );
}

/** Two-column ruled ledger: term → description. */
export function Ledger({ items }: { items: Array<{ k: ReactNode; v: ReactNode; s?: Status; sLabel?: string }> }) {
  return (
    <dl className="mt-6 border-t border-ink">
      {items.map((it, i) => (
        <div key={i} className="grid gap-1 border-b border-rule py-3.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:gap-6">
          <dt className="min-w-0 text-[14px] font-semibold text-ink [overflow-wrap:anywhere]">{it.k}</dt>
          <dd className="min-w-0 text-[14px] leading-relaxed text-ink-soft">
            {it.s && (
              <span className="mb-1.5 block">
                <StatusBadge status={it.s} label={it.sLabel} />
              </span>
            )}
            {it.v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Big-numeral stat row, used sparingly as a graphic element. */
export function Figures({ items }: { items: Array<{ value: ReactNode; unit?: string; label: ReactNode }> }) {
  return (
    <div className="mt-6 grid grid-cols-2 border-t border-ink sm:grid-cols-4">
      {items.map((it, i) => (
        <div key={i} className={clsx("border-b border-rule py-4 pr-4", i % 2 === 1 && "border-l pl-4 sm:border-l-0 sm:pl-0", i > 0 && "sm:border-l sm:pl-4")}>
          <p className="numeral text-[2.1rem] leading-none text-ink">
            {it.value}
            {it.unit && <span className="num ml-1 align-top text-[12px] font-normal tracking-normal text-ink-muted">{it.unit}</span>}
          </p>
          <p className="mt-2 text-[12.5px] leading-snug text-ink-slate">{it.label}</p>
        </div>
      ))}
    </div>
  );
}

export function Figure({ children, caption, className }: { children: ReactNode; caption?: ReactNode; className?: string }) {
  return (
    <figure className={clsx("mt-6 min-w-0", className)}>
      <div className="rounded-card border border-rule bg-sheet p-3 max-sm:-mx-4 max-sm:rounded-none max-sm:border-x-0 sm:p-6">{children}</div>
      {caption && <figcaption className="fine mt-2">{caption}</figcaption>}
    </figure>
  );
}

export function Footnote({ children }: { children: ReactNode }) {
  return <p className="mt-3 font-serif text-[13px] italic leading-relaxed text-ink-slate">{children}</p>;
}
