"use client";
// Owned by web-offchain-agent. Small shared pieces for the custody UI.
import { useMemo, useState } from "react";
import clsx from "clsx";
import type { DepositStatus, Network, QuoteAssetSymbol, WithdrawalStatus } from "@sealed/shared";
import { QUOTE_ASSETS } from "@sealed/shared";
import { CheckIcon } from "../ui/Icons";
import { encodeQr } from "./qr";
import { explorerAccountUrl, explorerTxUrl } from "@/lib/config";

/* ------------------------------------------------------------------------------------ disclosure */

export const CUSTODY_DISCLOSURE = [
  "Funds you deposit are held by Sealed's company wallet. Sealed has custody of them; this is not a self-custodial account.",
  "Balances, bids, trades, claims and rewards are recorded offchain in Sealed's ledger, not by the on-chain program.",
  "Withdrawals are sent from the company wallet to the address you choose. Amounts above the automatic limit, or made while payouts are paused, wait for manual approval.",
  "Proof of reserves compares the company wallet's on-chain holdings with what the ledger owes users, refreshed live.",
] as const;

export function DisclosureList({ className, dense = false }: { className?: string; dense?: boolean }) {
  return (
    <ol className={clsx("space-y-2", className)}>
      {CUSTODY_DISCLOSURE.map((n, i) => (
        <li key={i} className={clsx("grid grid-cols-[1.5rem_1fr] leading-relaxed text-ink-slate", dense ? "text-[11.5px]" : "text-[13px]")}>
          <span className="num text-ink-muted">{String(i + 1).padStart(2, "0")}</span>
          <span>{n}</span>
        </li>
      ))}
    </ol>
  );
}

/* --------------------------------------------------------------------------------------- copy */

export function CopyField({ label, value, display, mono = true }: { label: string; value: string; display?: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="rounded-field border border-rule bg-white">
      <div className="flex items-center justify-between gap-3 px-3.5 pt-2.5">
        <span className="eyebrow">{label}</span>
      </div>
      <div className="flex items-center gap-2 pb-1.5 pl-3.5 pr-1.5">
        <span className={clsx("min-w-0 flex-1 break-all text-[13px] leading-snug text-ink", mono && "num")}>{display ?? value}</span>
        <button
          type="button"
          onClick={copy}
          className={clsx(
            "inline-flex h-11 min-w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-full border px-3 text-[12px] font-semibold transition",
            copied ? "border-gain/30 bg-gain-tint text-gain" : "border-rule bg-sheet text-ink hover:border-rule-strong",
          )}
          aria-label={`Copy ${label}`}
        >
          {copied ? (
            <>
              <CheckIcon width={13} height={13} /> Copied
            </>
          ) : (
            "Copy"
          )}
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------------------- QR */

export function QrCode({ value, size = 168, label }: { value: string; size?: number; label: string }) {
  const { path, n } = useMemo(() => {
    try {
      const m = encodeQr(value);
      let d = "";
      for (let y = 0; y < m.length; y++) {
        let x = 0;
        while (x < m.length) {
          if (!m[y]![x]) {
            x++;
            continue;
          }
          const start = x;
          while (x < m.length && m[y]![x]) x++;
          d += `M${start + 4} ${y + 4}h${x - start}v1h-${x - start}z`;
        }
      }
      return { path: d, n: m.length + 8 };
    } catch {
      return { path: "", n: 0 };
    }
  }, [value]);
  if (!n) return null;
  return (
    <svg viewBox={`0 0 ${n} ${n}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges" className="block rounded-field border border-rule bg-white">
      <path d={path} fill="#0F0F0D" />
    </svg>
  );
}

/* ------------------------------------------------------------------------------------- status */

const DEP_STEPS: DepositStatus[] = ["detected", "confirmed", "credited"];
export function DepositSteps({ status }: { status: DepositStatus | "sent" | null }) {
  const idx = status === "sent" ? -1 : status ? DEP_STEPS.indexOf(status) : -2;
  return (
    <ol className="grid grid-cols-4 border-y border-rule">
      {(["sent", ...DEP_STEPS] as const).map((s, i) => {
        const reached = status === "rejected" ? false : i <= idx + 1;
        const active = i === idx + 2 && status !== "credited" && status !== "rejected";
        return (
          <li key={s} className={clsx("border-rule px-2 py-3 text-center", i > 0 && "border-l")}>
            <span className={clsx("mx-auto flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[10px]", reached ? "border-ink bg-ink text-paper" : "border-rule-strong text-ink-muted", active && "animate-pulse-soft")}>
              {reached ? <CheckIcon width={11} height={11} /> : i + 1}
            </span>
            <span className={clsx("mt-1.5 block font-mono text-[10px] uppercase tracking-[0.06em]", reached ? "text-ink" : "text-ink-muted")}>{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function StatusChip({ status }: { status: DepositStatus | WithdrawalStatus }) {
  const tone =
    status === "credited" || status === "sent"
      ? "border-gain/25 bg-gain-tint text-gain"
      : status === "rejected" || status === "failed"
        ? "border-burn/25 bg-burn-tint text-burn"
        : status === "pending_approval"
          ? "border-signal/25 bg-signal-tint text-signal-ink"
          : "border-rule bg-paper text-ink-slate";
  return <span className={clsx("inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em]", tone)}>{status.replace("_", " ")}</span>;
}

export function assetUsd(asset: QuoteAssetSymbol, amount: number): number {
  return (QUOTE_ASSETS[asset]?.demoUsdPrice ?? 0) * amount;
}

export function explorerTx(sig: string, network: Network | undefined): string {
  return explorerTxUrl(sig, network);
}
export function explorerAccount(addr: string, network: Network | undefined): string {
  return explorerAccountUrl(addr, network);
}

/** Plain amount input sanitiser (digits + one dot). */
export function cleanAmount(v: string): string | null {
  const s = v.replace(",", ".");
  return /^\d*\.?\d*$/.test(s) ? s : null;
}

/* ------------------------------------------------------------------------------------ payouts */

/** Human copy for why automatic payouts are paused (API `payoutsReason`, e.g. "company wallet needs SOL for fees"). */
export function payoutsPausedCopy(reason: string | null | undefined): string {
  const r = (reason ?? "").trim().replace(/\.$/, "");
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : "Automatic payouts are not configured on this deployment";
}

/** Shown in the withdraw sheet and on /account whenever the API reports payoutsEnabled === false. */
export function PayoutsPausedNotice({ reason, className, compact = false }: { reason: string | null | undefined; className?: string; compact?: boolean }) {
  return (
    <div role="status" className={clsx("rounded-field border border-signal/25 bg-signal-tint/50 text-signal-ink", compact ? "p-3" : "p-4", className)}>
      <p className="flex items-center gap-2 text-[13px] font-semibold">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal" /> Automatic payouts paused
      </p>
      <p className="mt-1 text-[12px] leading-relaxed">
        {payoutsPausedCopy(reason)}. Withdrawals you request now wait for manual approval by Sealed; the amount stays locked in your account
        until it is sent or returned. Deposits, bids and trades are unaffected.
      </p>
    </div>
  );
}
