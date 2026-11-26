"use client";
import Link from "next/link";
import { motion } from "framer-motion";
import { useMemo, useRef } from "react";
import { useLaunches } from "@/lib/live";
import { useReducedMotion } from "@/components/motion/reduced";
import { SPRING } from "../motion/spring";
import { ArrowRight } from "../ui/Icons";
import { PoweredByHelius } from "./PoweredByHelius";
import { SealedBook } from "./SealedBook";
import "./hero.css";

const RAILS = [
  { k: "Uniform clearing", v: "Every winner pays one price", n: "2" },
  { k: "Creator cap", v: "≤ 2% of supply, enforced at launch", n: "" },
  { k: "Day-one credit", v: "10 to 15% of raise buys & burns", n: "3" },
];

export function Hero() {
  const reduce = useReducedMotion();
  const { data } = useLaunches();
  // Feature the commit-window lot closing soonest (falls back to any live sealed lot).
  // Sticky: once a lot is featured it stays until it leaves the sealed phases, so the book doesn't jump.
  const pinned = useRef<string | null>(null);
  const featured = useMemo(() => {
    const xs = (data ?? []).filter((l) => l.status === "commit" || l.status === "reveal");
    const keep = xs.find((l) => l.id === pinned.current);
    if (keep) return keep;
    xs.sort((a, b) => (a.status === "commit" ? 0 : 1) - (b.status === "commit" ? 0 : 1) || b.auction.bidCount - a.auction.bidCount);
    pinned.current = xs[0]?.id ?? null;
    return xs[0] ?? null;
  }, [data]);

  // Above the fold (dateline, headline, lede, CTAs): visible in the SSR HTML, transform-only CSS entrance (hero.css).
  const lift = (ms: number) => ({ style: { ["--hero-delay" as string]: `${ms}ms` } });
  // Below the fold on phones (rails, sealed book): keep the subtle framer-motion reveal.
  const rise = (d: number) => ({ initial: reduce ? false : { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { ...SPRING, delay: d } });

  return (
    <section className="relative overflow-x-clip pb-16 pt-6 sm:pb-24 sm:pt-8">
      {/* dateline */}
      <div {...lift(0)} className="hero-rise flex items-center justify-between gap-4 border-b border-ink pb-2.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-slate">
        <span>§ 00 · Sealed-block launchpad</span>
        <span className="hidden sm:inline">Solana · Commit → Reveal → Clear → Buy back</span>
        <span className="sm:hidden">Solana</span>
      </div>

      <div className="mt-10 grid gap-14 sm:mt-14 lg:grid-cols-12 lg:gap-8">
        <div className="lg:col-span-7">
          <h1 {...lift(50)} className="hero-rise font-display text-[clamp(3rem,7.4vw,6.75rem)] font-bold leading-[0.9] tracking-[-0.05em] text-ink">
            Bids stay sealed.
            <br />
            Buybacks start at minute <span className="accent tracking-[-0.03em]">one.</span>
          </h1>

          <p {...lift(110)} className="hero-rise mt-8 max-w-[34rem] text-[17px] leading-relaxed text-ink-slate">
            Every token opens with a private commit-reveal auction that clears at a single price: no block-zero snipers, no whale copy-trading. At graduation a locked fee-credit vault starts buying and burning, repays itself from fees, then turns into a flywheel holders keep.
          </p>

          <div {...lift(170)} className="hero-rise mt-9 flex flex-wrap items-center gap-x-7 gap-y-4">
            <a href="#lobby" className="btn-primary h-12 px-6">
              Enter the lobby <ArrowRight width={15} height={15} />
            </a>
            <Link href="/launch" className="btn-link">
              Open a sealed auction
            </Link>
          </div>

          <motion.dl {...rise(0.24)} className="mt-14 grid max-w-2xl grid-cols-1 border-t border-rule sm:grid-cols-3">
            {RAILS.map((r, i) => (
              <div key={r.k} className={`border-b border-rule py-3.5 sm:border-b-0 sm:py-4 ${i > 0 ? "sm:border-l sm:pl-5" : ""} ${i < 2 ? "sm:pr-5" : ""}`}>
                <dt className="eyebrow">{r.k}{r.n && <sup className="ml-0.5">{r.n}</sup>}</dt>
                <dd className="mt-1.5 text-sm text-ink">{r.v}</dd>
              </div>
            ))}
          </motion.dl>
        </div>

        <PoweredByHelius id="helius-credit-m" className="border-t lg:hidden" />

        <motion.div {...rise(0.15)} className="w-full max-w-[560px] lg:col-span-5 lg:max-w-none lg:pl-4 lg:pt-3">
          <SealedBook launch={featured} />
        </motion.div>
      </div>
    </section>
  );
}
