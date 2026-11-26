import { Hero } from "@/components/lobby/Hero";
import { PoweredByHelius } from "@/components/lobby/PoweredByHelius";
import { FlowDiagram } from "@/components/lobby/FlowDiagram";
import { StatsStrip } from "@/components/lobby/StatsStrip";
import { LobbyGrid } from "@/components/lobby/LobbyGrid";
import { FadeIn } from "@/components/motion/FadeIn";
import { PrivacyRingSection } from "@/components/privacy/PrivacyRingSection";

/*
 * Home / lobby. Section marks: § 00 hero · § 01 protocol tape (night band) · § 02 the loop ·
 * § 03 privacy ring (helius-privacy-agent) · § 04 the lobby.
 */
export default function HomePage() {
  return (
    <>
      <Hero />
      <PoweredByHelius className="hidden lg:block" />
      <StatsStrip />
      <section className="pt-20 sm:pt-28" aria-labelledby="loop-title">
        <FadeIn className="grid gap-6 pb-10 lg:grid-cols-12 lg:items-end">
          <div className="lg:col-span-7">
            <p className="section-mark">§ 02 · The loop</p>
            <h2 id="loop-title" className="mt-4 text-display-lg text-ink">
              One loop, three <span className="accent">guarantees</span>
            </h2>
          </div>
          <p className="max-w-md text-[15px] leading-relaxed text-ink-slate lg:col-span-5 lg:justify-self-end">
            Sealed bids remove the race. The buyback credit removes the day-one dump. The flywheel turns trading fees into something holders keep.
          </p>
        </FadeIn>
        <FlowDiagram />
      </section>
      <PrivacyRingSection />
      <LobbyGrid />
    </>
  );
}
