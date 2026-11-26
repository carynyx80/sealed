"use client";
// Owned by web-offchain-agent. /account — balances, deposit & withdrawal history, custody disclosure and live
// proof-of-reserves (public GET /api/custody/info).
import { useEffect, useState } from "react";
import clsx from "clsx";
import { COMPANY_WALLET, type DepositRecord, type Network, type WithdrawalRecord } from "@sealed/shared";
import { openDeposit, useCustodyAccount, useCustodyInfo, useCustodySession, useDeposits, useWithdrawals } from "@/lib/custody";
import { fmtAmount, shortAddr } from "@/lib/format";
import { BalancesPanel } from "./BalancesPanel";
import { CustodyGate, CustodyOffline, SignInButton } from "./SignInButton";
import { DisclosureList, PayoutsPausedNotice, StatusChip, explorerAccount, explorerTx, payoutsPausedCopy } from "./parts";
import { ArrowUpRight } from "../ui/Icons";

function fmtWhen(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function AccountView() {
  const s = useCustodySession();
  const { info, availability } = useCustodyInfo();
  const acc = useCustodyAccount();
  const network: Network | undefined = acc.data?.network ?? info?.network;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="pb-8 pt-10 sm:pt-14">
      {/* masthead */}
      <header className="grid gap-8 border-b border-ink pb-8 lg:grid-cols-12 lg:items-end">
        <div className="lg:col-span-8">
          <p className="section-mark">§ 05 — Account</p>
          <h1 className="mt-4 font-display text-display-lg text-ink">
            Your <span className="accent">custodial</span> account
          </h1>
          <p className="mt-4 max-w-measure text-[15px] leading-relaxed text-ink-slate">
            Deposit once, then bid, trade and claim instantly against your Sealed balance. Sealed holds the funds; you can withdraw to any wallet.
          </p>
        </div>
        <div className="lg:col-span-4 lg:justify-self-end">
          {!mounted ? (
            <div className="h-11 w-56 animate-pulse rounded-full bg-paper-deep" aria-hidden />
          ) : s.signedIn && s.wallet ? (
            <div className="flex flex-wrap items-center gap-3 lg:justify-end">
              <span className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-rule bg-sheet px-4 text-[13px]">
                <span className="h-1.5 w-1.5 rounded-full bg-gain" aria-hidden />
                <span className="eyebrow">Signed in</span>
                <span className="num text-ink">{shortAddr(s.wallet, 4)}</span>
              </span>
              <button type="button" className="btn-ghost min-h-[44px]" onClick={s.signOut}>Sign out</button>
            </div>
          ) : availability === "available" && s.wallet ? (
            <SignInButton />
          ) : null}
        </div>
      </header>

      {mounted && availability === "unavailable" && (
        <div className="mt-8">
          <CustodyOffline />
        </div>
      )}
      {mounted && availability === "available" && info?.payoutsEnabled === false && (
        <div className="mt-8">
          <PayoutsPausedNotice reason={info.payoutsReason} />
        </div>
      )}

      {/* balances + disclosure */}
      <div className="mt-8 grid gap-6 lg:grid-cols-12">
        <BalancesPanel className="lg:col-span-7" />
        <aside className="card-linen p-5 sm:p-6 lg:col-span-5" aria-labelledby="custody-title">
          <p className="section-mark">§ 02 — Custody disclosure</p>
          <h2 id="custody-title" className="mt-2 font-display text-display-sm text-ink">
            Who holds <span className="accent">what</span>
          </h2>
          <DisclosureList className="mt-4" />
          <div className="mt-5 border-t border-rule pt-4">
            <p className="eyebrow">Company wallet</p>
            <a
              href={explorerAccount(info?.companyWallet ?? acc.data?.companyWallet ?? COMPANY_WALLET, network)}
              target="_blank"
              rel="noreferrer"
              className="num mt-1 inline-flex min-h-[44px] items-center gap-1.5 break-all text-[13px] text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink"
            >
              {info?.companyWallet ?? acc.data?.companyWallet ?? COMPANY_WALLET}
              <ArrowUpRight width={12} height={12} className="shrink-0" />
            </a>
            {info && (
              <p className="fine mt-1">
                Mode <span className="num">{info.mode}</span> · network <span className="num">{info.network}</span> · payouts{" "}
                <span className={clsx("num", info.payoutsEnabled ? "text-gain" : "text-burn")}>{info.payoutsEnabled ? "automatic" : "manual approval"}</span>
                {!info.payoutsEnabled && <> · <span>{payoutsPausedCopy(info.payoutsReason)}</span></>}
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* proof of reserves — night band */}
      <section className="card-night mt-8 overflow-hidden" aria-labelledby="por-title">
        <div className="grid gap-6 p-5 sm:p-8 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <p className="section-mark !text-night-muted">§ 03 — Proof of reserves</p>
            <h2 id="por-title" className="mt-3 font-display text-display-md text-night-text">
              Held <span className="accent">versus</span> owed
            </h2>
            <p className="mt-3 text-[13px] leading-relaxed text-night-muted">
              On-chain balance of the company wallet against the total the ledger owes all users, per asset. A ratio of 1.00× or more means every balance is covered.
            </p>
          </div>
          <div className="min-w-0 lg:col-span-8">
            <Reserves />
          </div>
        </div>
      </section>

      {/* history */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <History kind="deposits" network={network} />
        <History kind="withdrawals" network={network} />
      </div>
    </div>
  );
}

function Reserves() {
  const { info, availability } = useCustodyInfo();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || (availability === "unknown" && !info)) return <div className="h-40 animate-pulse rounded-field bg-night-raised" aria-hidden />;
  if (!info || info.proofOfReserves.length === 0) {
    return (
      <p className="rounded-field border border-night-rule p-4 text-[13px] text-night-muted">
        {availability === "unavailable" ? "Proof of reserves appears here once the custody service is online." : "No reserves reported yet."}
      </p>
    );
  }
  const asOf = Math.max(...info.proofOfReserves.map((r) => r.asOfTs));
  return (
    <div>
      <div role="table" aria-label="Proof of reserves">
        <div role="row" className="hidden grid-cols-[1fr_1.2fr_1.2fr_0.9fr] gap-4 border-b border-night-rule pb-2 sm:grid">
          {["Asset", "On-chain", "Owed to users", "Coverage"].map((h, i) => (
            <span key={h} role="columnheader" className={clsx("font-mono text-[10.5px] uppercase tracking-[0.08em] text-night-muted", i > 0 && "text-right")}>{h}</span>
          ))}
        </div>
        {info.proofOfReserves.map((r) => {
          const ok = r.ratio >= 1;
          const pct = Math.max(0, Math.min(1, r.liabilities > 0 ? r.onchain / r.liabilities : 1));
          return (
            <div key={r.asset} role="row" className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-b border-night-rule py-3 sm:grid-cols-[1fr_1.2fr_1.2fr_0.9fr] sm:items-baseline">
              <span role="cell" className="font-mono text-[13px] text-night-text">{r.asset}</span>
              <span role="cell" className="num text-right text-[13px] text-night-text"><span className="mr-1 text-[10px] text-night-muted sm:hidden">held</span>{fmtAmount(r.onchain)}</span>
              <span role="cell" className="num text-[13px] text-night-muted sm:text-right"><span className="mr-1 text-[10px] sm:hidden">owed</span>{fmtAmount(r.liabilities)}</span>
              <span role="cell" className={clsx("num text-right text-[15px]", ok ? "text-gain-bright" : "text-burn-bright")}>
                {r.liabilities === 0 ? "—" : `${r.ratio.toFixed(2)}×`}
              </span>
              <span className="col-span-2 mt-1 block h-px w-full bg-night-rule sm:col-span-4" aria-hidden>
                <span className={clsx("block h-px", ok ? "bg-gain-bright" : "bg-burn-bright")} style={{ width: `${pct * 100}%` }} />
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.06em] text-night-muted">
        As of {fmtWhen(asOf)} · refreshed every 60s · {info.network}
      </p>
    </div>
  );
}

function History({ kind, network }: { kind: "deposits" | "withdrawals"; network: Network | undefined }) {
  const title = kind === "deposits" ? "Deposits" : "Withdrawals";
  return (
    <section className="card overflow-hidden" aria-labelledby={`${kind}-title`}>
      <div className="flex items-baseline justify-between gap-3 p-5 sm:p-6">
        <div>
          <p className="section-mark">§ {kind === "deposits" ? "04" : "05"} — History</p>
          <h2 id={`${kind}-title`} className="mt-2 font-display text-display-sm text-ink">{title}</h2>
        </div>
      </div>
      <div className="px-5 pb-5 sm:px-6 sm:pb-6">
        <CustodyGate quiet>{kind === "deposits" ? <DepositRows network={network} /> : <WithdrawalRows network={network} />}</CustodyGate>
      </div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="border-t border-rule pt-4 text-[13px] leading-relaxed text-ink-slate">{children}</p>;
}

function DepositRows({ network }: { network: Network | undefined }) {
  const d = useDeposits(false);
  const pending = (d.data ?? []).some((x) => x.status === "detected" || x.status === "confirmed");
  const dd = useDeposits(pending);
  const rows: DepositRecord[] = [...(dd.data ?? d.data ?? [])].sort((a, b) => b.ts - a.ts);
  if (!d.data) return d.error ? <Empty>{d.error}</Empty> : <div className="h-24 animate-pulse rounded-field bg-paper-deep" aria-hidden />;
  if (!rows.length)
    return (
      <Empty>
        No deposits yet.{" "}
        <button type="button" className="btn-link !text-[13px]" onClick={() => openDeposit("SOL")}>Make your first deposit</button>
      </Empty>
    );
  return (
    <ul className="border-t border-ink">
      {rows.map((r) => (
        <li key={r.id} className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-1 border-b border-rule py-3">
          <span className="num text-[14px] text-ink">+{fmtAmount(r.amount)} <span className="text-ink-muted">{r.asset}</span></span>
          <StatusChip status={r.status} />
          <span className="num text-[11px] text-ink-muted">{fmtWhen(r.ts)}{r.reason ? ` · ${r.reason}` : ""}</span>
          <a href={explorerTx(r.signature, network)} target="_blank" rel="noreferrer" className="num inline-flex min-h-[32px] items-center gap-1 justify-self-end text-[11px] text-ink-slate underline decoration-rule-strong underline-offset-2 hover:text-ink">
            {shortAddr(r.signature, 5)} <ArrowUpRight width={11} height={11} />
          </a>
        </li>
      ))}
    </ul>
  );
}

function WithdrawalRows({ network }: { network: Network | undefined }) {
  const w0 = useWithdrawals(false);
  const pending = (w0.data ?? []).some((x) => x.status === "queued" || x.status === "sending" || x.status === "pending_approval");
  const w = useWithdrawals(pending);
  const rows: WithdrawalRecord[] = [...(w.data ?? [])].sort((a, b) => b.ts - a.ts);
  if (!w0.data) return w0.error ? <Empty>{w0.error}</Empty> : <div className="h-24 animate-pulse rounded-field bg-paper-deep" aria-hidden />;
  if (!rows.length) return <Empty>No withdrawals yet.</Empty>;
  return (
    <ul className="border-t border-ink">
      {rows.map((r) => (
        <li key={r.id} className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-1 border-b border-rule py-3">
          <span className="num text-[14px] text-ink">−{fmtAmount(r.amount)} <span className="text-ink-muted">{r.asset}</span></span>
          <StatusChip status={r.status} />
          <span className="num min-w-0 truncate text-[11px] text-ink-muted">{fmtWhen(r.ts)} · to {shortAddr(r.destination, 4)}{r.reason ? ` · ${r.reason}` : ""}</span>
          {r.signature ? (
            <a href={explorerTx(r.signature, network)} target="_blank" rel="noreferrer" className="num inline-flex min-h-[32px] items-center gap-1 justify-self-end text-[11px] text-ink-slate underline decoration-rule-strong underline-offset-2 hover:text-ink">
              {shortAddr(r.signature, 5)} <ArrowUpRight width={11} height={11} />
            </a>
          ) : (
            <span className="justify-self-end font-mono text-[11px] text-ink-muted">{r.status === "pending_approval" ? "awaiting approval" : "not sent yet"}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
