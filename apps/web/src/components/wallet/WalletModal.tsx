"use client";
// Sealed's wallet picker. Provides the standard `WalletModalContext` (so every `useWalletModal().setVisible(true)`
// in the app opens it) and renders it with the custody Sheet (bottom sheet on phones, dialog from sm up).
//  - Detected wallets (Wallet Standard + injected) first, each listed once (the provider de-duplicates by name).
//  - On a phone with no injected wallet: "Open in Phantom" / "Open in Solflare" universal links that reopen this
//    page in the wallet's in-app browser, plus Mobile Wallet Adapter on Android.
//  - Undetected desktop wallets link to their install page instead of silently doing nothing.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { useWallet, type Wallet } from "@solana/wallet-adapter-react";
import { WalletModalContext } from "@solana/wallet-adapter-react-ui";
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { NETWORK_LABEL } from "@/lib/config";
import { MOBILE_WALLET_ADAPTER_NAME, isAndroid, isMobileDevice, markUserPick, walletDeepLinks } from "@/lib/wallet";
import { Sheet } from "../custody/Sheet";
import { ArrowUpRight } from "../ui/Icons";

export function SealedWalletModalProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const value = useMemo(() => ({ visible, setVisible }), [visible]);
  return (
    <WalletModalContext.Provider value={value}>
      {children}
      <WalletPicker open={visible} onClose={() => setVisible(false)} />
    </WalletModalContext.Provider>
  );
}

function WalletPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { wallets, select, wallet: current, connected } = useWallet();
  const [env, setEnv] = useState<{ mobile: boolean; android: boolean; href: string; origin: string } | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!open) return;
    setShowAll(false);
    setEnv({ mobile: isMobileDevice(), android: isAndroid(), href: window.location.href, origin: window.location.origin });
  }, [open]);

  const { detected, loadable, missing } = useMemo(() => {
    const seen = new Set<string>();
    const unique = wallets.filter((w) => (seen.has(w.adapter.name) ? false : (seen.add(w.adapter.name), true)));
    return {
      detected: unique.filter((w) => w.readyState === WalletReadyState.Installed),
      // Loadable: Solflare's web wallet, Mobile Wallet Adapter (Android). Real options, not extensions.
      loadable: unique.filter((w) => w.readyState === WalletReadyState.Loadable),
      missing: unique.filter((w) => w.readyState === WalletReadyState.NotDetected),
    };
  }, [wallets]);

  const pick = (name: WalletName) => {
    markUserPick(name);
    select(name);
    onClose();
  };

  const mobileNoInjected = !!env?.mobile && detected.length === 0;
  const links = env ? walletDeepLinks(env.href, env.origin) : null;
  const mwa = loadable.find((w) => w.adapter.name === MOBILE_WALLET_ADAPTER_NAME);
  const otherLoadable = loadable.filter((w) => w !== mwa);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      mark={`§ Wallet — ${NETWORK_LABEL}`}
      title={connected ? <>Switch <span className="accent">wallet</span></> : <>Connect a <span className="accent">wallet</span></>}
    >
      {mobileNoInjected && links && (
        <section aria-label="Open in a wallet app">
          <p className="text-[13px] leading-relaxed text-ink-slate">
            Mobile browsers can&apos;t reach wallet extensions. Open Sealed inside your wallet app&apos;s browser and connect there.
          </p>
          <ul className="mt-4 border-t border-ink">
            <DeepLinkRow href={links.phantom} name="Phantom" note="phantom.app" />
            <DeepLinkRow href={links.solflare} name="Solflare" note="solflare.com" />
          </ul>
          {env?.android && mwa && (
            <div className="mt-4">
              <p className="eyebrow mb-2">Or, on this device</p>
              <ul className="border-t border-rule">
                <WalletRow wallet={mwa} note="Any installed Android wallet" active={current?.adapter.name === mwa.adapter.name && connected} onClick={() => pick(mwa.adapter.name)} />
              </ul>
            </div>
          )}
        </section>
      )}

      {!mobileNoInjected && (
        <section aria-label="Detected wallets">
          {detected.length > 0 ? (
            <>
              <p className="eyebrow mb-2">Detected in this browser</p>
              <ul className="border-t border-ink">
                {detected.map((w) => (
                  <WalletRow key={w.adapter.name} wallet={w} note="Detected" active={current?.adapter.name === w.adapter.name && connected} onClick={() => pick(w.adapter.name)} />
                ))}
              </ul>
            </>
          ) : (
            <p className="rounded-field border border-rule bg-paper-deep/60 p-3 text-[13px] leading-relaxed text-ink-slate">
              No Solana wallet extension detected. Install Phantom, Solflare or Backpack and reload, or use a web wallet below.
            </p>
          )}
        </section>
      )}

      {(otherLoadable.length > 0 || (!mobileNoInjected && mwa)) && (
        <section className="mt-5" aria-label="Other ways to connect">
          <p className="eyebrow mb-2">{mobileNoInjected ? "Or use a web wallet" : "Other ways to connect"}</p>
          <ul className="border-t border-rule">
            {[...(mobileNoInjected ? [] : mwa ? [mwa] : []), ...otherLoadable].map((w) => (
              <WalletRow
                key={w.adapter.name}
                wallet={w}
                note={w.adapter.name === MOBILE_WALLET_ADAPTER_NAME ? "Installed Android wallet" : "Web wallet"}
                active={current?.adapter.name === w.adapter.name && connected}
                onClick={() => pick(w.adapter.name)}
              />
            ))}
          </ul>
        </section>
      )}

      {!env?.mobile && missing.length > 0 && (
        <section className="mt-5" aria-label="Not installed">
          <button type="button" className="eyebrow inline-flex min-h-[32px] items-center gap-1 underline decoration-rule-strong underline-offset-4 hover:text-ink" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
            {showAll ? "Hide" : "Show"} wallets to install ({missing.length})
          </button>
          {showAll && (
            <ul className="mt-2 border-t border-rule">
              {missing.map((w) => (
                <InstallRow key={w.adapter.name} wallet={w} />
              ))}
            </ul>
          )}
        </section>
      )}

      <p className="fine mt-6 border-t border-rule pt-4">
        Connecting shares your public address only. Sealed then asks for a free sign-in signature (no transaction) to open your
        custodial account; nothing moves without your approval in the wallet.
      </p>
    </Sheet>
  );
}

function WalletIcon({ src, name }: { src?: string; name: string }) {
  if (!src) return <LetterMark name={name} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" width={28} height={28} className="h-7 w-7 shrink-0 rounded-[7px] border border-rule bg-white object-contain" />;
}

function LetterMark({ name }: { name: string }) {
  return (
    <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] border border-rule bg-white font-mono text-[11px] text-ink">
      {name[0]}
    </span>
  );
}

const rowCls = "flex min-h-[60px] w-full items-center gap-3 border-b border-rule px-1 text-left transition-colors hover:bg-paper-deep/70 focus-visible:bg-paper-deep/70 focus-visible:outline-none";

function WalletRow({ wallet, note, active, onClick }: { wallet: Wallet; note: string; active?: boolean; onClick: () => void }) {
  return (
    <li>
      <button type="button" className={rowCls} onClick={onClick}>
        <WalletIcon src={wallet.adapter.icon} name={wallet.adapter.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-ink">{wallet.adapter.name}</span>
          <span className="block font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-muted">{active ? "Connected" : note}</span>
        </span>
        <span aria-hidden className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", active ? "bg-gain" : "bg-rule-strong")} />
      </button>
    </li>
  );
}

function InstallRow({ wallet }: { wallet: Wallet }) {
  return (
    <li>
      <a className={rowCls} href={wallet.adapter.url} target="_blank" rel="noreferrer">
        <WalletIcon src={wallet.adapter.icon} name={wallet.adapter.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-ink-slate">{wallet.adapter.name}</span>
          <span className="block font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-muted">Not installed · get it</span>
        </span>
        <ArrowUpRight width={14} height={14} className="shrink-0 text-ink-muted" />
      </a>
    </li>
  );
}

function DeepLinkRow({ href, name, note }: { href: string; name: string; note: string }) {
  return (
    <li>
      <a className={rowCls} href={href} rel="noreferrer">
        <LetterMark name={name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-ink">Open in {name}</span>
          <span className="block font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-muted">{note} · in-app browser</span>
        </span>
        <ArrowUpRight width={14} height={14} className="shrink-0 text-ink-muted" />
      </a>
    </li>
  );
}
