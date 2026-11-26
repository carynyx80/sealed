"use client";
// Owned by privacy-web-agent. The user's Helius Privacy Ring identity on /account: unlock (one message signature),
// Shielded Address, registration, decrypted private balance, and moving funds in and out of it.
// Rendered only when usePrivacyRing().privateEnabled; otherwise the whole panel is absent.
import { useState } from "react";
import clsx from "clsx";
import { useShieldedIdentity, type ShieldedIdentityApi } from "@/lib/privacy/session";
import { PRIVATE_ASSETS, type PrivateAsset } from "@/lib/privacy/contract";
import { usePrivacyRing } from "@/lib/privacy/usePrivacyRing";
import { IS_MAINNET, explorerTxUrl as explorerTx } from "@/lib/config";
import { shortAddr } from "@/lib/format";
import { CopyField, cleanAmount } from "@/components/custody/parts";
import { ArrowUpRight } from "@/components/ui/Icons";
import { RingMark } from "./RingMotif";

export const REDACTED = "••••••.••";

export function fmtPrivate(v: number, asset: PrivateAsset) {
  const d = asset === "SOL" ? 4 : 2;
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: asset === "SOL" ? 6 : 2 });
}

/** Unlock prompt: one message signature derives the keys in this tab. */
export function UnlockPrompt({ id, compact = false, why }: { id: ShieldedIdentityApi; compact?: boolean; why?: string }) {
  if (!id.connected) return <p className="text-[12.5px] text-ink-slate">Connect a wallet to use your private balance.</p>;
  const busy = id.phase === "unlocking";
  return (
    <div className={clsx(!compact && "rounded-field border border-signal/25 bg-signal-tint/40 p-4")}>
      {!compact && (
        <p className="text-[13px] leading-relaxed text-ink-slate">
          {why ?? "Your wallet signs one message to derive your Privacy Ring keys. They stay in this browser tab only and are forgotten when you disconnect or switch wallets."}
        </p>
      )}
      <button type="button" className={clsx("btn-primary min-h-[44px]", compact ? "mt-0" : "mt-3 w-full")} disabled={busy || !id.canSignMessage} onClick={() => void id.unlock()}>
        {busy ? "Waiting for your signature…" : "Unlock private balance"}
      </button>
      {!id.canSignMessage && <p className="fine mt-2 text-burn">This wallet can&apos;t sign messages, so it can&apos;t hold a private balance.</p>}
      {id.error && id.phase !== "ready" && <p className="mt-2 font-mono text-[11px] leading-snug text-burn" role="alert">{id.error}</p>}
    </div>
  );
}

export function V1Notice({ id }: { id: ShieldedIdentityApi }) {
  if (!id.connected || id.signsV1) return null;
  return (
    <p className="rounded-field border border-burn/20 bg-burn-tint p-3 text-[12px] leading-relaxed text-burn">
      Your wallet doesn&apos;t sign version 1 transactions yet, which every Privacy Ring transaction uses. You can still unlock and read your
      private balance; to move funds privately, connect a wallet that supports them.
    </p>
  );
}

function TxLink({ sig }: { sig: string }) {
  return (
    <a href={explorerTx(sig)} target="_blank" rel="noreferrer" className="btn-link num !text-[12px]">
      {shortAddr(sig, 6)} <ArrowUpRight width={12} height={12} />
    </a>
  );
}

/** § Private balance card for /account. */
export function PrivateBalancePanel({ className }: { className?: string }) {
  const ring = usePrivacyRing();
  const id = useShieldedIdentity();
  if (!ring.privateEnabled) return null;
  const ready = id.phase === "ready";

  return (
    <section className={clsx("card overflow-hidden", className)} aria-labelledby="private-balance-title">
      <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <p className="section-mark flex items-center gap-2">
            <RingMark size={14} active={ready} className="text-signal" /> § 06 · Private balance
          </p>
          <h2 id="private-balance-title" className="mt-2 font-display text-display-sm text-ink">
            Amounts <span className="accent">off</span> the record
          </h2>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-slate">
            A Helius Solana Privacy Ring balance tied to your wallet. Transfers out of it hide the amount on-chain. Wallet addresses stay visible,
            and moving funds in or out of the ring shows that amount publicly.
          </p>
          {ready && id.shieldedAddress && (
            <div className="mt-4">
              <CopyField label="Your shielded address" value={id.shieldedAddress} display={shortAddr(id.shieldedAddress, 10)} />
              <Registration id={id} />
            </div>
          )}
        </div>

        <div className="min-w-0 lg:col-span-7">
          <div className="border-t border-ink">
            {PRIVATE_ASSETS.map((a) => {
              const v = id.uiBalance(a);
              return (
                <div key={a} className="flex items-baseline justify-between gap-3 border-b border-rule py-3">
                  <span className="font-mono text-[13px] text-ink">{a}</span>
                  <span className="num text-[18px]">
                    {v === null ? (
                      <span aria-label="Encrypted amount" className="select-none tracking-[0.12em] text-ink-muted">{REDACTED}</span>
                    ) : (
                      <span className="text-ink">{fmtPrivate(v, a)}</span>
                    )}
                  </span>
                </div>
              );
            })}
            <p className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-muted">
              <span>{ready ? (id.syncing ? "decrypting…" : id.syncedAt ? `decrypted locally · ${new Date(id.syncedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` : "unlocked") : "encrypted"}</span>
              {ready && (
                <span className="flex gap-3">
                  <button type="button" className="underline underline-offset-2 hover:text-ink" disabled={id.syncing} onClick={() => void id.sync()}>Refresh</button>
                  <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={id.lock}>Lock</button>
                </span>
              )}
            </p>
          </div>

          <div className="mt-5">
            {!ready ? (
              <UnlockPrompt id={id} />
            ) : (
              <>
                <V1Notice id={id} />
                <MoveFunds id={id} />
              </>
            )}
            {ready && id.error && <p className="mt-3 font-mono text-[11px] leading-snug text-burn" role="alert">{id.error}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

function Registration({ id }: { id: ShieldedIdentityApi }) {
  const [sig, setSig] = useState<string | null>(null);
  if (id.registered === null) return <p className="fine mt-2">Checking the Privacy Ring user registry…</p>;
  if (id.registered) return <p className="fine mt-2">Registered in the Privacy Ring user registry: anyone can pay you privately by wallet address.</p>;
  return (
    <div className="mt-3 rounded-field border border-rule bg-paper-deep/50 p-3">
      <p className="text-[12.5px] leading-relaxed text-ink-slate">
        Not registered yet. Registering publishes your shielded keys under your wallet so others can send to you privately. One transaction, a small rent deposit.
      </p>
      <button
        type="button"
        className="btn-ghost mt-2 min-h-[44px] w-full"
        disabled={!!id.op || !id.signsV1}
        onClick={() => void id.register().then((s) => setSig(s)).catch(() => undefined)}
      >
        {id.op === "register" ? "Approve in your wallet…" : "Register for private transfers"}
      </button>
      {sig && <p className="mt-2 text-[12px]"><TxLink sig={sig} /></p>}
    </div>
  );
}

function MoveFunds({ id }: { id: ShieldedIdentityApi }) {
  const [dir, setDir] = useState<"in" | "out">("in");
  const [asset, setAsset] = useState<PrivateAsset>("SOL");
  const [amount, setAmount] = useState("");
  const [ack, setAck] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const n = Number(amount);
  const bal = id.uiBalance(asset) ?? 0;
  const over = dir === "out" && n > bal + 1e-12;
  const busy = id.op === "shield" || id.op === "unshield";

  const go = async () => {
    setSig(null);
    try {
      const r = dir === "in" ? await id.shield(asset, n) : await id.unshield(asset, n);
      setSig(r.signature);
      setAmount("");
      setAck(false);
    } catch {
      /* error shown from the store */
    }
  };

  return (
    <div className="rounded-field border border-rule bg-white p-4">
      <div role="radiogroup" aria-label="Direction" className="flex gap-1.5">
        {([
          ["in", "Move to private balance"],
          ["out", "Move to my wallet"],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={dir === k}
            onClick={() => setDir(k)}
            className={clsx("inline-flex min-h-[40px] items-center rounded-full border px-3.5 text-[12.5px] transition", dir === k ? "border-ink bg-ink text-paper" : "border-rule bg-sheet text-ink-slate hover:text-ink")}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <div role="radiogroup" aria-label="Asset" className="flex gap-1.5">
          {PRIVATE_ASSETS.map((a) => (
            <button key={a} type="button" role="radio" aria-checked={a === asset} onClick={() => setAsset(a)} className={clsx("h-11 rounded-full border px-3.5 font-mono text-[12px]", a === asset ? "border-ink text-ink" : "border-rule text-ink-slate")}>
              {a}
            </button>
          ))}
        </div>
        <input
          aria-label={`Amount in ${asset}`}
          inputMode="decimal"
          autoComplete="off"
          className={clsx("input num min-w-0 flex-1 text-base", over && "!border-burn")}
          placeholder="0.00"
          value={amount}
          onChange={(e) => {
            const v = cleanAmount(e.target.value);
            if (v !== null) setAmount(v);
          }}
        />
      </div>
      <p className="fine mt-2">
        {dir === "in"
          ? `From your wallet into your private balance. This step is public: anyone can see ${asset} and the amount entering the ring from your address.`
          : `From your private balance back to your wallet. This step is public: the amount leaving the ring shows on-chain.`}
      </p>
      <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[12px] leading-relaxed text-ink">
        <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-ink" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>I understand this amount is visible on-chain{IS_MAINNET ? " on Solana mainnet" : ""}. Network and Privacy Ring fees are shown by my wallet before I approve.</span>
      </label>
      <button type="button" className="btn-primary mt-3 min-h-[48px] w-full" disabled={!(n > 0) || over || !ack || busy || !!id.op || !id.signsV1} onClick={() => void go()}>
        {busy ? "Proving and signing…" : dir === "in" ? `Move ${n > 0 ? n : ""} ${asset} to private balance` : `Move ${n > 0 ? n : ""} ${asset} to my wallet`}
      </button>
      {over && <p className="mt-1 text-[12px] text-burn">More than your private balance.</p>}
      {sig && <p className="mt-2 text-[12px] text-ink-slate">Confirmed · <TxLink sig={sig} /></p>}
    </div>
  );
}
