import clsx from "clsx";
import type { ReactNode } from "react";
import { FadeIn } from "@/components/motion/FadeIn";

export interface StepProps {
  id: string;
  n: string;
  label: string;
  title: ReactNode;
  children: ReactNode;
  facts: [string, ReactNode][];
  figure: ReactNode;
  caption: string;
  flip?: boolean;
  night?: boolean;
  extra?: ReactNode;
}

/** One numbered step: copy + "In numbers" ledger on one side, a captioned figure on the other (alternating on desktop). */
export function StepSection({ id, n, label, title, children, facts, figure, caption, flip, night, extra }: StepProps) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={clsx(
        "scroll-mt-24",
        night ? "card-night my-10 px-5 py-12 sm:my-14 sm:px-10 sm:py-16" : "border-t border-ink py-14 sm:py-20",
      )}
    >
      <div className="grid gap-10 lg:grid-cols-12 lg:gap-10">
        <div className={clsx("lg:col-span-5", flip && "lg:order-last")}>
          <div className={clsx("flex items-baseline justify-between gap-4 font-mono text-[11px] uppercase tracking-[0.08em]", night ? "text-night-muted" : "text-ink-muted")}>
            <span>
              § {n} · {label}
            </span>
          </div>
          <div className="mt-6 flex items-start gap-5">
            <span aria-hidden className={clsx("numeral text-[64px] leading-[0.8] sm:text-[84px]", night ? "text-night-text" : "text-ink")}>
              {n}
            </span>
          </div>
          <h2 id={`${id}-title`} className={clsx("mt-6 text-display-md", night ? "text-night-text" : "text-ink")}>
            {title}
          </h2>
          <div className={clsx("mt-5 space-y-4 text-[16px] leading-relaxed", night ? "text-night-text/80" : "text-ink-slate")}>{children}</div>

          <dl className={clsx("mt-8 border-t", night ? "border-night-rule" : "border-ink")}>
            <div className={clsx("py-2.5 font-mono text-[11px] uppercase tracking-[0.08em]", night ? "text-night-muted" : "text-ink-muted")}>In numbers</div>
            {facts.map(([k, v]) => (
              <div key={k} className={clsx("flex items-baseline justify-between gap-4 border-t py-2.5", night ? "border-night-rule" : "border-rule")}>
                <dt className={clsx("shrink-0 text-[13px]", night ? "text-night-muted" : "text-ink-slate")}>{k}</dt>
                <dd className={clsx("num min-w-0 text-right text-[13px]", night ? "text-night-text" : "text-ink")}>{v}</dd>
              </div>
            ))}
          </dl>
        </div>

        <FadeIn className={clsx("lg:col-span-7", flip ? "lg:pr-4" : "lg:pl-4")}>
          <figure className={clsx("rounded-card border p-4 sm:p-8", night ? "border-night-rule bg-night-raised" : "border-rule bg-sheet")}>
            <div className={clsx("mb-4 flex items-center justify-between font-mono text-[10.5px] uppercase tracking-[0.08em] sm:mb-6", night ? "text-night-muted" : "text-ink-muted")}>
              <span>Fig. {n}</span>
              <span className="truncate pl-4">{label}</span>
            </div>
            {figure}
            <figcaption className={clsx("mt-4 border-t pt-3 text-[13px] leading-relaxed sm:mt-6", night ? "border-night-rule text-night-muted" : "border-rule text-ink-muted")}>
              {caption}
            </figcaption>
          </figure>
          {extra}
        </FadeIn>
      </div>
    </section>
  );
}
