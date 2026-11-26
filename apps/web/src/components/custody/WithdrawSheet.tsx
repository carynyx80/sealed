"use client";
// Owned by web-offchain-agent. Withdraw from the custodial account: POST /api/account/withdrawals, then track
// queued → pending_approval → sending → sent (Solscan link) on the withdrawals list.
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { PublicKey } from "@solana/web3.js";
import {
  CUSTODY_ROUTES,
  WITHDRAWAL_LIMITS,
  isQuoteAssetSymbol,
  type QuoteAssetSymbol,
  type WithdrawalRecord,
} from "@sealed/shared";
import { balanceOf, custodyFetch, invalidateCustody, useCustodyAccount, useCustodyInfo, useCustodySession, useWithdrawals } from "@/lib/custody";
import { errorMessage } from "@/lib/defi/config";
import { fmtUsd, shortAddr } from "@/lib/format";
import { Sheet } from "./Sheet";
import { CustodyGate } from "./SignInButton";
import { DisclosureList, PayoutsPausedNotice, StatusChip, assetUsd, cleanAmount, explorerTx, payoutsPausedCopy } from "./parts";
import { quoteAssetOffered } from "@/lib/quoteAssets";
import { ArrowUpRight } from "../ui/Icons";

function validAddress(a: string): boolean {
  try {
    return new PublicKey(a).toBase58() === a;
  } catch {
    return false;
  }
}

export function WithdrawSheet({ open, onClose, asset }: { open: boolean; onClose: () => void; asset: QuoteAssetSymbol }) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} locked={busy} mark="§ Account — Withdraw" title={<>Withdraw to a <span className="accent">wallet</span></>}>
      <CustodyGate offline="full" why="Sign in so Sealed knows which ledger account to pay out from.">
        <WithdrawBody key={String(open)} initialAsset={asset} busy={busy} setBusy={setBusy} />
      </CustodyGate>
      <div className="mt-6 border-t border-rule pt-4">
        <p className="section-mark mb-2">§ Custody</p>
        <DisclosureList dense />
      </div>
    </Sheet>
  );
}

function WithdrawBody({ initialAsset, busy, setBusy }: { initialAsset: QuoteAssetSymbol; busy: boolean; setBusy: (b: boolean) => void }) {
  const s = useCustodySession();
  const { info } = useCustodyInfo();
  const account = useCustodyAccount();
  const network = account.data?.network ?? info?.network;
  const [submitted, setSubmitted] = useState<WithdrawalRecord | null>(null);
  const withdrawals = useWithdrawals(!!submitted && submitted.status !== "sent");
  const quoteRows = useMemo(() => (account.data?.balances ?? []).filter((b) => isQuoteAssetSymbol(b.asset) && quoteAssetOffered(b.asset)), [account.data]);
  const [asset, setAsset] = useState<QuoteAssetSymbol>(initialAsset);
  const [amount, setAmount] = useState("");
  const [dest, setDest] = useState(s.wallet ?? "");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!dest && s.wallet) setDest(s.wallet);
  }, [s.wallet, dest]);

  const bal = balanceOf(account.data, asset);
  const n = Number(amount);
  const usd = assetUsd(asset, n);
  const overAuto = usd > WITHDRAWAL_LIMITS.autoApproveMaxUsd;
  const destOk = validAddress(dest);
  const over = n > bal.available + 1e-12;
  const canSubmit = n > 0 && !over && destOk && !busy;
  const live = submitted ? withdrawals.data?.find((w) => w.id === submitted.id) ?? submitted : null;

  useEffect(() => {
    if (live?.status === "sent" || live?.status === "failed" || live?.status === "rejected") invalidateCustody(s.wallet);
  }, [live?.status, s.wallet]);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const rec = await custodyFetch<WithdrawalRecord>(CUSTODY_ROUTES.withdrawals, { method: "POST", wallet: s.wallet, body: { asset, amount: n, destination: dest } });
      setSubmitted(rec);
      setAmount("");
      invalidateCustody(s.wallet);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (live) {
    return (
      <div aria-live="polite">
        <dl className="grid grid-cols-2 border-y border-ink text-sm">
          <div className="border-b border-rule py-3 pr-3"><dt className="eyebrow">Amount</dt><dd className="num mt-1">{live.amount} {live.asset}</dd></div>
          <div className="border-b border-l border-rule py-3 pl-3"><dt className="eyebrow">Status</dt><dd className="mt-1"><StatusChip status={live.status} /></dd></div>
          <div className="col-span-2 py-3"><dt className="eyebrow">Destination</dt><dd className="num mt-1 break-all text-[13px]">{live.destination}</dd></div>
        </dl>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-slate">
          {live.status === "sent" ? (
            <>Sent from the company wallet.</>
          ) : live.status === "pending_approval" ? (
            <>
              This withdrawal is waiting for manual approval by Sealed
              {info?.payoutsEnabled === false ? ` (${payoutsPausedCopy(info.payoutsReason).toLowerCase()})` : " (above the automatic limit, or payouts are paused)"}. The amount stays locked until it&apos;s approved or rejected.
            </>
          ) : live.status === "failed" || live.status === "rejected" ? (
            <span className="text-burn">{live.status === "failed" ? "The payout failed" : "The withdrawal was rejected"}{live.reason ? `: ${live.reason}` : "."} The amount was returned to your balance.</span>
          ) : (
            <>Queued. Sealed&apos;s payout worker will send it from the company wallet shortly.</>
          )}
        </p>
        {live.signature && (
          <a href={explorerTx(live.signature, network)} target="_blank" rel="noreferrer" className="btn-link num mt-3 !text-[12px]">
            View on Solscan · {shortAddr(live.signature, 8)} <ArrowUpRight width={12} height={12} />
          </a>
        )}
        <button type="button" className="btn-ghost mt-5 min-h-[44px] w-full" onClick={() => setSubmitted(null)}>New withdrawal</button>
      </div>
    );
  }

  return (
    <div>
      {info?.payoutsEnabled === false && <PayoutsPausedNotice reason={info.payoutsReason} compact className="mb-4" />}
      {quoteRows.length === 0 && account.data && (
        <p className="mb-4 rounded-field border border-rule bg-paper-deep/60 p-3 text-[12px] text-ink-slate">You have no withdrawable balance yet.</p>
      )}
      <div role="radiogroup" aria-label="Asset" className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {(quoteRows.length ? quoteRows.map((r) => r.asset as QuoteAssetSymbol) : [asset]).map((a) => (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={a === asset}
            onClick={() => setAsset(a)}
            className={clsx(
              "inline-flex h-11 shrink-0 items-center rounded-full border px-4 font-mono text-[12px] transition",
              a === asset ? "border-ink bg-ink text-paper" : "border-rule bg-sheet text-ink-slate hover:border-rule-strong hover:text-ink",
            )}
          >
            {a}
          </button>
        ))}
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="wd-amount" className="label">Amount <span className="font-mono text-ink-muted">{asset}</span></label>
          <button type="button" className="mb-1.5 min-h-[32px] font-mono text-[11px] text-ink-slate underline decoration-rule-strong underline-offset-2 hover:text-ink" onClick={() => setAmount(String(bal.available))}>
            avail. {bal.available.toLocaleString("en-US", { maximumFractionDigits: 6 })}
          </button>
        </div>
        <input
          id="wd-amount"
          data-autofocus
          inputMode="decimal"
          autoComplete="off"
          className={clsx("input num text-base", over && "!border-burn")}
          placeholder="0.00"
          value={amount}
          onChange={(e) => {
            const v = cleanAmount(e.target.value);
            if (v !== null) setAmount(v);
          }}
        />
        <p className="fine mt-1.5">
          {n > 0 && <>≈ <span className="num">{fmtUsd(usd, false)}</span> · </>}
          {bal.locked > 0 && <><span className="num">{bal.locked}</span> {asset} locked in bids or pending withdrawals · </>}
          Auto-approved up to <span className="num">{fmtUsd(WITHDRAWAL_LIMITS.autoApproveMaxUsd, false)}</span>; daily limit <span className="num">{fmtUsd(WITHDRAWAL_LIMITS.dailyPerWalletUsd, false)}</span>.
        </p>
        {over && <p className="mt-1 text-[12px] text-burn">More than your available balance.</p>}
      </div>

      <div className="mt-4">
        <label htmlFor="wd-dest" className="label">Destination wallet</label>
        <input id="wd-dest" className={clsx("input num text-[13px]", dest && !destOk && "!border-burn")} value={dest} onChange={(e) => setDest(e.target.value.trim())} autoComplete="off" spellCheck={false} />
        <p className="fine mt-1.5">
          {dest === s.wallet ? "Your connected wallet." : dest && !destOk ? <span className="text-burn">Not a valid Solana address.</span> : <button type="button" className="underline underline-offset-2" onClick={() => s.wallet && setDest(s.wallet)}>Use my connected wallet</button>}
        </p>
      </div>

      {(overAuto || info?.payoutsEnabled === false) && n > 0 && (
        <p className="mt-4 rounded-field border border-signal/20 bg-signal-tint/50 p-3 text-[12px] leading-relaxed text-signal-ink">
          {info?.payoutsEnabled === false
            ? `${payoutsPausedCopy(info.payoutsReason)}, so this withdrawal will wait for manual approval.`
            : "This amount is above the automatic limit and will wait for manual approval."}
        </p>
      )}
      {err && <p className="mt-4 rounded-field border border-burn/20 bg-burn-tint p-3 text-[12px] text-burn">{err}</p>}

      <button type="button" className="btn-primary mt-5 min-h-[48px] w-full" disabled={!canSubmit} onClick={() => void submit()}>
        {busy ? "Requesting…" : `Withdraw ${n > 0 ? n : ""} ${asset}`}
      </button>
      <p className="fine mt-2">Paid out from Sealed&apos;s company wallet; arrival is visible on Solscan once sent.</p>
    </div>
  );
}
