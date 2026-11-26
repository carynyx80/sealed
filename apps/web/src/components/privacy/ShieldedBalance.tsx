"use client";
// Owned by helius-privacy-agent. The connected wallet's Privacy Ring balance: shown as redacted glyphs until the
// owner decrypts it locally with their viewing key.
import { useEffect, useState } from "react";
import clsx from "clsx";
import type { QuoteAssetSymbol } from "@sealed/shared";
import { usePrivacyRing } from "@/lib/privacy/usePrivacyRing";
import { RingMark } from "./RingMotif";

const GLYPHS = "••••••.••";

function fmt(v: number, symbol: QuoteAssetSymbol) {
  const d = symbol === "SOL" ? 4 : 2;
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function ShieldedBalance({ quoteAsset, compact = false }: { quoteAsset: QuoteAssetSymbol; compact?: boolean }) {
  const ring = usePrivacyRing();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bal = ring.balance(quoteAsset);
  const enc = ring.encrypted(quoteAsset);
  const { available, refreshEncrypted, owner } = ring;

  useEffect(() => {
    if (available) void refreshEncrypted(quoteAsset);
  }, [available, refreshEncrypted, quoteAsset, owner]);

  const onDecrypt = async () => {
    setErr(null);
    setBusy(true);
    try {
      await ring.decrypt(quoteAsset);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const value = bal.encrypted ? (
    <span aria-label="Encrypted amount" className="select-none tracking-[0.12em] text-ink-muted">{GLYPHS}</span>
  ) : (
    <span className="text-ink">{fmt(bal.amount ?? 0, quoteAsset)}</span>
  );

  const action = !available ? null : bal.encrypted ? (
    <button type="button" onClick={onDecrypt} disabled={busy} className="font-semibold text-signal underline decoration-signal/30 decoration-1 underline-offset-4 transition hover:decoration-signal disabled:opacity-50">
      {busy ? "Decrypting…" : compact ? "Decrypt" : "Decrypt with viewing key"}
    </button>
  ) : (
    <button type="button" onClick={() => ring.conceal(quoteAsset)} className="font-semibold text-ink-slate underline decoration-rule-strong decoration-1 underline-offset-4 transition hover:decoration-ink">
      Conceal
    </button>
  );

  if (compact) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
        <RingMark size={14} className="text-signal" />
        <span className="num">{value}</span>
        <span className="font-mono text-[11px] text-ink-muted">{quoteAsset}</span>
        {action}
        {err && <span className="basis-full font-mono text-[10.5px] text-burn" role="alert">{err}</span>}
      </span>
    );
  }

  return (
    <div className="rounded-card border border-rule bg-sheet p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow flex items-center gap-2">
          <RingMark size={14} active={busy} className="text-signal" /> Shielded balance
        </p>
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
          {ring.loading ? "…" : !available ? "unavailable" : ring.simulated ? "simulated" : ring.network}
        </span>
      </div>

      <p className="mt-4 flex items-baseline gap-2">
        <span className={clsx("num text-[28px] leading-none", bal.encrypted && "text-[24px]")}>{value}</span>
        <span className="font-mono text-[12px] text-ink-muted">{quoteAsset}</span>
      </p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-rule pt-3 text-[13px]">
        {action ?? <span className="text-[12.5px] text-ink-muted">{ring.reason ?? "Privacy Ring unavailable on this network"}</span>}
        <span className="font-mono text-[10.5px] text-ink-muted">
          {enc ? `${enc.outputs} encrypted output${enc.outputs === 1 ? "" : "s"}` : "no outputs yet"}
          {enc?.asOfSlot ? ` · slot ${enc.asOfSlot.toLocaleString("en-US")}` : ""}
        </span>
      </div>

      {err && <p className="mt-2 font-mono text-[11px] leading-snug text-burn" role="alert">{err}</p>}
      <p className="mt-3 font-serif text-[12px] italic leading-snug text-ink-muted">
        Decrypted in your browser with your viewing key. The amount is never sent to Sealed or to Helius.
      </p>
    </div>
  );
}
