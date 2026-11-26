"use client";
// Owned by privacy-web-agent. "§ Private wallet" on /account: the user's private Sealed wallet (a separate key their
// main wallet re-creates with one plain text signature) that holds their Helius Privacy Ring balance.
//   1 Open private wallet (one plain signature) → 2 Fund it (from the main wallet) → 3 Move to private balance →
//   4 Private deposit to Sealed. Escape hatches: move back to public, send to my main wallet.
// Rendered only when usePrivacyRing().privateEnabled; otherwise the whole panel is absent.
import { useState, type ReactNode } from "react";
import clsx from "clsx";
import { useShieldedIdentity, preferPrivateDeposit, type ShieldedIdentityApi } from "@/lib/privacy/session";
import { PRIVATE_ASSETS, type PrivateAsset } from "@/lib/privacy/contract";
import { usePrivacyRing } from "@/lib/privacy/usePrivacyRing";
import { openDeposit } from "@/lib/custody/sheets";
import { explorerAccountUrl, explorerTxUrl as explorerTx } from "@/lib/config";
import { shortAddr } from "@/lib/format";
import { CopyField, cleanAmount } from "@/components/custody/parts";
import { ArrowUpRight } from "@/components/ui/Icons";
import { RingMark } from "./RingMotif";

export const REDACTED = "••••••.••";

export function fmtPrivate(v: number, asset: PrivateAsset) {
  const d = asset === "SOL" ? 4 : 2;
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: asset === "SOL" ? 6 : 2 });
}
const fmtSol = (lamports: bigint) => (Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 });

/** Step 1: one plain text signature from the main wallet opens the private wallet in this tab. */
export function UnlockPrompt({ id, compact = false, why }: { id: ShieldedIdentityApi; compact?: boolean; why?: string }) {
  if (!id.connected) return <p className="text-[12.5px] text-ink-slate">Connect a wallet to open your private wallet.</p>;
  const busy = id.phase === "unlocking";
  return (
    <div className={clsx(!compact && "rounded-field border border-signal/25 bg-signal-tint/40 p-4")}>
      {!compact && (
        <p className="text-[13px] leading-relaxed text-ink-slate">
          {why ??
            "Your wallet signs one plain text message. It moves nothing and costs nothing. Sealed turns that signature into your private wallet's keys in this browser tab; they are never stored and are forgotten when you lock, disconnect or switch wallets."}
        </p>
      )}
      <button type="button" className={clsx("btn-primary min-h-[44px]", compact ? "mt-0" : "mt-3 w-full")} disabled={busy || !id.canSignMessage} onClick={() => void id.unlock()}>
        {busy ? "Waiting for your signature…" : "Open private wallet"}
      </button>
      {!id.canSignMessage && (
        <p className="fine mt-2 text-burn">
          {id.walletName ? `${id.walletName} can't` : "This wallet can't"} sign messages, so it can&apos;t open a private wallet. Hardware wallets such as Ledger
          don&apos;t support it yet; connect a browser or mobile wallet instead.
        </p>
      )}
      {id.error && id.phase !== "ready" && <p className="mt-2 font-mono text-[11px] leading-snug text-burn" role="alert">{id.error}</p>}
    </div>
  );
}

function TxLink({ sig }: { sig: string }) {
  return (
    <a href={explorerTx(sig)} target="_blank" rel="noreferrer" className="btn-link num !text-[12px]">
      {shortAddr(sig, 6)} <ArrowUpRight width={12} height={12} />
    </a>
  );
}

/** § Private wallet card for /account. */
export function PrivateWalletPanel({ className }: { className?: string }) {
  const ring = usePrivacyRing();
  const id = useShieldedIdentity();
  if (!ring.privateEnabled) return null;
  const ready = id.phase === "ready";
  const pub = id.pub;
  const funded = !!pub && pub.sol >= pub.needsLamports;
  const privTotal = (id.uiBalance("SOL") ?? 0) + (id.uiBalance("USDC") ?? 0);

  return (
    <section className={clsx("card overflow-hidden", className)} aria-labelledby="private-wallet-title">
      <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-5">
          <p className="section-mark flex items-center gap-2">
            <RingMark size={14} active={ready} className="text-signal" /> § 06 · Private wallet
          </p>
          <h2 id="private-wallet-title" className="mt-2 font-display text-display-sm text-ink">
            Amounts <span className="accent">off</span> the record
          </h2>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-slate">
            A separate Sealed wallet that holds your Helius Solana Privacy Ring balance and signs its own private transactions, so any wallet works.
            Your main wallet only signs one plain message and ordinary transfers.
          </p>

          {ready && id.burner && (
            <div className="mt-4 space-y-2">
              <CopyField label="Private wallet address" value={id.burner} display={shortAddr(id.burner, 10)} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <a href={explorerAccountUrl(id.burner)} target="_blank" rel="noreferrer" className="btn-link inline-flex min-h-[44px] items-center !text-[12px]">
                  View on Solscan <ArrowUpRight width={12} height={12} />
                </a>
                <button type="button" className="btn-ghost min-h-[44px] !px-4 !text-[12.5px]" onClick={id.lock}>Lock</button>
              </div>
              <LinkLine id={id} />
            </div>
          )}

          <ul className="mt-5 space-y-2 border-t border-rule pt-4 text-[12px] leading-relaxed text-ink-slate">
            <li>Amounts are hidden inside the Privacy Ring. Moving funds into or out of it (shielding and unshielding) shows that amount and the address publicly.</li>
            <li>Your private wallet is recreated by signing the same message again with the same wallet. Nothing is stored.</li>
            <li className="text-ink">Never sign the &ldquo;Sealed private wallet&rdquo; message on any site other than www.sealedsol.xyz: it opens this wallet.</li>
          </ul>
        </div>

        <div className="min-w-0 lg:col-span-7">
          <ol className="border-t border-ink">
            <Step n={1} title="Open private wallet" sub="One plain signature from your main wallet" done={ready}>
              {!ready && <UnlockPrompt id={id} />}
            </Step>

            <Step n={2} title="Fund it" sub="An ordinary transfer from your main wallet" done={ready && funded} disabled={!ready}>
              {ready && <FundStep id={id} />}
            </Step>

            <Step n={3} title="Move to private balance" sub="Shield from the private wallet into the ring" done={ready && privTotal > 0} disabled={!ready}>
              {ready && <ShieldStep id={id} />}
            </Step>

            <Step n={4} title="Private deposit to Sealed" sub="A confidential transfer: the amount stays hidden" done={false} disabled={!ready}>
              {ready && (
                <div>
                  <p className="text-[12.5px] leading-relaxed text-ink-slate">
                    Sends from your private balance to Sealed custody and credits your Sealed account once it confirms.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {PRIVATE_ASSETS.map((a) => (
                      <button
                        key={a}
                        type="button"
                        className="btn-primary min-h-[44px] flex-1"
                        disabled={!id.signedIn}
                        onClick={() => {
                          preferPrivateDeposit();
                          openDeposit(a);
                        }}
                      >
                        Deposit {a} privately
                      </button>
                    ))}
                  </div>
                  {!id.signedIn && <p className="fine mt-2">Sign in to Sealed first so the deposit is credited to your account.</p>}
                </div>
              )}
            </Step>
          </ol>

          {ready && (
            <>
              <PrivateBalances id={id} />
              <EscapeHatches id={id} />
            </>
          )}
          {ready && id.error && <p className="mt-3 rounded-field border border-burn/20 bg-burn-tint p-3 text-[12px] text-burn" role="alert">{id.error}</p>}
        </div>
      </div>
    </section>
  );
}

function Step({ n, title, sub, done, disabled, children }: { n: number; title: string; sub: string; done: boolean; disabled?: boolean; children?: ReactNode }) {
  return (
    <li className={clsx("border-b border-rule py-4", disabled && "opacity-55")}>
      <div className="flex items-baseline gap-3">
        <span className={clsx("num w-6 shrink-0 text-[13px]", done ? "text-gain" : "text-ink-muted")}>{done ? "✓" : `0${n}`}</span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-ink">{title}</p>
          <p className="text-[12px] text-ink-muted">{sub}</p>
        </div>
      </div>
      {children && <div className="mt-3 sm:pl-9">{children}</div>}
    </li>
  );
}

function LinkLine({ id }: { id: ShieldedIdentityApi }) {
  const l = id.link;
  let text: ReactNode;
  if (l.status === "linked" && l.linkedBurner === id.burner) text = <span className="text-gain">Linked to your Sealed account. Private deposits from it are credited to you, and private withdrawals can pay into it.</span>;
  else if (l.status === "signed_out" || !id.signedIn) text = "Sign in to Sealed to link this private wallet to your account.";
  else if (l.status === "checking" || l.status === "unknown") text = "Checking the link with your Sealed account…";
  else if (l.status === "taken") text = <span className="text-burn">{l.error}</span>;
  else if (l.status === "other")
    text = (
      <span>
        Your Sealed account is linked to another private wallet ({shortAddr(l.linkedBurner ?? "", 4)}).{" "}
        <button type="button" className="inline-flex min-h-[44px] items-center underline underline-offset-2" onClick={() => void id.relink()}>Link this one instead</button>
      </span>
    );
  else if (l.status === "none") text = <button type="button" className="inline-flex min-h-[44px] items-center underline underline-offset-2" onClick={() => void id.relink()}>Link this private wallet to my Sealed account</button>;
  else text = <span className="text-burn">{l.error ?? "Couldn't check the link with your Sealed account."}</span>;
  return <p className="text-[12px] leading-relaxed text-ink-slate">{text}</p>;
}

/* ---------------------------------------------------------------------------------- shared form */

function AmountAction({
  id,
  label,
  busyLabel,
  busy,
  note,
  max,
  onSubmit,
  assets = PRIVATE_ASSETS,
}: {
  id: ShieldedIdentityApi;
  label: (asset: PrivateAsset, n: number) => string;
  busyLabel: string;
  busy: boolean;
  note: (asset: PrivateAsset) => ReactNode;
  max?: (asset: PrivateAsset) => number | null;
  onSubmit: (asset: PrivateAsset, n: number) => Promise<{ signature: string } | string | null>;
  assets?: readonly PrivateAsset[];
}) {
  const [asset, setAsset] = useState<PrivateAsset>(assets[0] ?? "SOL");
  const [amount, setAmount] = useState("");
  const [sig, setSig] = useState<string | null>(null);
  const n = Number(amount);
  const m = max?.(asset) ?? null;
  const over = m !== null && n > m + 1e-12;

  const go = async () => {
    setSig(null);
    try {
      const r = await onSubmit(asset, n);
      const s = typeof r === "string" ? r : r?.signature ?? null;
      setSig(s);
      setAmount("");
    } catch {
      /* error shown from the store */
    }
  };

  return (
    <div className="rounded-field border border-rule bg-white p-3.5">
      <div className="flex flex-wrap gap-2">
        <div role="radiogroup" aria-label="Asset" className="flex gap-1.5">
          {assets.map((a) => (
            <button key={a} type="button" role="radio" aria-checked={a === asset} onClick={() => setAsset(a)} className={clsx("h-11 rounded-full border px-3.5 font-mono text-[12px]", a === asset ? "border-ink bg-ink text-paper" : "border-rule text-ink-slate")}>
              {a}
            </button>
          ))}
        </div>
        <input
          aria-label={`Amount in ${asset}`}
          inputMode="decimal"
          autoComplete="off"
          className={clsx("input num h-11 min-w-[120px] flex-1 !py-0 text-base", over && "!border-burn")}
          placeholder="0.00"
          value={amount}
          onChange={(e) => {
            const v = cleanAmount(e.target.value);
            if (v !== null) setAmount(v);
          }}
        />
      </div>
      {m !== null && (
        <button type="button" className="mt-1 inline-flex min-h-[44px] items-center font-mono text-[11px] text-ink-slate underline decoration-rule-strong underline-offset-2 hover:text-ink" onClick={() => setAmount(String(m))}>
          max {fmtPrivate(m, asset)} {asset}
        </button>
      )}
      <p className="fine mt-1.5">{note(asset)}</p>
      <button type="button" className="btn-primary mt-3 min-h-[44px] w-full" disabled={!(n > 0) || over || !!id.op} onClick={() => void go()}>
        {busy ? busyLabel : label(asset, n)}
      </button>
      {over && <p className="mt-1 text-[12px] text-burn">More than is available.</p>}
      {sig && <p className="mt-2 text-[12px] text-ink-slate">Confirmed · <TxLink sig={sig} /></p>}
    </div>
  );
}

/* -------------------------------------------------------------------------------------- steps */

function FundStep({ id }: { id: ShieldedIdentityApi }) {
  const pub = id.pub;
  const sol = id.uiPublic("SOL");
  const usdc = id.uiPublic("USDC");
  const short = pub && pub.sol < pub.needsLamports ? pub.needsLamports - pub.sol : 0n;
  return (
    <div>
      <dl className="grid grid-cols-2 border-y border-rule text-[13px]">
        <div className="py-2.5 pr-3">
          <dt className="eyebrow">Public SOL</dt>
          <dd className="num mt-0.5 text-ink">{sol === null ? "…" : fmtPrivate(sol, "SOL")}</dd>
        </div>
        <div className="border-l border-rule py-2.5 pl-3">
          <dt className="eyebrow">Public USDC</dt>
          <dd className="num mt-0.5 text-ink">{pub ? fmtPrivate(usdc ?? 0, "USDC") : "…"}</dd>
        </div>
      </dl>
      {pub && (
        <p className={clsx("mt-2 text-[12px] leading-relaxed", short > 0n ? "text-burn" : "text-ink-slate")}>
          Needs about <span className="num">{fmtSol(pub.needsLamports)}</span> SOL for network fees
          {id.registered ? "" : <> and the one time registration rent (<span className="num">{fmtSol(pub.registrationRentLamports)}</span> SOL)</>}
          {pub.usdc === null ? " plus a USDC token account" : ""}.{" "}
          {short > 0n ? <>Send at least <span className="num">{fmtSol(short)}</span> more SOL.</> : "Covered."}
          <span className="text-ink-muted"> {pub.exact ? "Estimate: rent is exact, fees are a conservative allowance." : "Conservative estimate."}</span>
        </p>
      )}
      <div className="mt-3">
        <AmountAction
          id={id}
          busy={id.op === "fund"}
          busyLabel="Approve in your wallet…"
          label={(a, n) => `Send ${n > 0 ? n : ""} ${a} to private wallet`}
          note={(a) => `An ordinary ${a} transfer from your main wallet to your private wallet's address. It is public on Solscan, like any transfer.`}
          onSubmit={(a, n) => id.fund(a, n)}
        />
      </div>
    </div>
  );
}

function ShieldStep({ id }: { id: ShieldedIdentityApi }) {
  const [regSig, setRegSig] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      {id.registered === null ? (
        <p className="fine">Checking the Privacy Ring user registry…</p>
      ) : !id.registered ? (
        <div className="rounded-field border border-rule bg-paper-deep/50 p-3">
          <p className="text-[12.5px] leading-relaxed text-ink-slate">
            First, register your private wallet in the Privacy Ring user registry (one transaction from the private wallet, a small rent deposit).
            It lets Sealed pay private withdrawals into it.
          </p>
          <button type="button" className="btn-ghost mt-2 min-h-[44px] w-full" disabled={!!id.op} onClick={() => void id.register().then((s) => setRegSig(s)).catch(() => undefined)}>
            {id.op === "register" ? "Registering…" : "Register private wallet"}
          </button>
          {regSig && <p className="mt-2 text-[12px]"><TxLink sig={regSig} /></p>}
        </div>
      ) : (
        <p className="fine">Registered in the Privacy Ring user registry.</p>
      )}
      <AmountAction
        id={id}
        busy={id.op === "shield"}
        busyLabel="Proving and sending…"
        label={(a, n) => `Move ${n > 0 ? n : ""} ${a} to private balance`}
        max={(a) => {
          const v = id.uiPublic(a);
          if (v === null) return a === "USDC" ? 0 : null;
          return a === "SOL" ? Math.max(0, Number((v - 0.005).toFixed(6))) : v;
        }}
        note={(a) => `This step is public: anyone can see ${a} and the amount entering the ring from your private wallet's address. Signed in this tab by your private wallet.`}
        onSubmit={(a, n) => id.shield(a, n)}
      />
    </div>
  );
}

function PrivateBalances({ id }: { id: ShieldedIdentityApi }) {
  return (
    <div className="mt-5">
      <p className="eyebrow">Private balance</p>
      <div className="mt-1 border-t border-ink">
        {PRIVATE_ASSETS.map((a) => {
          const v = id.uiBalance(a);
          return (
            <div key={a} className="flex items-baseline justify-between gap-3 border-b border-rule py-3">
              <span className="font-mono text-[13px] text-ink">{a}</span>
              <span className="num text-[18px]">
                {v === null ? <span aria-label="Encrypted amount" className="select-none tracking-[0.12em] text-ink-muted">{REDACTED}</span> : <span className="text-ink">{fmtPrivate(v, a)}</span>}
              </span>
            </div>
          );
        })}
        <p className="mt-1 flex flex-wrap items-center justify-between gap-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-muted">
          <span>{id.syncing ? "decrypting…" : id.syncedAt ? `decrypted locally · ${new Date(id.syncedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` : "encrypted"}</span>
          <button type="button" className="inline-flex min-h-[44px] items-center underline underline-offset-2 hover:text-ink" disabled={id.syncing} onClick={() => void id.sync()}>Refresh</button>
        </p>
        <p className="fine">Private withdrawals from Sealed arrive here once you refresh.</p>
      </div>
    </div>
  );
}

function EscapeHatches({ id }: { id: ShieldedIdentityApi }) {
  const [tab, setTab] = useState<"out" | "home">("out");
  return (
    <details className="mt-5 rounded-field border border-rule bg-sheet">
      <summary className="flex min-h-[44px] cursor-pointer items-center px-3.5 text-[13px] font-semibold text-ink">Get funds back out</summary>
      <div className="px-3.5 pb-3.5">
        <div role="radiogroup" aria-label="Where to" className="flex flex-wrap gap-1.5">
          {([
            ["out", "Move back to public"],
            ["home", "Send to my main wallet"],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={tab === k}
              onClick={() => setTab(k)}
              className={clsx("inline-flex min-h-[44px] items-center rounded-full border px-3.5 text-[12.5px] transition", tab === k ? "border-ink bg-ink text-paper" : "border-rule bg-white text-ink-slate hover:text-ink")}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-3">
          {tab === "out" ? (
            <AmountAction
              key="out"
              id={id}
              busy={id.op === "unshield"}
              busyLabel="Proving and sending…"
              label={(a, n) => `Move ${n > 0 ? n : ""} ${a} to public`}
              max={(a) => id.uiBalance(a)}
              note={() => "From the private balance to your private wallet's public address. This step is public: the amount leaving the ring shows on-chain."}
              onSubmit={(a, n) => id.unshield(a, n)}
            />
          ) : (
            <AmountAction
              key="home"
              id={id}
              busy={id.op === "sweep"}
              busyLabel="Sending…"
              label={(a, n) => `Send ${n > 0 ? n : ""} ${a} to my main wallet`}
              max={(a) => {
                const v = id.uiPublic(a);
                if (v === null) return a === "USDC" ? 0 : null;
                return a === "SOL" ? Math.max(0, Number((v - 0.000025).toFixed(9))) : v;
              }}
              note={(a) =>
                `An ordinary ${a} transfer from your private wallet's public address back to ${shortAddr(id.owner ?? "", 4)}, signed in this tab.${a === "USDC" ? " Needs a little SOL in the private wallet for the fee." : ""}`
              }
              onSubmit={(a, n) => id.sweep(a, n)}
            />
          )}
        </div>
      </div>
    </details>
  );
}
