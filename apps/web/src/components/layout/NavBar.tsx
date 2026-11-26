"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ConnectButton } from "../wallet/ConnectButton";
import { SessionPill } from "../custody/SignInButton";
import { CustodySheets } from "../custody/CustodySheets";
import { IS_MAINNET, NETWORK_LABEL } from "@/lib/config";
import { useDataSource } from "@/lib/live";
import { SPRING } from "../motion/spring";
import { MenuIcon, XIcon } from "../ui/Icons";
import { Wordmark } from "./Wordmark";
import { ServiceStatus } from "./ServiceStatus";

export const NAV_LINKS = [
  { href: "/", label: "Lobby", n: "01" },
  { href: "/launch", label: "Launch Studio", n: "02" },
  { href: "/revenue", label: "Revenue & Burn", n: "03" },
  { href: "/docs", label: "Docs", n: "04" },
  { href: "/account", label: "Account", n: "05" },
];

export function NetworkBadge({ className }: { className?: string }) {
  const source = useDataSource();
  // Mainnet shows just "Mainnet" (plus "Offline" while the API is unreachable); off mainnet the data source is shown.
  const suffix = IS_MAINNET
    ? source === "offline" ? "Offline" : null
    : source === "api" ? "Live API" : source === "demo" ? "Demo" : source === "offline" ? "Offline" : "…";
  return (
    <span
      className={clsx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-rule bg-sheet px-2.5 py-[5px] font-mono text-[10.5px] uppercase leading-none tracking-[0.06em] text-ink-slate", className)}
      title={source === "demo" ? "API unreachable — showing a simulated demo world" : source === "offline" ? "Sealed API unreachable — retrying" : undefined}
    >
      <span className={clsx("h-1.5 w-1.5 rounded-full", IS_MAINNET && source !== "offline" ? "bg-gain" : "bg-burn")} />
      {NETWORK_LABEL}
      {suffix && <span className="text-ink-muted">/ {suffix}</span>}
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
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
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
    const onResize = () => window.innerWidth >= 768 && setOpen(false);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-paper">
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6" aria-label="Main">
        <div className="flex min-w-0 items-center gap-4 lg:gap-6">
          <Link href="/" className="flex min-h-[44px] shrink-0 items-center" aria-label="Sealed — lobby">
            <Wordmark />
          </Link>
          <span className="hidden h-5 w-px bg-rule lg:block" aria-hidden />
          <NetworkBadge className="hidden lg:inline-flex" />
        </div>
        <div className="hidden h-full items-stretch gap-6 md:flex lg:gap-7">
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-current={active(l.href) ? "page" : undefined} className={clsx("relative flex items-center gap-1.5 whitespace-nowrap text-sm font-medium transition-colors", active(l.href) ? "text-ink" : "text-ink-slate hover:text-ink")}>
              <span className="num hidden text-[10px] text-ink-muted lg:inline">{l.n}</span>
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
            className="flex h-11 w-11 items-center justify-center rounded-full border border-rule bg-sheet text-ink md:hidden"
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
            className="fixed inset-x-0 bottom-0 top-16 z-40 overflow-y-auto border-t border-rule bg-paper md:hidden"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={SPRING}
          >
            <div className="px-4 pb-10 pt-2">
              <p className="section-mark py-3">§ Index</p>
              <ul className="border-t border-ink">
                {NAV_LINKS.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      onClick={() => close(false)}
                      aria-current={active(l.href) ? "page" : undefined}
                      className={clsx("flex min-h-[60px] items-center gap-4 border-b border-rule text-[26px] font-bold tracking-[-0.035em]", active(l.href) ? "text-ink" : "text-ink-slate")}
                    >
                      <span className="num w-6 text-[11px] font-normal tracking-normal text-ink-muted">{l.n}</span>
                      {l.label}
                      {active(l.href) && <span className="ml-auto h-2 w-2 rounded-full bg-ink" aria-hidden />}
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="mt-6 empty:hidden"><SessionPill menuAlign="left" onNavigate={() => close(false)} /></div>
              <div className="mt-6 flex items-center justify-between gap-3">
                <NetworkBadge />
                <span className="fine">Sealed-block launchpad · Solana</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <CustodySheets />
      <ServiceStatus />
    </header>
  );
}
