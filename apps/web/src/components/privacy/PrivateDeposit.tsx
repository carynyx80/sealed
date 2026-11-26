"use client";
// Owned by privacy-web-agent. DepositSheet "Private (Helius Privacy Ring)" method: a confidential transfer from the
// user's private balance to Sealed's shielded address. Flow: unlock → amount → review → wallet signs → POST claim →
// poll /api/privacy/deposits until credited. Attribution: the claim is made with the user's Sealed session and the
// transaction is signed by their wallet (sender stays visible on-chain), so the backend can match it to the account.
import { useEffect, useState } from "react";
import clsx from "clsx";
import { COMPANY_WALLET } from "@sealed/shared";
import { useShieldedIdentity } from "@/lib/privacy/session";
import { claimPrivateDeposit, usePrivacyDepositInfo, usePrivateDepositTracking } from "@/lib/privacy/deposits";
import { PRIVATE_ASSETS, isPrivateAsset, type PrivateAsset } from "@/lib/privacy/contract";
import { invalidateCustody } from "@/lib/custody/hooks";
import { IS_MAINNET, explorerTxUrl as explorerTx } from "@/lib/config";
import { shortAddr } from "@/lib/format";
import { cleanAmount } from "@/components/custody/parts";
import { ArrowUpRight } from "@/components/ui/Icons";
import { RingMark } from "./RingMotif";
import { REDACTED, UnlockPrompt, V1Notice, fmtPrivate } from "./ShieldedIdentity";

type Phase = "edit" | "review" | "sending" | "sent";

export function PrivateDeposit({ wallet, initialAsset, onBusy }: { wallet: string | null; initialAsset: string; onBusy?: (b: boolean) => void }) {
  const id = useShieldedIdentity();
  const info = usePrivacyDepositInfo(wallet, true);
  const [asset, setAsset] = useState<PrivateAsset>(isPrivateAsset(initialAsset) ? initialAsset : "SOL");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<Phase>("edit");
  const [sig, setSig] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const tracking = usePrivateDepositTracking(wallet, sig);

  useEffect(() => onBusy?.(phase === "sending"), [phase, onBusy]);
  useEffect(() => {
    if (tracking.record?.status === "credited") invalidateCustody(wallet);
  }, [tracking.record?.status, wallet]);

  const d = info.data;
  const assets = (d?.assets?.length ? d.assets : PRIVATE_ASSETS).filter(isPrivateAsset);
  const min = d?.minAmount?.[asset] ?? 0;
  const n = Number(amount);
  const bal = id.uiBalance(asset);
  const over = bal !== null && n > bal + 1e-12;
  const under = n > 0 && n < min;
  const ready = id.phase === "ready";

  if (info.error) return <p className="mt-4 rounded-field border border-rule bg-paper-deep/60 p-3 text-[12.5px] text-ink-slate">{info.error}</p>;
  if (!d) return <div className="mt-4 h-40 animate-pulse rounded-field bg-paper-deep" aria-hidden />;
  if (!d.enabled) return <p className="mt-4 rounded-field border border-rule bg-paper-deep/60 p-3 text-[12.5px] text-ink-slate">{d.reason ?? "Private deposits are not open on Sealed right now."}</p>;

  const send = async () => {
    setErr(null);
    setPhase("sending");
    try {
      // Prefer the raw Shielded Address (skips the registry lookup); both forms are checked against COMPANY_WALLET.
      const r = await id.sendToCompany(d.companyShieldedAddressBytes ?? d.companyShieldedAddress, asset, n);
      setSig(r.signature);
      setPhase("sent");
      if (wallet) await claimPrivateDeposit(wallet, r.signature).catch(() => undefined);
    } catch (e) {
      setErr((e as Error).message);
      setPhase("review");
    }
  };

  return (
    <div className="mt-5">
      <p className="flex items-start gap-2.5 rounded-field border border-signal/20 bg-signal-tint/50 p-3 text-[12px] leading-relaxed text-signal-ink">
        <RingMark size={18} className="mt-px shrink-0 text-signal" />
        <span>
          Paid from your Helius Privacy Ring balance. The amount is encrypted on-chain; your wallet address and Sealed&apos;s stay visible.
        </span>
      </p>

      {!ready ? (
        <div className="mt-4">
          <UnlockPrompt id={id} why="Unlock your private balance first: your wallet signs one message to derive your Privacy Ring keys in this tab." />
        </div>
      ) : phase === "sent" && sig ? (
        <section className="mt-4" aria-live="polite" aria-label="Private deposit status">
          <dl className="grid grid-cols-2 border-y border-ink text-sm">
            <div className="py-3 pr-3"><dt className="eyebrow">Amount</dt><dd className="num mt-1">{n} {asset} <span className="text-ink-muted">· hidden on-chain</span></dd></div>
            <div className="border-l border-rule py-3 pl-3">
              <dt className="eyebrow">Status</dt>
              <dd className="mt-1 text-[13px]">
                {tracking.record?.status === "credited" ? <span className="text-gain">Credited</span> : tracking.record?.status === "rejected" ? <span className="text-burn">Rejected{tracking.record.reason ? ` · ${tracking.record.reason}` : ""}</span> : "Waiting for Sealed to credit it…"}
              </dd>
            </div>
          </dl>
          <a href={explorerTx(sig)} target="_blank" rel="noreferrer" className="btn-link num mt-3 !text-[12px]">
            {shortAddr(sig, 8)} <ArrowUpRight width={12} height={12} />
          </a>
          {tracking.error && <p className="fine mt-2">{tracking.error}</p>}
          <p className="fine mt-2">Solscan shows the transfer and both addresses, not the amount.</p>
        </section>
      ) : (
        <>
          <V1Notice id={id} />
          <div role="radiogroup" aria-label="Private asset" className="mt-4 flex gap-1.5">
            {assets.map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={a === asset}
                disabled={phase !== "edit"}
                onClick={() => setAsset(a)}
                className={clsx("inline-flex h-11 items-center rounded-full border px-4 font-mono text-[12px]", a === asset ? "border-ink bg-ink text-paper" : "border-rule bg-sheet text-ink-slate")}
              >
                {a}
              </button>
            ))}
          </div>
          <div className="mt-4 flex items-baseline justify-between gap-3">
            <label htmlFor="pdep-amount" className="label">Amount <span className="font-mono text-ink-muted">{asset}</span></label>
            <span className="mb-1.5 font-mono text-[11px] text-ink-slate">
              private {bal === null ? REDACTED : fmtPrivate(bal, asset)}
            </span>
          </div>
          <input
            id="pdep-amount"
            inputMode="decimal"
            autoComplete="off"
            className={clsx("input num text-base", (over || under) && "!border-burn")}
            placeholder="0.00"
            value={amount}
            disabled={phase !== "edit"}
            onChange={(e) => {
              const v = cleanAmount(e.target.value);
              if (v !== null) setAmount(v);
            }}
          />
          {over && <p className="mt-1 text-[12px] text-burn">More than your private balance. Move funds to it on your account page first.</p>}
          {under && <p className="mt-1 text-[12px] text-burn">The minimum private deposit is {min} {asset}.</p>}

          {phase === "edit" ? (
            <button type="button" className="btn-primary mt-3 min-h-[48px] w-full" disabled={!(n > 0) || over || under || !id.signsV1} onClick={() => { setAck(false); setPhase("review"); }}>
              Review private deposit
            </button>
          ) : (
            <div className="mt-4 rounded-field border border-ink bg-white" aria-live="polite">
              <div className="flex items-baseline justify-between gap-3 border-b border-rule px-4 pb-2 pt-3">
                <p className="eyebrow">Review private transfer</p>
                <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-burn">Real funds</span>
              </div>
              <dl className="divide-y divide-rule px-4 text-[13px]">
                <Row k="You send" v={<span className="text-[17px]">{n} <span className="text-ink-muted">{asset}</span></span>} />
                <Row k="On-chain" v="amount and asset encrypted" />
                <div className="py-2.5">
                  <dt className="flex items-baseline justify-between gap-3 text-ink-slate">
                    <span>To · Sealed custody</span>
                    <span className="num text-ink">{shortAddr(COMPANY_WALLET, 4)}</span>
                  </dt>
                  <dd className="num mt-1 break-all text-[11px] leading-snug text-ink-muted">{shortAddr(d.companyShieldedAddressBytes ?? d.companyShieldedAddress, 14)}</dd>
                </div>
                <Row k="Reference" v={d.reference} />
                <Row k="Fees" v="network + ring fee, shown in your wallet" />
              </dl>
              <div className="border-t border-rule px-4 py-3">
                <p className="text-[12px] leading-relaxed text-ink-slate">
                  Sealed holds the funds and credits your Sealed balance once the transfer is confirmed. A zero knowledge proof is generated by the
                  Helius prover (attested enclave) and your wallet signs the transaction.
                </p>
                <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[12px] leading-relaxed text-ink">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-ink" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={phase === "sending"} />
                  <span>I&apos;m sending real {asset}{IS_MAINNET ? " on Solana mainnet" : ""} to Sealed custody, and Sealed will hold it on my behalf.</span>
                </label>
                <div className="mt-3 flex gap-2">
                  <button type="button" className="btn-ghost min-h-[48px] shrink-0" disabled={phase === "sending"} onClick={() => setPhase("edit")}>Back</button>
                  <button type="button" className="btn-primary min-h-[48px] flex-1" disabled={!ack || phase === "sending"} onClick={() => void send()}>
                    {phase === "sending" ? "Proving and signing…" : `Confirm & send ${n} ${asset}`}
                  </button>
                </div>
              </div>
            </div>
          )}
          {err && <p className="mt-3 rounded-field border border-burn/20 bg-burn-tint p-3 text-[12px] text-burn">{err}</p>}
        </>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2.5">
      <dt className="text-ink-slate">{k}</dt>
      <dd className="num min-w-0 truncate text-right text-ink">{v}</dd>
    </div>
  );
}
