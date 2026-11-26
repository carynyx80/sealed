"use client";
// Owned by privacy-web-agent. The private Sealed wallet's real Helius Privacy Ring balance: redacted glyphs until the
// user opens it with one plain message signature, then decrypted locally (SDK syncWallet + viewing key). Hidden entirely
// unless private features are enabled for this network, and for assets the ring path does not support here.
import clsx from "clsx";
import type { QuoteAssetSymbol } from "@sealed/shared";
import { usePrivacyRing } from "@/lib/privacy/usePrivacyRing";
import { useShieldedIdentity } from "@/lib/privacy/session";
import { isPrivateAsset } from "@/lib/privacy/contract";
import { RingMark } from "./RingMotif";
import { REDACTED, fmtPrivate } from "./ShieldedIdentity";

export function ShieldedBalance({ quoteAsset, compact = false }: { quoteAsset: QuoteAssetSymbol; compact?: boolean }) {
  const ring = usePrivacyRing();
  const id = useShieldedIdentity();
  if (!ring.privateEnabled || !isPrivateAsset(quoteAsset) || !id.connected) return null;
  const v = id.uiBalance(quoteAsset);
  const busy = id.phase === "unlocking" || id.syncing;

  const value =
    v === null ? (
      <span aria-label="Encrypted amount" className="select-none tracking-[0.12em] text-ink-muted">{REDACTED}</span>
    ) : (
      <span className="text-ink">{fmtPrivate(v, quoteAsset)}</span>
    );

  const action =
    id.phase !== "ready" ? (
      <button type="button" onClick={() => void id.unlock()} disabled={busy} className="font-semibold text-signal underline decoration-signal/30 decoration-1 underline-offset-4 transition hover:decoration-signal disabled:opacity-50">
        {busy ? "Opening…" : compact ? "Open" : "Open private wallet"}
      </button>
    ) : (
      <button type="button" onClick={id.lock} className="font-semibold text-ink-slate underline decoration-rule-strong decoration-1 underline-offset-4 transition hover:decoration-ink">
        Lock
      </button>
    );
  const err = id.error && <span className="basis-full font-mono text-[10.5px] text-burn" role="alert">{id.error}</span>;

  if (compact) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
        <RingMark size={14} active={busy} className="text-signal" />
        <span className="num">{value}</span>
        <span className="font-mono text-[11px] text-ink-muted">{quoteAsset} private</span>
        {action}
        {err}
      </span>
    );
  }

  return (
    <div className="rounded-card border border-rule bg-sheet p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow flex items-center gap-2">
          <RingMark size={14} active={busy} className="text-signal" /> Private wallet balance
        </p>
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">Helius Privacy Ring</span>
      </div>
      {/* fixed line box: unlocking swaps the redaction glyphs for digits without moving anything below */}
      <p className="mt-4 flex h-8 items-baseline gap-2">
        <span className={clsx("num leading-8", v === null ? "text-[24px]" : "text-[28px]")}>{value}</span>
        <span className="font-mono text-[12px] text-ink-muted">{quoteAsset}</span>
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-rule pt-3 text-[13px]">
        {action}
        {err}
      </div>
      <p className="mt-3 font-serif text-[12px] italic leading-snug text-ink-muted">
        Decrypted in your browser with your viewing key. Reading it never sends the amount to Sealed or to Helius.
      </p>
    </div>
  );
}
