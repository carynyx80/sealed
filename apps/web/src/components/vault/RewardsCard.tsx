"use client";
import { useState } from "react";
import type { LaunchSummary } from "@sealed/shared";
import { useClaimRewards } from "@/lib/defi/useClaimRewards";
import { fmtAmount, fmtCompact, shortAddr } from "@/lib/format";
import { ShieldedBalance } from "@/components/privacy/ShieldedBalance";
import { RollingNumber } from "../motion/RollingNumber";
import { AntiSnipeBadge } from "./AntiSnipeBadge";

export function RewardsCard({ launch }: { launch: LaunchSummary }) {
  const { reward, loading, claim } = useClaimRewards(launch);
  const [sig, setSig] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const q = launch.quoteAsset;
  const fly = launch.status === "flywheel";

  const onClaim = async () => {
    setBusy(true);
    setErr(null);
    try {
      const s = await claim();
      setSig(s || null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card p-5 sm:p-6" aria-label="Your claimable rewards">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
        <p className="section-mark">§ Rewards — Yours</p>
        <AntiSnipeBadge eligible={reward ? reward.eligible : null} />
      </div>
      <h2 className="mt-2 font-display text-display-sm text-ink">Claimable rewards</h2>

      {loading ? (
        <div className="mt-4 h-12 animate-pulse rounded-field bg-paper-deep" />
      ) : reward ? (
        <>
          <p className="mt-3 flex items-baseline gap-2">
            <RollingNumber value={reward.claimable} className="text-[2.25rem] leading-none tracking-[-0.03em] text-ink" />
            <span className="font-mono text-[12px] uppercase text-ink-muted">{q}</span>
          </p>
          <dl className="mt-4 border-t border-rule">
            <div className="flex items-baseline justify-between gap-3 border-b border-rule py-2 text-[12px]">
              <dt className="text-ink-slate">Staked</dt>
              <dd className="num text-ink">{fmtCompact(reward.staked, 2)} <span className="text-ink-muted">{launch.ticker}</span></dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 border-b border-rule py-2 text-[12px]">
              <dt className="text-ink-slate">Claimed to date</dt>
              <dd className="num text-ink">{fmtAmount(reward.claimed)} <span className="text-ink-muted">{q}</span></dd>
            </div>
          </dl>
          <button className="btn-primary mt-4 w-full" disabled={busy || !reward.eligible || reward.claimable <= 0} onClick={onClaim}>
            {busy ? "Claiming…" : `Claim ${q}`}
          </button>
          {sig && <p className="num mt-2 text-[11px] text-gain">Claimed · {shortAddr(sig, 8)}</p>}
          {err && <p className="mt-2 text-[11px] text-burn">{err}</p>}
        </>
      ) : (
        <p className="mt-3 text-[13px] leading-relaxed text-ink-slate">
          Connect a wallet holding <span className="num text-ink">${launch.ticker}</span> to see payouts.{" "}
          {fly ? <>Half of every fee is paid to holders in <span className="num text-ink">{q}</span>.</> : <>Once the credit is 100% repaid, half of every fee flows to holders in <span className="num text-ink">{q}</span>.</>}
        </p>
      )}

      <div className="mt-4 empty:hidden">
        <ShieldedBalance quoteAsset={launch.quoteAsset} compact />
      </div>

      <p className="mt-4 border-t border-rule pt-3 font-mono text-[10px] leading-relaxed text-ink-muted">
        * Wallets that buy in the same slot as graduation are written to the Anti-Snipe Registry and receive 0% of holder rewards.
      </p>
    </section>
  );
}
