"use client";
// Owned by web-offchain-agent. Deposit into the Sealed custodial account.
//  1. GET /api/account/deposit/:asset → company wallet + memo `sealed:<depositRef>`
//  2. either one click: build SystemProgram/SPL transfer + Memo, the USER signs it in their wallet (we never see keys),
//     or send manually (QR / copy address + memo)
//  3. POST /api/account/deposits {signature} nudges detection, then poll: detected → confirmed → credited
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  COMPANY_WALLET,
  CUSTODY_ROUTES,
  QUOTE_ASSETS,
  QUOTE_ASSET_LIST,
  type DepositInstructions,
  type DepositRecord,
  type QuoteAssetSymbol,
} from "@sealed/shared";
import {
  buildDepositTransaction,
  custodyFetch,
  invalidateCustody,
  solanaPayUrl,
  useCustodyAccount,
  useCustodyInfo,
  useCustodySession,
  useDeposits,
} from "@/lib/custody";
import { errorMessage } from "@/lib/defi/config";
import { shortAddr } from "@/lib/format";
import { Sheet } from "./Sheet";
import { CustodyGate } from "./SignInButton";
import { CopyField, DepositSteps, DisclosureList, QrCode, cleanAmount, explorerAccount, explorerTx } from "./parts";
import { ArrowUpRight } from "../ui/Icons";

type Phase = "idle" | "building" | "signing" | "sent" | "error";

export function DepositSheet({ open, onClose, asset: initialAsset, suggested }: { open: boolean; onClose: () => void; asset: QuoteAssetSymbol; suggested?: number }) {
  const [asset, setAsset] = useState<QuoteAssetSymbol>(initialAsset);
  useEffect(() => {
    if (open) setAsset(initialAsset);
  }, [open, initialAsset]);
  const [phase, setPhase] = useState<Phase>("idle");
  return (
    <Sheet
      open={open}
      onClose={onClose}
      locked={phase === "signing" || phase === "building"}
      mark="§ Account — Deposit"
      title={<>Fund your <span className="accent">account</span></>}
    >
      <CustodyGate offline="full" why="Sign in so Sealed can give you your personal deposit memo. It's a message signature, not a transaction.">
        <DepositBody key={`${asset}-${open}`} asset={asset} setAsset={setAsset} suggested={suggested} phase={phase} setPhase={setPhase} />
      </CustodyGate>
      <div className="mt-6 border-t border-rule pt-4">
        <p className="section-mark mb-2">§ Custody</p>
        <DisclosureList dense />
      </div>
    </Sheet>
  );
}

function DepositBody({
  asset,
  setAsset,
  suggested,
  phase,
  setPhase,
}: {
  asset: QuoteAssetSymbol;
  setAsset: (a: QuoteAssetSymbol) => void;
  suggested?: number;
  phase: Phase;
  setPhase: (p: Phase) => void;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const s = useCustodySession();
  const { info } = useCustodyInfo();
  const account = useCustodyAccount();
  const network = account.data?.network ?? info?.network;
  const [ins, setIns] = useState<DepositInstructions | null>(null);
  const [insErr, setInsErr] = useState<string | null>(null);
  const [amount, setAmount] = useState(suggested && suggested > 0 ? String(Number(suggested.toFixed(6))) : "");
  const [sig, setSig] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [manualSig, setManualSig] = useState("");
  const [nudging, setNudging] = useState(false);
  const deposits = useDeposits(!!sig);

  const assets = useMemo(
    () => QUOTE_ASSET_LIST.filter((q) => q.symbol === asset || q.kind === "native" || (network && q.mints[network === "mainnet" ? "mainnet" : network])),
    [asset, network],
  );

  useEffect(() => {
    let cancelled = false;
    setIns(null);
    setInsErr(null);
    if (!s.wallet) return;
    custodyFetch<DepositInstructions>(CUSTODY_ROUTES.depositInstructions(asset), { wallet: s.wallet })
      .then((r) => !cancelled && setIns(r))
      .catch((e) => !cancelled && setInsErr(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [asset, s.wallet]);

  const record: DepositRecord | undefined = sig ? deposits.data?.find((d) => d.signature === sig) : undefined;
  const status = record?.status ?? (sig ? "sent" : null);
  useEffect(() => {
    if (record?.status === "credited") invalidateCustody(s.wallet);
  }, [record?.status, s.wallet]);

  const mismatch = ins && ins.companyWallet !== COMPANY_WALLET;
  const n = Number(amount);

  const depositWithWallet = async () => {
    if (!ins || !publicKey || !sendTransaction) return;
    setErr(null);
    setPhase("building");
    try {
      const { tx, blockhash, lastValidBlockHeight } = await buildDepositTransaction(connection, publicKey, ins, n);
      setPhase("signing");
      const signature = await sendTransaction(tx, connection);
      setSig(signature);
      setPhase("sent");
      custodyFetch(CUSTODY_ROUTES.deposits, { method: "POST", wallet: s.wallet, body: { signature } }).catch(() => undefined);
      connection
        .confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed")
        .then(() => {
          void deposits.refetch();
          custodyFetch(CUSTODY_ROUTES.deposits, { method: "POST", wallet: s.wallet, body: { signature } }).catch(() => undefined);
        })
        .catch(() => undefined);
    } catch (e) {
      setErr(errorMessage(e));
      setPhase("error");
    }
  };

  const nudge = async () => {
    const signature = manualSig.trim();
    if (signature.length < 64) return setErr("Paste the full transaction signature");
    setNudging(true);
    setErr(null);
    try {
      await custodyFetch<DepositRecord>(CUSTODY_ROUTES.deposits, { method: "POST", wallet: s.wallet, body: { signature } });
      setSig(signature);
      setManualSig("");
      void deposits.refetch();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setNudging(false);
    }
  };

  const busy = phase === "building" || phase === "signing";
  const q = QUOTE_ASSETS[asset];

  return (
    <div>
      {/* asset */}
      <div role="radiogroup" aria-label="Asset" className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {assets.map((a) => (
          <button
            key={a.symbol}
            type="button"
            role="radio"
            aria-checked={a.symbol === asset}
            disabled={busy}
            onClick={() => {
              setAsset(a.symbol);
              setSig(null);
              setPhase("idle");
            }}
            className={clsx(
              "inline-flex h-11 shrink-0 items-center rounded-full border px-4 font-mono text-[12px] transition",
              a.symbol === asset ? "border-ink bg-ink text-paper" : "border-rule bg-sheet text-ink-slate hover:border-rule-strong hover:text-ink",
            )}
          >
            {a.symbol}
          </button>
        ))}
      </div>

      {insErr && <p className="mt-4 rounded-field border border-burn/20 bg-burn-tint p-3 text-[12px] text-burn">{insErr}</p>}
      {mismatch && (
        <p className="mt-4 rounded-field border border-burn/20 bg-burn-tint p-3 text-[12px] text-burn">
          The deposit address returned by the server does not match Sealed&apos;s published company wallet. Do not send funds; contact support.
        </p>
      )}

      {!ins && !insErr && <div className="mt-4 h-40 animate-pulse rounded-field bg-paper-deep" aria-hidden />}

      {ins && !mismatch && (
        <>
          {/* one-click */}
          <section className="mt-5" aria-label="Deposit with wallet">
            <label htmlFor="dep-amount" className="label">Amount <span className="font-mono text-ink-muted">{asset}</span></label>
            <div className="flex gap-2">
              <input
                id="dep-amount"
                data-autofocus
                inputMode="decimal"
                autoComplete="off"
                className="input num min-w-0 flex-1 text-base"
                placeholder="0.00"
                value={amount}
                disabled={busy}
                onChange={(e) => {
                  const v = cleanAmount(e.target.value);
                  if (v !== null) setAmount(v);
                }}
              />
            </div>
            <button type="button" className="btn-primary mt-3 min-h-[48px] w-full" disabled={!(n > 0) || busy || !publicKey} onClick={() => void depositWithWallet()}>
              {phase === "building" ? "Preparing transfer…" : phase === "signing" ? "Approve in your wallet…" : `Deposit ${n > 0 ? n : ""} ${asset} with wallet`}
            </button>
            <p className="fine mt-2">
              Your wallet shows a transfer to <span className="num text-ink-slate">{shortAddr(ins.companyWallet, 4)}</span> with memo{" "}
              <span className="num text-ink-slate">{ins.memo}</span>. You approve it there; Sealed never sees your keys.
            </p>
            {err && <p className="mt-3 rounded-field border border-burn/20 bg-burn-tint p-3 text-[12px] text-burn">{err}</p>}
          </section>

          {/* status tracking */}
          {sig && (
            <section className="mt-5" aria-live="polite" aria-label="Deposit status">
              <DepositSteps status={status} />
              <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
                <a href={explorerTx(sig, network)} target="_blank" rel="noreferrer" className="btn-link num !text-[12px]">
                  {shortAddr(sig, 8)} <ArrowUpRight width={12} height={12} />
                </a>
                <span className="text-ink-slate">
                  {status === "credited"
                    ? <>Credited <span className="num text-ink">{record?.amount}</span> {record?.asset}</>
                    : status === "rejected"
                      ? <span className="text-burn">Rejected{record?.reason ? ` · ${record.reason}` : ""}</span>
                      : `Waiting for ${ins.minConfirmations} confirmation${ins.minConfirmations === 1 ? "" : "s"}…`}
                </span>
              </div>
            </section>
          )}

          {/* manual */}
          <div className="my-6 flex items-center gap-3" aria-hidden>
            <span className="h-px flex-1 bg-rule" />
            <span className="eyebrow">or send manually</span>
            <span className="h-px flex-1 bg-rule" />
          </div>
          <section className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start" aria-label="Manual deposit details">
            <div className="flex justify-center sm:block">
              <QrCode value={solanaPayUrl(ins, n > 0 ? n : undefined)} size={152} label={`Solana Pay QR code: send ${asset} to the Sealed company wallet with memo ${ins.memo}`} />
            </div>
            <div className="min-w-0 space-y-2">
              <CopyField label="Company wallet" value={ins.companyWallet} />
              <CopyField label="Memo (required)" value={ins.memo} />
              {ins.mint && <CopyField label={`${asset} mint`} value={ins.mint} display={shortAddr(ins.mint, 8)} />}
            </div>
          </section>
          <p className="mt-3 rounded-field border border-signal/20 bg-signal-tint/50 p-3 text-[12px] leading-relaxed text-signal-ink">
            Include the memo exactly. Without it Sealed can&apos;t match the transfer to your account automatically.
            {q.kind === "native" ? " Send native SOL." : ` Send ${asset} (SPL) only.`} Credited after {ins.minConfirmations} confirmation{ins.minConfirmations === 1 ? "" : "s"}.
          </p>
          {ins.note && <p className="fine mt-2">{ins.note}</p>}
          <p className="fine mt-2">
            Verify the address on{" "}
            <a className="underline underline-offset-2 hover:text-ink" href={explorerAccount(ins.companyWallet, network)} target="_blank" rel="noreferrer">
              Solscan
            </a>
            .
          </p>

          <div className="mt-5">
            <label htmlFor="dep-sig" className="label">Sent it already? Paste the signature to speed up detection</label>
            <div className="flex gap-2">
              <input id="dep-sig" className="input num min-w-0 flex-1 text-[13px]" placeholder="Transaction signature" value={manualSig} onChange={(e) => setManualSig(e.target.value.trim())} autoComplete="off" spellCheck={false} />
              <button type="button" className="btn-ghost min-h-[44px] shrink-0" disabled={nudging || manualSig.length < 64} onClick={() => void nudge()}>
                {nudging ? "Checking…" : "Check"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
