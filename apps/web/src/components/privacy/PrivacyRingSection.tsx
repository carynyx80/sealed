"use client";
// Owned by helius-privacy-agent. Home-page § 03 night band: what stays sealed, what stays public, and how the
// Helius Solana Privacy Ring closes the last leak (the escrow deposit).
import { FadeIn } from "@/components/motion/FadeIn";
import { usePrivacyRing } from "@/lib/privacy/usePrivacyRing";
import { RingDiagram, RingMark } from "./RingMotif";

const SEALED: Array<{ what: string; how: string; until: string }> = [
  { what: "Maximum price", how: "keccak-256 commitment", until: "until you reveal" },
  { what: "Bid size", how: "keccak-256 commitment", until: "until you reveal" },
  { what: "Deposit amount", how: "Helius Privacy Ring confidential balance", until: "always" },
  { what: "Refunds", how: "confidential transfer to your shielded balance", until: "always" },
  { what: "Holder payouts", how: "confidential transfer to your shielded balance", until: "always" },
];

const PUBLIC: Array<{ what: string; why: string }> = [
  { what: "Wallet addresses", why: "The Default Ring encrypts amounts and assets, not the parties." },
  { what: "Buyback drips", why: "Every buy-and-burn lands on-chain, on schedule. That is the point." },
  { what: "Protocol fees", why: "The fee split is auditable by anyone, in real time." },
  { what: "Clearing price & total raised", why: "One uniform price, published once the reveal window closes." },
];

export function PrivacyRingSection() {
  const ring = usePrivacyRing();
  const mode = ring.loading ? "checking ring…" : ring.simulated ? "simulated in demo" : ring.available ? `live · ${ring.network}` : "unavailable";

  return (
    <section aria-labelledby="privacy-ring-title" className="bleed mt-20 bg-night text-night-text sm:mt-28">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-20">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-night-rule pb-3 font-mono text-[10.5px] uppercase tracking-[0.08em] text-night-muted">
          <span className="flex items-center gap-2.5">
            <RingMark size={16} active className="text-signal-tint" /> § 03 — Privacy ring
          </span>
          <span>
            Default Ring · beta · <span className={ring.available && !ring.simulated ? "text-signal-tint" : undefined}>{mode}</span>
          </span>
        </div>

        <div className="grid gap-12 pt-12 lg:grid-cols-12 lg:gap-10 lg:pt-16">
          <FadeIn className="lg:col-span-7">
            <h2 id="privacy-ring-title" className="text-display-lg text-night-text">
              Sealed price. Sealed size.
              <br />
              Now a sealed <span className="accent text-signal-tint">deposit</span>.
            </h2>
            <p className="mt-6 max-w-measure text-[15px] leading-relaxed text-night-muted">
              A commitment hides what you bid, but the collateral you lock beside it is a public transfer, and it sets an upper bound on
              your size. Fund it from a Helius Privacy Ring balance instead: the amount travels encrypted, and only your viewing key can
              read it back.
            </p>

            <div className="mt-12">
              <div className="flex items-baseline justify-between border-b border-night-rule pb-2">
                <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-signal-tint">Sealed</p>
                <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-night-muted">Mechanism</p>
              </div>
              <ul>
                {SEALED.map((r) => (
                  <li key={r.what} className="grid grid-cols-12 gap-3 border-b border-night-rule py-3.5 text-[14px]">
                    <span className="col-span-12 font-medium text-night-text sm:col-span-4">{r.what}</span>
                    <span className="col-span-8 text-night-muted sm:col-span-6">{r.how}</span>
                    <span className="col-span-4 text-right font-mono text-[11px] text-night-muted sm:col-span-2">{r.until}</span>
                  </li>
                ))}
              </ul>
            </div>
          </FadeIn>

          <FadeIn delay={0.08} className="lg:col-span-5">
            <div className="mx-auto max-w-[440px] lg:ml-auto lg:mr-0">
              <RingDiagram />
            </div>

            <div className="mt-10">
              <div className="flex items-baseline justify-between border-b border-night-rule pb-2">
                <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-night-text">Public, by design</p>
                <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-night-muted">Why</p>
              </div>
              <ul>
                {PUBLIC.map((r) => (
                  <li key={r.what} className="border-b border-night-rule py-3.5">
                    <p className="text-[14px] font-medium text-night-text">{r.what}</p>
                    <p className="mt-1 text-[13px] leading-relaxed text-night-muted">{r.why}</p>
                  </li>
                ))}
              </ul>
            </div>
          </FadeIn>
        </div>

        <div className="mt-12 grid gap-4 border-t border-night-rule pt-5 text-[12px] leading-relaxed text-night-muted sm:grid-cols-12">
          <p className="sm:col-span-5">
            Powered by <span className="text-night-text">Helius Solana Privacy Rings</span> (beta). Amounts and balances are encrypted for SOL,
            SPL and Token-2022; you decrypt your own with a viewing key.
          </p>
          <p className="font-serif italic sm:col-span-7">
            ¹ In demo the ring is simulated and holds no real funds. On-chain, private deposits switch on with the shielded-escrow program
            upgrade; until then bids fund the escrow publicly, and the commitment still hides price and size.
          </p>
        </div>
      </div>
    </section>
  );
}
