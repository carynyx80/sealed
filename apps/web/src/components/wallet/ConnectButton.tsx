"use client";
// Wallet connect/disconnect pill — "private-bank broadsheet" styling (see /DESIGN.md).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { AnimatePresence, motion } from "framer-motion";

const spring = { type: "spring", stiffness: 260, damping: 26 } as const;

function truncate(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export function ConnectButton({ className }: { className?: string }) {
  const { publicKey, wallet, connected, connecting, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  // Render a stable label until mounted: autoConnect state differs between server and client.
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const address = mounted && connected && publicKey ? publicKey.toBase58() : null;
  const label = !mounted ? "Connect wallet" : connecting ? "Connecting…" : address ? truncate(address) : "Connect wallet";

  const pill =
    "inline-flex h-11 items-center gap-2 whitespace-nowrap rounded-full px-4 text-sm font-semibold transition-[transform,background-color,border-color] duration-200 " +
    "hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/40 focus-visible:ring-offset-2 " +
    "focus-visible:ring-offset-paper disabled:opacity-70 sm:px-5 md:h-10 " +
    (address ? "border border-rule bg-sheet text-ink hover:border-rule-strong" : "bg-ink text-paper hover:bg-ink-soft");

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        className={[pill, className].filter(Boolean).join(" ")}
        disabled={mounted && connecting}
        aria-haspopup={address ? "menu" : "dialog"}
        aria-expanded={address ? open : undefined}
        onClick={() => (address ? setOpen((o) => !o) : setVisible(true))}
      >
        {address && wallet?.adapter.icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={wallet.adapter.icon} alt="" width={16} height={16} className="h-4 w-4 rounded-full" />
        ) : (
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${address ? "bg-gain" : "bg-paper/60"}`} />
        )}
        <span className={address ? "num text-[13px] font-normal" : undefined}>
          {label === "Connect wallet" ? (
            <>
              <span className="sm:hidden">Connect</span>
              <span className="hidden sm:inline">Connect wallet</span>
            </>
          ) : (
            label
          )}
        </span>
      </button>
      <AnimatePresence>
        {open && address && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={spring}
            className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-card border border-rule bg-sheet p-1.5 text-sm text-ink shadow-lift"
          >
            <div className="mb-1 border-b border-rule px-3 pb-2.5 pt-1.5">
              <div className="eyebrow">{wallet?.adapter.name ?? "Wallet"}</div>
              <div className="num mt-1 text-xs text-ink-slate">{truncate(address)}</div>
            </div>
            <MenuItem
              onClick={async () => {
                await navigator.clipboard?.writeText(address).catch(() => undefined);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? "Copied" : "Copy address"}
            </MenuItem>
            <MenuItem
              onClick={() => {
                setOpen(false);
                setVisible(true);
              }}
            >
              Change wallet
            </MenuItem>
            <MenuItem
              danger
              onClick={async () => {
                setOpen(false);
                await disconnect().catch(() => undefined);
              }}
            >
              Disconnect
            </MenuItem>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuItem({ children, onClick, danger }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`block w-full rounded-field px-3 py-2 text-left transition-colors hover:bg-paper-deep ${danger ? "text-burn" : "text-ink"}`}
    >
      {children}
    </button>
  );
}
