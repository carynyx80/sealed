import type { Network, QuoteAssetSymbol } from "@sealed/shared";
import { explorerAccountUrl, explorerTxUrl } from "./config";

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

/** Compact number: 1.2K, 3.4M, 5.6B. */
export function fmtCompact(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(digits)}K`;
  return `${sign}${abs.toFixed(abs >= 100 ? 0 : abs >= 10 ? 1 : 2)}`;
}

export function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
}

export function fmtUsd(n: number, compact = true): string {
  if (!Number.isFinite(n)) return "—";
  if (compact && Math.abs(n) >= 10_000) return `$${fmtCompact(n, 2)}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Amount of a quote asset, e.g. "4.20". */
export function fmtAmount(n: number, digits?: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 100_000 && digits === undefined) return fmtCompact(n, 2);
  const d = digits ?? (abs === 0 ? 2 : abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6);
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtQuote(n: number, symbol: QuoteAssetSymbol | string, digits?: number): string {
  return `${fmtAmount(n, digits)} ${symbol}`;
}

/** Small prices use subscript-zero notation: 0.0₅1375. */
export function fmtPrice(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "0";
  if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 4, minimumFractionDigits: 2 });
  if (p >= 0.001) return p.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const exp = Math.floor(Math.log10(p));
  const zeros = -exp - 1;
  const digits = Math.round(p * 10 ** (-exp + 3)).toString().slice(0, 4);
  const sub = String(zeros)
    .split("")
    .map((c) => SUBSCRIPT[Number(c)])
    .join("");
  return `0.0${sub}${digits}`;
}

export function fmtPct(n: number, digits = 1, signed = false): string {
  if (!Number.isFinite(n)) return "—";
  const s = signed && n > 0 ? "+" : "";
  return `${s}${n.toFixed(digits)}%`;
}

/** 01:42, or 1:02:03 when ≥ 1h. */
export function fmtCountdown(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtAgo(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  if (d < 5) return "just now";
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function fmtDuration(sec: number): string {
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.round((sec % 86400) / 3600)}h`;
}

export function shortAddr(a: string, n = 4): string {
  if (!a) return "";
  if (a.length <= n * 2 + 1) return a;
  return `${a.slice(0, n)}…${a.slice(-n)}`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** Explorer links: delegated to the single network-aware helper in lib/config (no `?cluster=` on mainnet). */
export function solscanTx(sig: string, network?: Network | null): string {
  return explorerTxUrl(sig, network);
}

export function solscanAccount(addr: string, network?: Network | null): string {
  return explorerAccountUrl(addr, network);
}
