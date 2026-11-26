"use client";
// Owned by web-offchain-agent. Deposit into the Sealed custodial account.
//  1. GET /api/account/deposit/:asset → company wallet + memo `sealed:<depositRef>`
//  2. either one click: build SystemProgram/SPL transfer + Memo (+ priority fee), simulate it, show a real-money
//     review (amount, asset, destination company wallet, fee, "funds go to Sealed custody"), then the USER signs it
//     in their wallet (we never see keys); or send manually (QR / copy address + memo)
//  3. confirm by polling getSignatureStatuses; POST /api/account/deposits {signature} nudges detection, then poll
//     the ledger: detected → confirmed → credited
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
  prepareDepositTransaction,
  type PreparedDeposit,
  custodyFetch,
  invalidateCustody,
  solanaPayUrl,
  useCustodyAccount,
  useCustodyInfo,
  useCustodySession,
  useDeposits,
} from "@/lib/custody";
import { errorMessage, isUserRejection } from "@/lib/defi/config";
import { IS_MAINNET, NETWORK_LABEL } from "@/lib/config";
import { quoteAssetOffered } from "@/lib/quoteAssets";
import { ConfirmationTimeoutError, confirmSignature } from "@/lib/solana/tx";
import { shortAddr } from "@/lib/format";
import { Sheet } from "./Sheet";
import { CustodyGate } from "./SignInButton";
import { CopyField, DepositSteps, DisclosureList, QrCode, cleanAmount, explorerAccount, explorerTx } from "./parts";
import { ArrowUpRight } from "../ui/Icons";

type Phase = "idle" | "building" | "review" | "signing" | "sent" | "error";

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

  // Mainnet: only the enabled allowlist (SOL, USDC). Devnet: native + anything with a mint on this network.
  const assets = useMemo(
    () =>
      IS_MAINNET
        ? QUOTE_ASSET_LIST.filter((q) => quoteAssetOffered(q.symbol))
        : QUOTE_ASSET_LIST.filter((q) => q.symbol === asset || q.kind === "native" || (network && q.mints[network === "mainnet" ? "mainnet" : network])),
    [asset, network],
  );
  const assetOffered = quoteAssetOffered(asset);
  const [prepared, setPrepared] = useState<PreparedDeposit | null>(null);
  const [ack, setAck] = useState(!IS_MAINNET);
  const [confirmState, setConfirmState] = useState<"pending" | "confirmed" | "failed" | "timeout" | null>(null);

  // Never leave a disabled asset selected (e.g. a stale "deposit NVDAx" CTA on mainnet).
  useEffect(() => {
    if (!assetOffered && assets[0]) setAsset(assets[0].symbol);
  }, [assetOffered, assets, setAsset]);

  useEffect(() => {
    let cancelled = false;
    setIns(null);
    setInsErr(null);
    if (!s.wallet || !assetOffered) return;
    custodyFetch<DepositInstructions>(CUSTODY_ROUTES.depositInstructions(asset), { wallet: s.wallet })
      .then((r) => !cancelled && setIns(r))
      .catch((e) => !cancelled && setInsErr(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [asset, s.wallet, assetOffered]);

  const record: DepositRecord | undefined = sig ? deposits.data?.find((d) => d.signature === sig) : undefined;
  const status = record?.status ?? (sig ? "sent" : null);
  useEffect(() => {
    if (record?.status === "credited") invalidateCustody(s.wallet);
  }, [record?.status, s.wallet]);

  const mismatch = ins && ins.companyWallet !== COMPANY_WALLET;
  const n = Number(amount);

  /** Step 1: build + simulate, then show the review panel. Nothing is signed yet. */
  const review = async () => {
    if (!ins || !publicKey) return;
    setErr(null);
    setPrepared(null);
    setPhase("building");
    try {
      setPrepared(await prepareDepositTransaction(connection, publicKey, ins, n));
      setAck(!IS_MAINNET);
      setPhase("review");
    } catch (e) {
      setErr(errorMessage(e));
      setPhase("error");
    }
  };

  /** Step 2: re-build with a fresh blockhash (re-simulated), the user signs in their wallet, then poll for confirmation. */
  const confirmAndSend = async () => {
    if (!ins || !publicKey || !sendTransaction || !prepared) return;
    setErr(null);
    setPhase("signing");
    try {
      const fresh = await prepareDepositTransaction(connection, publicKey, ins, prepared.amount);
      const signature = await sendTransaction(fresh.tx, connection, { preflightCommitment: "confirmed", maxRetries: 3 });
      setSig(signature);
      setPhase("sent");
      setConfirmState("pending");
      const nudge = () => custodyFetch(CUSTODY_ROUTES.deposits, { method: "POST", wallet: s.wallet, body: { signature } }).catch(() => undefined);
      void nudge();
      confirmSignature(connection, signature, { lastValidBlockHeight: fresh.lastValidBlockHeight })
        .then((r) => {
          setConfirmState(r.err ? "failed" : "confirmed");
          if (r.err) setErr("The transfer failed on-chain. No funds left your wallet beyond the network fee.");
          void deposits.refetch();
          void nudge();
        })
        .catch((e) => {
          setConfirmState(e instanceof ConfirmationTimeoutError ? "timeout" : "failed");
          setErr(errorMessage(e));
        });
    } catch (e) {
      if (isUserRejection(e)) {
        setPhase("review");
        setErr("You declined the transfer in your wallet. Nothing was sent.");
        return;
      }
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
  const reviewing = (phase === "review" || phase === "signing") && !!prepared;
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
                disabled={busy || reviewing}
                onChange={(e) => {
                  const v = cleanAmount(e.target.value);
                  if (v !== null) setAmount(v);
                }}
              />
            </div>
            {!reviewing && (
              <>
                <button type="button" className="btn-primary mt-3 min-h-[48px] w-full" disabled={!(n > 0) || busy || !publicKey || !!sig} onClick={() => void review()}>
                  {phase === "building" ? "Checking the transfer…" : `Review deposit${n > 0 ? ` of ${n} ${asset}` : ""}`}
                </button>
                <p className="fine mt-2">
                  You&apos;ll see the exact amount, destination and fee before your wallet asks you to approve. Sealed never sees your keys.
                </p>
              </>
            )}
            {reviewing && prepared && (
              <DepositReview
                p={prepared}
                ack={ack}
                setAck={setAck}
                signing={phase === "signing"}
                onBack={() => {
                  setPhase("idle");
                  setPrepared(null);
                  setErr(null);
                }}
                onConfirm={() => void confirmAndSend()}
              />
            )}
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
                      : confirmState === "pending"
                        ? "Confirming on-chain…"
                        : confirmState === "timeout"
                          ? "Still confirming. Sealed credits it once it lands."
                          : `Confirmed · waiting for Sealed to credit it (${ins.minConfirmations} confirmation${ins.minConfirmations === 1 ? "" : "s"})…`}
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

/** Real-money confirmation: what leaves the wallet, where it goes, who holds it afterwards. */
function DepositReview({
  p,
  ack,
  setAck,
  signing,
  onBack,
  onConfirm,
}: {
  p: PreparedDeposit;
  ack: boolean;
  setAck: (v: boolean) => void;
  signing: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const companyShort = shortAddr(p.destination, 4);
  return (
    <div className="mt-4 rounded-field border border-ink bg-white" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3 border-b border-rule px-4 pb-2 pt-3">
        <p className="eyebrow">Review transfer · {NETWORK_LABEL}</p>
        {IS_MAINNET && <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-burn">Real funds</span>}
      </div>
      <dl className="divide-y divide-rule px-4 text-[13px]">
        <div className="flex items-baseline justify-between gap-3 py-2.5">
          <dt className="text-ink-slate">You send</dt>
          <dd className="num text-right text-[17px] text-ink">
            {p.amount.toLocaleString("en-US", { maximumFractionDigits: 9 })} <span className="text-ink-muted">{p.asset}</span>
          </dd>
        </div>
        <div className="py-2.5">
          <dt className="flex items-baseline justify-between gap-3 text-ink-slate">
            <span>To · Sealed company wallet</span>
            <span className="num text-ink">{companyShort}</span>
          </dt>
          <dd className="num mt-1 break-all text-[11.5px] leading-snug text-ink-muted">{p.destination}</dd>
          {p.destinationTokenAccount && (
            <dd className="mt-1 text-[11px] leading-snug text-ink-muted">
              {p.asset} lands in its token account <span className="num">{shortAddr(p.destinationTokenAccount, 4)}</span>
              {p.rentSol > 0 ? <> (created by this transfer: <span className="num">{p.rentSol.toFixed(5)}</span> SOL rent, one time)</> : null}.
            </dd>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-3 py-2.5">
          <dt className="text-ink-slate">Memo</dt>
          <dd className="num truncate text-right text-ink">{p.memo}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-2.5">
          <dt className="text-ink-slate">Network fee (est.)</dt>
          <dd className="num text-right text-ink">≈ {p.feeSol.toFixed(6)} SOL</dd>
        </div>
      </dl>
      <div className="border-t border-rule px-4 py-3">
        <p className="text-[12px] leading-relaxed text-ink-slate">
          Funds go to <span className="font-semibold text-ink">Sealed custody</span>: the company wallet holds them and your Sealed balance is
          credited after confirmation. You can withdraw to any wallet. Simulated successfully just now.
        </p>
        {IS_MAINNET && (
          <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[12px] leading-relaxed text-ink">
            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-ink" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={signing} />
            <span>
              I&apos;m sending real {p.asset} on Solana mainnet to {companyShort}, and Sealed will hold it on my behalf.
            </span>
          </label>
        )}
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn-ghost min-h-[48px] shrink-0" onClick={onBack} disabled={signing}>
            Back
          </button>
          <button type="button" className="btn-primary min-h-[48px] flex-1" data-autofocus disabled={!ack || signing} onClick={onConfirm}>
            {signing ? "Approve in your wallet…" : `Confirm & send ${p.amount} ${p.asset}`}
          </button>
        </div>
      </div>
    </div>
  );
}
