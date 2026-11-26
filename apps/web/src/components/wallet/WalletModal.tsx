"use client";
// Sealed's wallet picker. Provides the standard `WalletModalContext` (so every `useWalletModal().setVisible(true)`
// in the app opens it) and renders it with the custody Sheet (bottom sheet on phones, dialog from sm up).
//  - Detected wallets (Wallet Standard + injected) always come first, each listed once. An injected wallet is always
//    preferred: inside a wallet's in-app browser (Jupiter Mobile, Phantom, …) WalletConnect is not offered at all.
//  - Phone with no injected wallet: universal links that reopen this page in Phantom / Solflare / Backpack, a
//    Jupiter Mobile row (WalletConnect when configured, else "open the link in Jupiter's browser" with a copy
//    button), WalletConnect for any other wallet app, and Mobile Wallet Adapter on Android.
//  - Desktop: "More wallets" with WalletConnect (QR), Ledger and other loadable wallets, and install links for the
//    popular wallets that aren't detected.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { useWallet, type Wallet } from "@solana/wallet-adapter-react";
import { WalletModalContext } from "@solana/wallet-adapter-react-ui";
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { NETWORK_LABEL } from "@/lib/config";
import {
  INSTALL_WALLETS,
  JUPITER_MOBILE_URL,
  MOBILE_WALLET_ADAPTER_NAME,
  WALLETCONNECT_NAME,
  isAndroid,
  isMobileDevice,
  markUserPick,
  walletDeepLinks,
  walletKey,
} from "@/lib/wallet";
import { Sheet } from "../custody/Sheet";
import { useWalletRuntime } from "./runtime";
import { preloadWalletConnect } from "./walletConnectLoader";
import { ArrowUpRight } from "../ui/Icons";

export function SealedWalletModalProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const { load } = useWalletRuntime();
  // Opening the picker is the main "wallet intent": make sure the (lazy) wallet runtime is loading.
  useEffect(() => {
    if (visible) load();
  }, [visible, load]);
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
  const { ready } = useWalletRuntime();
  const [env, setEnv] = useState<{ mobile: boolean; android: boolean; href: string; origin: string } | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!open) return;
    setShowAll(false);
    setEnv({ mobile: isMobileDevice(), android: isAndroid(), href: window.location.href, origin: window.location.origin });
  }, [open]);

  const groups = useMemo(() => {
    const seen = new Set<string>();
    const unique = wallets.filter((w) => (seen.has(w.adapter.name) ? false : (seen.add(w.adapter.name), true)));
    const detected = unique.filter((w) => w.readyState === WalletReadyState.Installed);
    const loadable = unique.filter((w) => w.readyState === WalletReadyState.Loadable);
    const missing = unique.filter((w) => w.readyState === WalletReadyState.NotDetected);
    // Already usable here (detected, or a web wallet like Solflare's): no install row for it.
    const detectedKeys = new Set([...detected, ...loadable].map((w) => walletKey(w.adapter.name)));
    const byKey = new Map(unique.map((w) => [walletKey(w.adapter.name), w]));
    const curatedKeys = new Set(INSTALL_WALLETS.map((w) => walletKey(w.name)));
    return {
      detected,
      wc: loadable.find((w) => w.adapter.name === WALLETCONNECT_NAME) ?? null,
      mwa: loadable.find((w) => w.adapter.name === MOBILE_WALLET_ADAPTER_NAME) ?? null,
      // Solflare's web wallet, Ledger (WebHID), …: real options, not extensions.
      otherLoadable: loadable.filter((w) => w.adapter.name !== WALLETCONNECT_NAME && w.adapter.name !== MOBILE_WALLET_ADAPTER_NAME),
      install: INSTALL_WALLETS.filter((w) => !detectedKeys.has(walletKey(w.name))).map((w) => ({ ...w, icon: byKey.get(walletKey(w.name))?.adapter.icon })),
      moreMissing: missing.filter((w) => !curatedKeys.has(walletKey(w.adapter.name))),
    };
  }, [wallets]);
  const { detected, wc, mwa, install, moreMissing } = groups;

  const pick = (name: WalletName) => {
    markUserPick(name);
    select(name);
    onClose();
  };
  const isActive = (w: Wallet) => current?.adapter.name === w.adapter.name && connected;

  const mobile = !!env?.mobile;
  // Ledger over USB (WebHID) is a desktop thing, whatever an emulated phone browser claims.
  const otherLoadable = mobile ? groups.otherLoadable.filter((w) => !/ledger/i.test(w.adapter.name)) : groups.otherLoadable;
  const mobileNoInjected = ready && mobile && detected.length === 0;
  const links = env ? walletDeepLinks(env.href, env.origin) : null;
  // Inside a wallet's in-app browser the injected wallet is the way in; WalletConnect there only gets in the way.
  const offerWc = !!wc && !(mobile && detected.length > 0);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      mark={NETWORK_LABEL ? `§ Wallet · ${NETWORK_LABEL}` : "§ Wallet"}
      title={connected ? <>Switch <span className="accent">wallet</span></> : <>Connect a <span className="accent">wallet</span></>}
    >
      {mobileNoInjected && links && env && (
        <section aria-label="Open in a wallet app">
          <p className="text-[13px] leading-relaxed text-ink-slate">
            Mobile browsers can&apos;t reach wallet extensions. Open Sealed inside your wallet app&apos;s browser and connect there.
          </p>
          <ul className="mt-4 border-t border-ink">
            <DeepLinkRow href={links.phantom} name="Phantom" note="phantom.app" />
            <DeepLinkRow href={links.solflare} name="Solflare" note="solflare.com" />
            <DeepLinkRow href={links.backpack} name="Backpack" note="backpack.app" />
            <JupiterMobileRow wc={wc} href={env.href} onPick={() => wc && pick(wc.adapter.name)} />
            {wc && <WalletRow wallet={wc} note="Any wallet app · opens your wallet" active={isActive(wc)} onClick={() => pick(wc.adapter.name)} onWarm={preloadWalletConnect} />}
          </ul>
          {env.android && mwa && (
            <div className="mt-4">
              <p className="eyebrow mb-2">Or, on this device</p>
              <ul className="border-t border-rule">
                <WalletRow wallet={mwa} note="Any installed Android wallet" active={isActive(mwa)} onClick={() => pick(mwa.adapter.name)} />
              </ul>
            </div>
          )}
        </section>
      )}

      {!mobileNoInjected && (
        <section aria-label="Detected wallets">
          {!ready ? (
            <p className="rounded-field border border-rule bg-paper-deep/60 p-3 text-[13px] leading-relaxed text-ink-slate" role="status">
              Looking for wallets…
            </p>
          ) : detected.length > 0 ? (
            <>
              <p className="eyebrow mb-2">Detected in this browser</p>
              <ul className="border-t border-ink">
                {detected.map((w) => (
                  <WalletRow key={w.adapter.name} wallet={w} note="Detected" active={isActive(w)} onClick={() => pick(w.adapter.name)} />
                ))}
              </ul>
            </>
          ) : (
            <p className="rounded-field border border-rule bg-paper-deep/60 p-3 text-[13px] leading-relaxed text-ink-slate">
              No Solana wallet extension detected. Install one below and reload{wc ? ", or connect a phone wallet with WalletConnect" : ""}.
            </p>
          )}
        </section>
      )}

      {ready && (otherLoadable.length > 0 || (!mobileNoInjected && (offerWc || mwa))) && (
        <section className="mt-5" aria-label="More ways to connect">
          <p className="eyebrow mb-2">{mobileNoInjected ? "Or use a web wallet" : "More wallets"}</p>
          <ul className="border-t border-rule">
            {!mobileNoInjected && offerWc && wc && (
              <WalletRow wallet={wc} note={mobile ? "Any wallet app · opens your wallet" : "Scan a QR with your phone wallet"} active={isActive(wc)} onClick={() => pick(wc.adapter.name)} onWarm={preloadWalletConnect} />
            )}
            {!mobileNoInjected && mwa && <WalletRow wallet={mwa} note="Installed Android wallet" active={isActive(mwa)} onClick={() => pick(mwa.adapter.name)} />}
            {otherLoadable.map((w) => (
              <WalletRow key={w.adapter.name} wallet={w} note={/ledger/i.test(w.adapter.name) ? "Hardware wallet · USB" : "Web wallet"} active={isActive(w)} onClick={() => pick(w.adapter.name)} />
            ))}
          </ul>
        </section>
      )}

      {ready && !mobile && install.length > 0 && (
        <section className="mt-5" aria-label="Wallets to install">
          <p className="eyebrow mb-2">Get a wallet</p>
          <ul className="border-t border-rule">
            {install.map((w) => (
              <InstallRow key={w.name} name={w.name} href={w.href} host={w.host} icon={w.icon} />
            ))}
            {showAll &&
              moreMissing.map((w) => {
                let host = "";
                try {
                  host = new URL(w.adapter.url).host.replace(/^www\./, "");
                } catch {
                  /* keep empty */
                }
                return <InstallRow key={w.adapter.name} name={w.adapter.name} href={w.adapter.url} host={host} icon={w.adapter.icon} />;
              })}
          </ul>
          {moreMissing.length > 0 && (
            <button
              type="button"
              className="eyebrow mt-1 inline-flex min-h-[44px] items-center gap-1 underline decoration-rule-strong underline-offset-4 hover:text-ink"
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
            >
              {showAll ? "Hide other wallets" : `Other wallets (${moreMissing.length})`}
            </button>
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
const noteCls = "block font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-muted";

function WalletRow({ wallet, note, active, onClick, onWarm }: { wallet: Wallet; note: string; active?: boolean; onClick: () => void; onWarm?: () => void }) {
  return (
    <li>
      <button type="button" className={rowCls} onClick={onClick} onPointerEnter={onWarm} onFocus={onWarm} onTouchStart={onWarm}>
        <WalletIcon src={wallet.adapter.icon} name={wallet.adapter.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-ink">{wallet.adapter.name}</span>
          <span className={noteCls}>{active ? "Connected" : note}</span>
        </span>
        <span aria-hidden className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", active ? "bg-gain" : "bg-rule-strong")} />
      </button>
    </li>
  );
}

function InstallRow({ name, href, host, icon }: { name: string; href: string; host: string; icon?: string }) {
  return (
    <li>
      <a className={rowCls} href={href} target="_blank" rel="noreferrer">
        <WalletIcon src={icon} name={name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-ink-slate">{name}</span>
          <span className={noteCls}>{host ? `${host} · install` : "Install"}</span>
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
          <span className={noteCls}>{note} · in-app browser</span>
        </span>
        <ArrowUpRight width={14} height={14} className="shrink-0 text-ink-muted" />
      </a>
    </li>
  );
}

/** Jupiter Mobile: WalletConnect when configured; otherwise how to open this page in its in-app browser. */
function JupiterMobileRow({ wc, href, onPick }: { wc: Wallet | null; href: string; onPick: () => void }) {
  const [openHelp, setOpenHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  if (wc) {
    return (
      <li>
        <button type="button" className={rowCls} onClick={onPick} onPointerEnter={preloadWalletConnect} onTouchStart={preloadWalletConnect} onFocus={preloadWalletConnect}>
          <LetterMark name="Jupiter" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-semibold text-ink">Jupiter Mobile</span>
            <span className={noteCls}>via WalletConnect</span>
          </span>
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-rule-strong" />
        </button>
      </li>
    );
  }
  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(href);
      ok = true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = href;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_600);
    }
  };
  return (
    <li className="border-b border-rule">
      <button type="button" className={clsx(rowCls, "border-b-0")} onClick={() => setOpenHelp((v) => !v)} aria-expanded={openHelp}>
        <LetterMark name="Jupiter" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-ink">Jupiter Mobile</span>
          <span className={noteCls}>Open this page in its browser</span>
        </span>
        <span aria-hidden className="font-mono text-[13px] text-ink-muted">{openHelp ? "−" : "+"}</span>
      </button>
      {openHelp && (
        <div className="px-1 pb-4">
          <p className="text-[13px] leading-relaxed text-ink-slate">Open Jupiter Mobile, tap the globe icon, then paste this link.</p>
          <div className="mt-2 flex items-center gap-2">
            <span className="num min-w-0 flex-1 select-all truncate rounded-field border border-rule bg-white px-3 py-2.5 text-[12px] text-ink-slate">{href}</span>
            <button type="button" className="btn-ghost min-h-[44px] shrink-0 !px-4" onClick={() => void copy()} aria-live="polite">
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          <a className="btn-link mt-1 min-h-[44px] !text-[12px]" href={JUPITER_MOBILE_URL} target="_blank" rel="noreferrer">
            Get Jupiter Mobile <ArrowUpRight width={12} height={12} />
          </a>
        </div>
      )}
    </li>
  );
}
