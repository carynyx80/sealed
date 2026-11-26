"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useReducedMotion } from "@/components/motion/reduced";
import { useEffect, useRef, useState } from "react";
import { useModal } from "../custody/useModal";
import clsx from "clsx";
import type { LaunchSummary } from "@sealed/shared";
import type { CommitArgs, CommitResult, SealedBidStatus } from "@/lib/defiTypes";
import { fmtAmount, fmtPrice, shortAddr, solscanTx } from "@/lib/format";
import { useCustodyInfo } from "@/lib/custody";
import { SPRING } from "../motion/spring";
import { CheckIcon, LockIcon, XIcon } from "../ui/Icons";

const ONCHAIN_STEPS: { id: SealedBidStatus; label: string }[] = [
  { id: "hashing", label: "Hashing commitment (keccak256)" },
  { id: "signing", label: "Signing in your wallet" },
  { id: "submitting", label: "Submitting sealed commit" },
  { id: "done", label: "Sealed & escrowed" },
];
/** Offchain custodial mode: the commitment is recorded by Sealed's ledger; the deposit is locked from the Sealed balance. */
const LEDGER_STEPS: { id: SealedBidStatus; label: string }[] = [
  { id: "hashing", label: "Hashing commitment (keccak256)" },
  { id: "signing", label: "Signing in to Sealed" },
  { id: "submitting", label: "Recording commitment on Sealed's ledger" },
  { id: "done", label: "Sealed · deposit locked" },
];
const ORDER: SealedBidStatus[] = ["idle", "hashing", "signing", "submitting", "done"];

export interface SealedBidModalProps {
  open: boolean;
  onClose: () => void;
  launch: LaunchSummary;
  args: CommitArgs;
  status: SealedBidStatus;
  error: string | null;
  onConfirm: () => Promise<CommitResult | null>;
}

export function SealedBidModal({ open, onClose, launch, args, status, error, onConfirm }: SealedBidModalProps) {
  const reduce = useReducedMotion();
  const [result, setResult] = useState<CommitResult | null>(null);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const q = launch.quoteAsset;
  // Same switch useSealedBid uses (custody API reachable → offchain custodial ledger).
  const offchain = useCustodyInfo().availability === "available";
  const STEPS = offchain ? LEDGER_STEPS : ONCHAIN_STEPS;

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setLocalErr(null);
  }, [open]);
  useModal(open, panel, { onClose, locked: busy });

  const confirm = async () => {
    setBusy(true);
    setLocalErr(null);
    try {
      const r = await onConfirm();
      if (r) setResult(r);
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const done = !!result || status === "done";
  const shownStatus: SealedBidStatus = done ? "done" : busy && status === "idle" ? "hashing" : status;
  const cur = ORDER.indexOf(shownStatus);
  const err = localErr ?? (status === "error" ? error : null);

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <button type="button" tabIndex={-1} aria-label="Close" className="absolute inset-0 cursor-default bg-ink/40" onClick={() => !busy && onClose()} />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="sealed-bid-title"
            tabIndex={-1}
            className="relative mb-[var(--kb,0px)] max-h-[min(92dvh,calc(var(--vvh,100dvh)-12px))] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-card border border-rule bg-sheet p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-lift outline-none sm:rounded-card sm:p-6"
            initial={reduce ? { opacity: 0 } : { y: 40, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { y: 30, opacity: 0, scale: 0.98 }}
            transition={SPRING}
          >
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <span className="section-mark">§ Sealed bid · ${launch.ticker}</span>
                <h3 id="sealed-bid-title" className="mt-2 font-display text-display-md text-ink">{done ? <>Your bid is <span className="accent">sealed</span></> : <>Seal your <span className="accent">bid</span></>}</h3>
              </div>
              <button type="button" onClick={() => !busy && onClose()} disabled={busy} className="-mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-rule text-ink-slate disabled:opacity-40 transition hover:border-rule-strong hover:text-ink" aria-label="Close dialog">
                <XIcon />
              </button>
            </div>

            <dl className="grid grid-cols-2 border-y border-ink text-sm">
              <div className="border-b border-rule py-3 pr-3"><dt className="eyebrow">Max price · sealed</dt><dd className="num mt-1">{fmtPrice(args.maxPrice)} {q}</dd></div>
              <div className="border-b border-l border-rule py-3 pl-3"><dt className="eyebrow">Bid amount · sealed</dt><dd className="num mt-1">{fmtAmount(args.amount)} {q}</dd></div>
              <div className="py-3 pr-3"><dt className="eyebrow">{offchain ? "Deposit · locked" : args.privateDeposit ? "Deposit · shielded" : "Deposit · public"}</dt><dd className="num mt-1">{fmtAmount(args.deposit)} {q}</dd></div>
              <div className="border-l border-rule py-3 pl-3"><dt className="eyebrow">Auto-reveal</dt><dd className="mt-1 text-[13px]">{args.autoReveal ? "Encrypted to relayer" : "Manual"}</dd></div>
            </dl>

            <p className="mt-4 flex gap-2 text-[12px] leading-relaxed text-ink-slate">
              <LockIcon className="mt-0.5 shrink-0" width={13} height={13} />
              {offchain
                ? <>Sealed&apos;s ledger records only a keccak256 commitment, and your deposit is locked from your Sealed balance. Your price and size stay private until the reveal window.</>
                : <>Only a keccak256 commitment and your deposit go on-chain. Your price and size stay private until the reveal window.</>}
            </p>

            <ol className="mt-5 space-y-2.5">
              {STEPS.map((s, i) => {
                const reached = cur >= i + 1;
                const active = cur === i + 1 && !done && busy;
                return (
                  <li key={s.id} className="flex items-center gap-3 text-sm">
                    <span className={clsx("flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[10px]", reached ? "border-ink bg-ink text-paper" : "border-rule-strong text-ink-muted", active && "animate-pulse-soft")}>
                      {reached ? <CheckIcon width={11} height={11} /> : i + 1}
                    </span>
                    <span className={reached ? "text-ink" : "text-ink-muted"}>{s.label}</span>
                  </li>
                );
              })}
            </ol>

            {result && (result.commitmentHex || result.signature) && (
              <div className="mt-4 space-y-1 rounded-field border border-gain/20 bg-gain-tint p-3 text-[12px] text-gain">
                {result.commitmentHex && <p className="num break-all">commitment {shortAddr(result.commitmentHex, 10)}</p>}
                {result.signature && <Receipt signature={result.signature} launch={launch} />}
                {result.autoRevealQueued && <p>Auto-reveal queued with the relayer.</p>}
              </div>
            )}
            {err && <p className="mt-4 rounded-field border border-burn/20 bg-burn-tint p-3 text-[12px] text-burn">{err}</p>}

            <div className="mt-6 flex gap-3">
              {done ? (
                <button type="button" className="btn-primary min-h-[48px] w-full" onClick={onClose}>Done</button>
              ) : (
                <>
                  <button type="button" className="btn-ghost min-h-[48px] flex-1" onClick={onClose} disabled={busy}>Cancel</button>
                  <button type="button" data-autofocus className="btn-primary min-h-[48px] flex-1" onClick={confirm} disabled={busy}>
                    <LockIcon width={14} height={14} />
                    {busy ? "Sealing…" : "Seal & commit"}
                  </button>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Ledger refs (`ledger:<id>`) are receipts from Sealed's offchain ledger: no explorer link. Only real signatures link to Solscan. */
function Receipt({ signature, launch }: { signature: string; launch: LaunchSummary }) {
  if (signature.startsWith("ledger:")) {
    return <p className="num break-all">Receipt {signature}</p>;
  }
  if (launch.isDemo || signature.startsWith("demo")) {
    return <p className="num">Receipt recorded</p>;
  }
  return (
    <p className="num break-all">
      tx{" "}
      <a className="underline underline-offset-2" href={solscanTx(signature, launch.network)} target="_blank" rel="noreferrer">
        {shortAddr(signature, 10)}
      </a>
    </p>
  );
}
