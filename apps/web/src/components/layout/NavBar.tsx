"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ConnectButton } from "../wallet/ConnectButton";
import { SessionPill } from "../custody/SignInButton";
import { LazyCustodySheets } from "../custody/LazyCustodySheets";
import { IS_MAINNET, NETWORK_LABEL } from "@/lib/config";
import { useDataSource } from "@/lib/live";
import { SPRING } from "../motion/spring";
import { MenuIcon, XIcon } from "../ui/Icons";
import { Wordmark } from "./Wordmark";
import { ServiceStatus } from "./ServiceStatus";

export const NAV_LINKS = [
  { href: "/", label: "Lobby", n: "01" },
  { href: "/how-it-works", label: "How it works", n: "02" },
  { href: "/launch", label: "Launch Studio", n: "03" },
  { href: "/revenue", label: "Revenue & Burn", n: "04" },
  { href: "/docs", label: "Docs", n: "05" },
  { href: "/account", label: "Account", n: "06" },
];

export function NetworkBadge({ className }: { className?: string }) {
  const source = useDataSource();
  // Mainnet shows just "Mainnet" (plus "Offline" while the API is unreachable); off mainnet the data source is shown.
  const suffix = IS_MAINNET
    ? source === "offline" ? "Offline" : null
    : source === "api" || source === "demo" ? "Live" : source === "offline" ? "Offline" : "…";
  return (
    <span
      className={clsx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-rule bg-sheet px-2.5 py-[5px] font-mono text-[10.5px] uppercase leading-none tracking-[0.06em] text-ink-slate", className)}
      title={source === "offline" ? "Sealed API unreachable. Retrying…" : undefined}
    >
      <span className={clsx("h-1.5 w-1.5 rounded-full", IS_MAINNET && source !== "offline" ? "bg-gain" : "bg-burn")} />
      {NETWORK_LABEL}
      {suffix && <span className={NETWORK_LABEL ? "text-ink-muted" : undefined}>{NETWORK_LABEL ? `/ ${suffix}` : suffix}</span>}
    </span>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function NavBar() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) toggleRef.current?.focus();
  }, []);

  useEffect(() => setOpen(false), [path]);

  // Mobile sheet: scroll lock, focus first link, Esc to close, Tab trapped inside sheet + toggle.
  useEffect(() => {
    if (!open) return;
    // Lock scroll on both <html> and <body> (iOS ignores body alone) and pad by the scrollbar width so a desktop-sized
    // window narrower than lg doesn't shift sideways when the scrollbar disappears.
    const { body, documentElement: root } = document;
    const prev = { body: body.style.overflow, root: root.style.overflow, pad: body.style.paddingRight };
    const gutter = window.innerWidth - root.clientWidth;
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    if (gutter > 0) body.style.paddingRight = `${gutter}px`;
    const first = sheetRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !sheetRef.current) return;
      const items = [toggleRef.current, ...Array.from(sheetRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))].filter(Boolean) as HTMLElement[];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && (i <= 0)) {
        e.preventDefault();
        items[items.length - 1]?.focus();
      } else if (!e.shiftKey && i === items.length - 1) {
        e.preventDefault();
        items[0]?.focus();
      }
    };
    const onResize = () => window.innerWidth >= 1024 && setOpen(false);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      root.style.overflow = prev.root;
      body.style.overflow = prev.body;
      body.style.paddingRight = prev.pad;
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-paper">
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6" aria-label="Main">
        <div className="flex shrink-0 items-center gap-4 xl:gap-6">
          <Link href="/" className="flex min-h-[44px] shrink-0 items-center" aria-label="Sealed lobby">
            <Wordmark />
          </Link>
          <span className="hidden h-5 w-px bg-rule xl:block" aria-hidden />
          <NetworkBadge className="hidden xl:inline-flex" />
        </div>
        <div className="hidden h-full min-w-0 items-stretch gap-5 lg:flex xl:gap-7">
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-current={active(l.href) ? "page" : undefined} className={clsx("relative flex items-center gap-1.5 whitespace-nowrap text-sm font-medium transition-colors", active(l.href) ? "text-ink" : "text-ink-slate hover:text-ink")}>
              <span className="num hidden text-[10px] text-ink-muted xl:inline">{l.n}</span>
              {l.label}
              {active(l.href) && <motion.span layoutId="nav-rule" className="absolute inset-x-0 -bottom-px h-[2px] bg-ink" transition={SPRING} />}
            </Link>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden xl:inline-flex xl:empty:hidden"><SessionPill /></span>
          <ConnectButton />
          <button
            ref={toggleRef}
            type="button"
            className="flex h-11 w-11 items-center justify-center rounded-full border border-rule bg-sheet text-ink lg:hidden"
            onClick={() => (open ? close() : setOpen(true))}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-menu"
          >
            {open ? <XIcon width={18} height={18} /> : <MenuIcon width={18} height={18} />}
          </button>
        </div>
      </nav>
      <AnimatePresence>
        {open && (
          <motion.div
            id="mobile-menu"
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className="fixed inset-x-0 bottom-0 top-16 z-40 overflow-y-auto overscroll-contain border-t border-rule bg-paper lg:hidden"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={SPRING}
          >
            <div className="mx-auto max-w-7xl pb-[max(2.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-2 sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))]">
              <p className="section-mark py-3">§ Index</p>
              <ul className="border-t border-ink">
                {NAV_LINKS.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      onClick={() => close(false)}
                      aria-current={active(l.href) ? "page" : undefined}
                      className={clsx("flex min-h-[60px] items-center gap-4 border-b border-rule text-[26px] font-bold tracking-[-0.035em] [@media(max-height:480px)]:min-h-[48px] [@media(max-height:480px)]:text-[20px]", active(l.href) ? "text-ink" : "text-ink-slate")}
                    >
                      <span className="num w-6 text-[11px] font-normal tracking-normal text-ink-muted">{l.n}</span>
                      {l.label}
                      {active(l.href) && <span className="ml-auto h-2 w-2 rounded-full bg-ink" aria-hidden />}
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="mt-6 empty:hidden"><SessionPill menuAlign="left" onNavigate={() => close(false)} /></div>
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <NetworkBadge />
                <span className="fine">Sealed-block launchpad · Solana</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <LazyCustodySheets />
      <ServiceStatus />
    </header>
  );
}
