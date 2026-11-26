import Link from "next/link";
import { NETWORK } from "@/lib/config";
import { Wordmark } from "./Wordmark";

const NOTES = [
  "Bids are committed as keccak256(bidder, max_price, amount, salt). Only the escrowed total and bid count are public until reveal.",
  "All winning bids clear at one uniform price. Bids below clearing are refunded in full via claim_or_refund.",
  "The fee-credit line (10–15% of raise) sits in a non-withdrawable vault. The program can only swap-to-burn or drip to holders.",
  "Until repaid, 80% of fees repay the Credit Pool. After: 50% holders · 35% platform burn · 15% treasury. Graduation-slot buyers earn 0%.",
  "Custodial mode: deposits are held by Sealed's company wallet and balances and trades are recorded offchain by Sealed. Withdrawals are sent from the company wallet and may need manual approval above limits. Proof of reserves is live on /account.",
];

export function Footer() {
  const net = NETWORK === "mainnet" ? "Mainnet-beta" : NETWORK === "localnet" ? "Localnet" : "Devnet";
  return (
    <footer className="mt-28 border-t border-ink">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="grid gap-10 py-12 md:grid-cols-12">
          <div className="md:col-span-4">
            <Wordmark size="lg" />
            <p className="mt-5 max-w-xs text-sm leading-relaxed text-ink-slate">
              A sealed-block launchpad for Solana. Price discovery in private, buybacks <span className="accent">from minute one</span>, and a flywheel holders keep.
            </p>
          </div>
          <nav className="grid grid-cols-2 gap-8 md:col-span-3 md:grid-cols-1" aria-label="Footer">
            <div>
              <p className="section-mark">§ Index</p>
              <ul className="mt-3 space-y-1 text-sm [&_a]:inline-flex [&_a]:min-h-[32px] [&_a]:items-center">
                <li><Link className="text-ink-slate hover:text-ink" href="/">Lobby</Link></li>
                <li><Link className="text-ink-slate hover:text-ink" href="/launch">Launch Studio</Link></li>
                <li><Link className="text-ink-slate hover:text-ink" href="/revenue">Revenue &amp; Burn</Link></li>
                <li><Link className="text-ink-slate hover:text-ink" href="/docs">Docs</Link></li>
                <li><Link className="text-ink-slate hover:text-ink" href="/account">Account</Link></li>
              </ul>
            </div>
            <div>
              <p className="section-mark">§ Safety rails</p>
              <ul className="mt-3 space-y-2 text-sm text-ink-slate">
                <li>Creator allocation ≤ <span className="num text-ink">2%</span></li>
                <li>Non-withdrawable vault</li>
                <li>Anti-snipe registry</li>
              </ul>
            </div>
          </nav>
          <div className="md:col-span-5">
            <p className="section-mark">§ Notes</p>
            <ol className="mt-3 space-y-2.5">
              {NOTES.map((n, i) => (
                <li key={i} className="grid grid-cols-[1.5rem_1fr] text-[12px] leading-relaxed text-ink-slate">
                  <span className="num text-ink-muted">{i + 1}.</span>
                  <span>{n}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="flex flex-col gap-2 border-t border-rule py-5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-muted sm:flex-row sm:items-center sm:justify-between">
          <span>Experimental software · Not investment advice · {net} &amp; demo data are simulated</span>
          <span>Set in Schibsted Grotesk, Libre Caslon &amp; Fragment Mono</span>
        </div>
      </div>
    </footer>
  );
}
