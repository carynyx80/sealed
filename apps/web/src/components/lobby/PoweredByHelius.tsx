import Link from "next/link";
import clsx from "clsx";
import { RingMark } from "../privacy/RingMotif";

/**
 * Full-width editorial statement: the Helius Privacy Ring credit, set big. Rendered under the hero on desktop and,
 * on mobile, inside the hero between the headline and the sealed book so it lands on the first scroll.
 */
export function PoweredByHelius({ id = "helius-credit", className }: { id?: string; className?: string }) {
  return (
    <section aria-labelledby={id} className={clsx("border-b border-ink py-14 sm:py-20", className)}>
      <div className="grid gap-8 lg:grid-cols-12 lg:items-center lg:gap-10">
        <div className="lg:col-span-10">
          <RingMark size={44} active className="mb-6 text-signal lg:hidden" />
          <h2 id={id} className="text-display-xl text-ink">
            Partially powered by <span className="accent text-signal">Helius Privacy Rings</span>
          </h2>
          <Link
            href="/docs/privacy"
            className="mt-6 inline-flex min-h-[44px] items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-slate underline decoration-rule-strong underline-offset-4 transition-colors hover:text-signal"
          >
            What&rsquo;s live today <span aria-hidden>→</span>
          </Link>
        </div>
        <div className="hidden justify-self-end text-signal lg:col-span-2 lg:block">
          <RingMark size={168} active />
        </div>
      </div>
    </section>
  );
}
