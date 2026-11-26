"use client";
import { useMemo, useState } from "react";
import clsx from "clsx";
import { NUM_PRICE_TICKS, type LaunchSummary } from "@sealed/shared";
import { useSealedBid } from "@/lib/defi/useSealedBid";
import { openDeposit, useCustodyBalance, useCustodySession } from "@/lib/custody";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { getDataSource } from "@/lib/api";
import { noteDemoBid } from "@/lib/demoStore";
import { fmtAmount, fmtCompact, fmtInt, fmtPrice } from "@/lib/format";
import { PrivateDepositToggle } from "@/components/privacy/PrivateDepositToggle";
import { Countdown } from "./Countdown";
import { ClearingProgress } from "./ClearingProgress";
import { CommitRevealBadge } from "./CommitRevealBadge";
import { SealedBidModal } from "./SealedBidModal";
import { Toggle } from "../ui/Toggle";
import { EyeOffIcon, LockIcon } from "../ui/Icons";
import { RollingNumber } from "../motion/RollingNumber";
import { SealRing } from "../token/RoomParts";

export function CommitBidCard({ launch }: { launch: LaunchSummary }) {
  const bid = useSealedBid(launch);
  const a = launch.auction;
  const q = launch.quoteAsset;

  const ticks = useMemo(() => {
    if (bid.priceTicks && bid.priceTicks.length > 0) return bid.priceTicks;
    return Array.from({ length: NUM_PRICE_TICKS }, (_, i) => a.floorPrice + i * a.tickSize);
  }, [bid.priceTicks, a.floorPrice, a.tickSize]);

  const [tick, setTick] = useState(() => Math.min(8, ticks.length - 1));
  const [amountStr, setAmountStr] = useState("");
  const [depositStr, setDepositStr] = useState("");
  const [autoReveal, setAutoReveal] = useState(true);
  const [privateDeposit, setPrivateDeposit] = useState(false);
  const [open, setOpen] = useState(false);
  const custody = useCustodySession();
  const offchain = custody.availability === "available";
  const quoteBal = useCustodyBalance(q);
  const { setVisible } = useWalletModal();
  const [revealMsg, setRevealMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [revealing, setRevealing] = useState(false);

  const maxPrice = ticks[Math.min(tick, ticks.length - 1)] ?? a.floorPrice;
  const amount = Number(amountStr) || 0;
  const deposit = depositStr === "" ? amount : Number(depositStr) || 0;
  const tokensAtMax = maxPrice > 0 ? amount / maxPrice : 0;
  const commitOpen = launch.status === "commit";
  const invalid = !commitOpen ? "The commit window is closed." : amount <= 0 ? null : deposit < amount ? "Deposit must cover your bid amount." : null;
  const canSubmit = commitOpen && amount > 0 && deposit >= amount;
  const fill = ticks.length > 1 ? (tick / (ticks.length - 1)) * 100 : 0;
  const multiple = a.floorPrice > 0 ? maxPrice / a.floorPrice : 1;

  const showBal = offchain && custody.signedIn && quoteBal.known;
  const insufficient = showBal && deposit > 0 && deposit > quoteBal.available + 1e-12;
  const gate = !offchain || !commitOpen ? null : !custody.wallet ? "connect" : !custody.signedIn ? "signin" : insufficient ? "deposit" : null;
  const args = { maxPrice, amount, deposit, autoReveal, privateDeposit: offchain ? false : privateDeposit };
  const revealManually = async () => {
    setRevealing(true);
    setRevealMsg(null);
    try {
      await bid.reveal();
      setRevealMsg({ ok: true, text: "Bid revealed. It is included in clearing." });
    } catch (e) {
      setRevealMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRevealing(false);
    }
  };
  const confirm = async () => {
    const r = await bid.commit(args);
    if (getDataSource() === "demo") noteDemoBid(launch.id, deposit);
    return r;
  };

  return (
    <section className="card overflow-hidden" aria-labelledby="commit-title">
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="section-mark">§ Auction · Commit</p>
          <CommitRevealBadge status={launch.status} />
        </div>
        <h2 id="commit-title" className="mt-3 font-display text-display-md text-ink">
          Commit a <span className="accent">sealed</span> bid
        </h2>
      </div>

      {/* public tallies */}
      <dl className="grid grid-cols-3 border-y border-rule">
        <div className="px-5 py-3.5 sm:px-6">
          <dt className="eyebrow">Bids</dt>
          <dd className="mt-1"><RollingNumber value={a.bidCount} format="int" className="text-xl text-ink" /></dd>
        </div>
        <div className="border-l border-rule px-4 py-3.5">
          <dt className="eyebrow">Escrowed</dt>
          <dd className="mt-1 flex items-baseline gap-1">
            <RollingNumber value={a.escrowedWallets} format="int" className="text-xl text-ink" />
            <span className="font-mono text-[10px] text-ink-muted">wallets</span>
          </dd>
        </div>
        <div className="border-l border-rule px-4 py-3.5">
          <dt className="eyebrow">{launch.status === "reveal" ? "Reveal ends" : "Time left"}</dt>
          <dd className="mt-1"><Countdown to={launch.status === "reveal" ? a.revealEndTs : a.commitEndTs} className="text-xl text-ink" /></dd>
        </div>
      </dl>

      <div className="p-5 sm:p-6">
        <ClearingProgress launch={launch} />

        {/* max price on the tick grid */}
        <div className="mt-7">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="max-price" className="text-[13px] font-medium text-ink">Max price per token</label>
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">tick {String(tick + 1).padStart(2, "0")}/{ticks.length}</span>
          </div>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
            <span className="num text-[1.75rem] leading-none tracking-[-0.02em] text-ink">{fmtPrice(maxPrice)}</span>
            <span className="font-mono text-[11px] text-ink-muted">{q}</span>
            <span className="num text-[11px] text-ink-slate">{multiple.toFixed(2)}× floor</span>
          </p>
          <input
            id="max-price"
            type="range"
            className="range mt-1.5 w-full cursor-pointer touch-pan-y !h-11 ![background-size:100%_6px] !bg-center !bg-no-repeat"
            min={0}
            max={ticks.length - 1}
            step={1}
            value={tick}
            onChange={(e) => setTick(Number(e.target.value))}
            style={{ ["--fill" as string]: `${fill}%` }}
            aria-valuetext={`${fmtPrice(maxPrice)} ${q}`}
          />
          {/* tick ruler */}
          <div className="relative mx-[10px] -mt-1 h-3" aria-hidden>
            {ticks.map((_, i) => {
              const major = i % 8 === 0 || i === ticks.length - 1;
              return (
                <span
                  key={i}
                  className={clsx("absolute top-0 w-px", i === tick ? "h-3 bg-ink" : major ? "h-2 bg-ink-slate" : "h-1 bg-rule-strong")}
                  style={{ left: `${(i / Math.max(1, ticks.length - 1)) * 100}%` }}
                />
              );
            })}
          </div>
          <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-muted">
            <span>floor {fmtPrice(a.floorPrice)}</span>
            <span>{fmtPrice(ticks[ticks.length - 1] ?? a.floorPrice)}</span>
          </div>
        </div>

        {/* amount + deposit */}
        <div className="mt-6 grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <label htmlFor="bid-amount" className="label">Bid amount <span className="font-mono text-ink-muted">{q}</span></label>
            <input id="bid-amount" inputMode="decimal" autoComplete="off" className="input num text-base sm:text-sm" placeholder="0.00" value={amountStr} onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9.]/g, ""))} />
          </div>
          <div className="min-w-0">
            <label htmlFor="bid-deposit" className="label">Deposit <span className="font-mono text-ink-muted">{q}</span></label>
            <input id="bid-deposit" inputMode="decimal" autoComplete="off" className="input num text-base sm:text-sm" placeholder={amount ? fmtAmount(amount) : "= amount"} value={depositStr} onChange={(e) => setDepositStr(e.target.value.replace(/[^0-9.]/g, ""))} />
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
          Over-deposit to mask your real size; the excess is refunded at settlement.
          {amount > 0 && <> At your max you receive up to <span className="num text-ink-slate">{fmtCompact(tokensAtMax, 2)}</span> {launch.ticker}.</>}
        </p>
        {showBal && (
          <p className="mt-2 flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] text-ink-muted">
            <span>Account balance</span>
            <span className={clsx("num", insufficient ? "text-burn" : "text-ink-slate")}>{fmtAmount(quoteBal.available)} {q}</span>
            <span>· deposit is locked from it</span>
          </p>
        )}

        {/* what the chain sees */}
        <div className="mt-5 rounded-field border border-signal/20 bg-signal-tint/50 p-4">
          <div className="flex items-center gap-3">
            <SealRing size={30} />
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-signal-ink">Your price and size stay sealed</p>
              <p className="text-[11px] text-ink-slate">{offchain ? "Only a keccak256 commitment is recorded until reveal." : "Only a keccak256 commitment reaches the chain until reveal."}</p>
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 border-t border-signal/15 pt-3 font-mono text-[11px]">
            <div>
              <dt className="text-[10px] uppercase tracking-[0.08em] text-ink-muted">Sealed</dt>
              <dd className="mt-1 flex items-center gap-1.5 text-signal-ink"><LockIcon width={11} height={11} strokeWidth={1.5} /> max price</dd>
              <dd className="mt-0.5 flex items-center gap-1.5 text-signal-ink"><LockIcon width={11} height={11} strokeWidth={1.5} /> bid amount</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-[0.08em] text-ink-muted">Public</dt>
              <dd className="mt-1 text-ink-slate">{privateDeposit ? "deposit · shielded" : deposit > 0 ? `deposit ${fmtAmount(deposit)}` : "deposit n/a"}</dd>
              <dd className="mt-0.5 text-ink-slate">commitment hash</dd>
            </div>
          </dl>
        </div>

        {/* options */}
        <div className="mt-4 divide-y divide-rule border-y border-rule">
          <div className="flex items-start justify-between gap-4 py-4">
            <div className="min-w-0">
              <label htmlFor="auto-reveal" className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                <EyeOffIcon width={14} height={14} strokeWidth={1.5} /> Encrypted auto-reveal
              </label>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-slate">Seal your reveal to the relayer; it is submitted the second the reveal window opens. No missed reveals, no slashing.</p>
            </div>
            <Toggle id="auto-reveal" checked={autoReveal} onChange={setAutoReveal} label="Encrypted auto-reveal" />
          </div>
          {!offchain && (
            <div className="py-4 empty:hidden">
              <PrivateDepositToggle launch={launch} enabled={privateDeposit} onChange={setPrivateDeposit} />
            </div>
          )}
        </div>

        {invalid && amount > 0 && <p className="mt-3 text-[12px] text-burn">{invalid}</p>}
        {gate === "deposit" && (
          <p className="mt-3 text-[12px] leading-relaxed text-burn">
            Insufficient {q} balance: deposit needs <span className="num">{fmtAmount(deposit)}</span>, you have <span className="num">{fmtAmount(quoteBal.available)}</span> available.
          </p>
        )}
        {gate === "signin" && custody.error && <p className="mt-3 text-[12px] text-burn">{custody.error}</p>}
        {gate === "connect" ? (
          <button className="btn-primary mt-5 min-h-[48px] w-full py-3" onClick={() => setVisible(true)}>Connect wallet to bid</button>
        ) : gate === "signin" ? (
          <button className="btn-primary mt-5 min-h-[48px] w-full py-3" disabled={custody.signingIn} onClick={() => void custody.signIn().catch(() => undefined)}>
            {custody.signingIn ? "Check your wallet…" : "Sign in to bid"}
          </button>
        ) : gate === "deposit" ? (
          <button className="btn-primary mt-5 min-h-[48px] w-full py-3" onClick={() => openDeposit(q, Math.max(0, deposit - quoteBal.available))}>
            Deposit {q} to bid
          </button>
        ) : launch.status === "reveal" && offchain ? (
          <button className="btn-primary mt-5 min-h-[48px] w-full py-3" disabled={revealing || !custody.wallet} onClick={() => void revealManually()}>
            <LockIcon width={14} height={14} strokeWidth={1.5} />
            {revealing ? "Revealing…" : "Reveal my bid manually"}
          </button>
        ) : (
          <button className="btn-primary mt-5 w-full py-3" disabled={!canSubmit} onClick={() => setOpen(true)}>
            <LockIcon width={14} height={14} strokeWidth={1.5} />
            {commitOpen ? "Review sealed bid" : "Commit window closed"}
          </button>
        )}
        {launch.status === "reveal" && offchain && !revealMsg && (
          <p className="fine mt-2">Auto-reveal bids are revealed for you. Use this only if you turned auto-reveal off; it reads your salt from this browser&apos;s bid vault.</p>
        )}
        {revealMsg && <p className={clsx("mt-2 text-[12px]", revealMsg.ok ? "text-gain" : "text-burn")}>{revealMsg.text}</p>}
      </div>

      {/* plain-language clearing explainer */}
      <div className="border-t border-rule bg-paper-deep/60 p-5 sm:p-6">
        <p className="section-mark">How you pay · Uniform clearing</p>
        <p className="mt-2 font-display text-[1.05rem] font-semibold leading-snug tracking-[-0.015em] text-ink">
          Everyone who wins pays the <span className="accent">same</span> price.
        </p>
        <ol className="mt-3 space-y-2 text-[12px] leading-relaxed text-ink-slate">
          <li className="grid grid-cols-[1.5rem_1fr]"><span className="num text-ink-muted">01</span><span>When bidding closes, bids are sorted from the highest max price down.</span></li>
          <li className="grid grid-cols-[1.5rem_1fr]"><span className="num text-ink-muted">02</span><span>The price where all <span className="num text-ink">{fmtCompact(a.tokensForSale)}</span> tokens are filled becomes the clearing price.</span></li>
          <li className="grid grid-cols-[1.5rem_1fr]"><span className="num text-ink-muted">03</span><span>Every winner pays that one price, usually below their max. Bids under it are refunded in full, so bidding your honest max is safe.</span></li>
        </ol>
        <p className="mt-4 border-t border-rule pt-3 font-mono text-[10px] leading-relaxed text-ink-muted">
          Target {fmtAmount(a.targetRaise)} {q} · cap {fmtAmount(a.clearingCap)} {q} · {fmtInt(a.revealedCount)} revealed
        </p>
      </div>

      <SealedBidModal open={open} onClose={() => setOpen(false)} launch={launch} args={args} status={bid.status} error={bid.error} onConfirm={confirm} />
    </section>
  );
}
