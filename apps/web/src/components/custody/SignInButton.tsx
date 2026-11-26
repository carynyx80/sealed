"use client";
// Owned by signin-web-agent (was web-offchain-agent). Sign-In-With-Solana button, a gate for signed-in-only content, and the
// header session pill (balance + Deposit / Withdraw / Account / Sign out).
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { isQuoteAssetSymbol, type QuoteAssetSymbol } from "@sealed/shared";
import { openDeposit, openWithdraw, useCustodyAccount, useCustodySession } from "@/lib/custody";
import { isQuietSignInError } from "@/lib/custody/auth";
import { pushWalletToast } from "@/lib/wallet";
import { SPRING } from "../motion/spring";

/** Compact triggers (header pill) have no room for an inline error: surface it as a toast instead. */
function notifySignInError(e: unknown) {
  const message = (e as Error)?.message || "Sign-in failed. Try again.";
  if (isQuietSignInError(e)) pushWalletToast({ tone: "info", title: message }, 3_000);
  else pushWalletToast({ tone: "error", title: "Sign-in failed", body: message }, 8_000);
}

function fmtBal(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 3 : 5 });
}

export function SignInButton({ className, label = "Sign in to Sealed", block = false }: { className?: string; label?: string; block?: boolean }) {
  const s = useCustodySession();
  const { setVisible } = useWalletModal();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <button type="button" className={clsx("btn-primary min-h-[44px]", block && "w-full", className)} disabled>{label}</button>;
  if (!s.wallet) {
    return (
      <button type="button" className={clsx("btn-primary min-h-[44px]", block && "w-full", className)} onClick={() => setVisible(true)}>
        Connect wallet
      </button>
    );
  }
  return (
    <div className={clsx(block && "w-full")}>
      <button
        type="button"
        className={clsx("btn-primary min-h-[44px]", block && "w-full", className)}
        disabled={s.signingIn || !s.canSign}
        aria-busy={s.signingIn || undefined}
        onClick={() => void s.signIn().catch(() => undefined)}
      >
        {s.signingIn ? "Check your wallet…" : !s.canSign ? "This wallet can't sign in" : label}
      </button>
      {s.signingIn && s.statusText ? (
        <p className="fine mt-2 text-ink-slate" aria-live="polite">
          {s.statusText}{" "}
          <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={s.cancel}>
            Cancel
          </button>
        </p>
      ) : (
        <SiwsDomainNote domain={s.messageDomain} signing={s.signingIn} transaction={s.method === "signTransaction"} />
      )}
      {!s.canSign && <p className="mt-2 text-[12px] text-burn">This wallet can&apos;t sign in yet. Try Phantom, Solflare or Backpack.</p>}
      {s.error && !s.signingIn && (
        <p className={clsx("mt-2 text-[12px]", s.errorQuiet ? "text-ink-muted" : "text-burn")} role={s.errorQuiet ? undefined : "alert"}>
          {s.error}
        </p>
      )}
    </div>
  );
}

/**
 * Fine print under the sign-in button: which domain the request is for. Before the nonce arrives we show the
 * current host; once the server request is in hand we show the domain it actually names, and flag a mismatch.
 */
function SiwsDomainNote({ domain, signing, transaction }: { domain: string | null; signing: boolean; transaction?: boolean }) {
  const [host, setHost] = useState<string | null>(null);
  useEffect(() => setHost(window.location.host), []);
  const shown = domain ?? host;
  if (!shown) return null;
  const mismatch = !!domain && !!host && domain !== host;
  return (
    <p className="fine mt-2" aria-live="polite">
      {signing ? "Request to sign is for " : transaction ? "Signature only for " : "Free signature for "}
      <span className="num text-ink-slate">{shown}</span>
      {mismatch ? <> (this page is <span className="num">{host}</span>)</> : null}
      {transaction ? " · never sent, no fee." : " · no transaction, no fee."}
    </p>
  );
}

/** Renders children only when custody is available and the connected wallet is signed in. */
export function CustodyGate({ children, why, offline = "compact", quiet = false }: { children: ReactNode; why?: ReactNode; offline?: "full" | "compact"; quiet?: boolean }) {
  const s = useCustodySession();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || s.availability === "unknown") return <div className="h-24 animate-pulse rounded-field bg-paper-deep" aria-hidden />;
  if (s.availability === "unavailable") return offline === "full" ? <CustodyOffline /> : <p className="border-t border-rule pt-4 text-[13px] leading-relaxed text-ink-muted">Paused while the custody service is offline.</p>;
  if (!s.signedIn && quiet) return <p className="border-t border-rule pt-4 text-[13px] leading-relaxed text-ink-muted">{s.wallet ? "Sign in to see your history." : "Connect a wallet and sign in to see your history."}</p>;
  if (!s.signedIn) {
    return (
      <div className="rounded-field border border-rule bg-paper-deep/60 p-4">
        <p className="text-[13px] font-medium text-ink">{s.wallet ? "Sign in with your wallet" : "Connect a wallet"}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-slate">
          {why ?? "Your wallet signs a one-line message to prove it's yours. It is not a transaction and costs nothing."}
        </p>
        <div className="mt-3">
          <SignInButton block />
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

export function CustodyOffline({ compact = false }: { compact?: boolean }) {
  return (
    <div className={clsx("rounded-field border border-rule bg-paper-deep/60", compact ? "p-3" : "p-4")}>
      <p className="text-[13px] font-medium text-ink">Custody service offline</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-slate">
        The Sealed API isn&apos;t serving account routes right now, so deposits, balances and withdrawals are paused. Nothing is lost; this page reconnects on its own.
      </p>
    </div>
  );
}

/** Header pill: hidden until a wallet is connected and custody is available. */
export function SessionPill({ className, onNavigate, menuAlign = "right" }: { className?: string; onNavigate?: () => void; menuAlign?: "left" | "right" }) {
  const s = useCustodySession();
  const acc = useCustodyAccount();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!mounted || !s.wallet || s.availability !== "available") return null;

  const pill =
    "inline-flex h-11 items-center gap-2 whitespace-nowrap rounded-full border px-4 text-sm font-semibold transition-[transform,border-color] duration-200 hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper md:h-10";

  if (!s.signedIn) {
    return (
      <button
        type="button"
        className={clsx(pill, "border-rule bg-sheet text-ink hover:border-rule-strong", className)}
        disabled={s.signingIn || !s.canSign}
        onClick={() => void s.signIn().catch(notifySignInError)}
        title={s.statusText ?? s.error ?? (s.messageDomain ? `Sign in for ${s.messageDomain} to open your Sealed account` : "Sign in to open your Sealed account")}
        aria-busy={s.signingIn || undefined}
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ink-muted" />
        {s.signingIn ? "Signing…" : "Sign in"}
      </button>
    );
  }

  const balances = acc.data?.balances ?? [];
  const primary = balances.filter((b) => !b.asset.startsWith("tok:")).sort((a, b) => b.available - a.available)[0];
  const asset: QuoteAssetSymbol = primary && isQuoteAssetSymbol(primary.asset) ? primary.asset : "SOL";

  return (
    <div ref={ref} className={clsx("relative inline-block", className)}>
      <button
        type="button"
        className={clsx(pill, "border-rule bg-sheet text-ink hover:border-rule-strong")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-gain" />
        <span className="eyebrow !text-ink-slate">Acct</span>
        <span className="num text-[13px] font-normal">
          {acc.data ? `${fmtBal(primary?.available ?? 0)} ${primary?.symbol ?? "SOL"}` : "…"}
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={SPRING}
            className={clsx("absolute z-50 mt-2 w-64", menuAlign === "left" ? "left-0" : "right-0", " overflow-hidden rounded-card border border-rule bg-sheet p-1.5 text-sm text-ink shadow-lift")}
          >
            <div className="mb-1 border-b border-rule px-3 pb-2.5 pt-1.5">
              <div className="eyebrow">Sealed account · custodial</div>
              <dl className="mt-2 space-y-1">
                {balances.length === 0 && <p className="text-[12px] text-ink-slate">No balance yet.</p>}
                {balances.slice(0, 4).map((b) => (
                  <div key={b.asset} className="flex items-baseline justify-between gap-3 text-[12px]">
                    <dt className="font-mono text-ink-slate">{b.symbol}</dt>
                    <dd className="num text-ink">{fmtBal(b.available)}{b.locked > 0 && <span className="text-ink-muted"> · {fmtBal(b.locked)} locked</span>}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <PillItem onClick={() => { setOpen(false); openDeposit(asset); }}>Deposit</PillItem>
            <PillItem onClick={() => { setOpen(false); openWithdraw(asset); }}>Withdraw</PillItem>
            <Link role="menuitem" href="/account" onClick={() => { setOpen(false); onNavigate?.(); }} className="block w-full rounded-field px-3 py-2.5 text-left transition-colors hover:bg-paper-deep">
              Account &amp; history
            </Link>
            <PillItem danger onClick={() => { setOpen(false); s.signOut(); }}>Sign out</PillItem>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PillItem({ children, onClick, danger }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={clsx("block w-full rounded-field px-3 py-2.5 text-left transition-colors hover:bg-paper-deep", danger ? "text-burn" : "text-ink")}>
      {children}
    </button>
  );
}
