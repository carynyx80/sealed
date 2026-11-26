import Link from "next/link";
import { SealMark } from "@/components/ui/SealMark";

export default function NotFound() {
  return (
    <section className="grid gap-10 border-b border-rule py-20 sm:py-28 md:grid-cols-12 md:items-end">
      <div className="md:col-span-7">
        <p className="section-mark">§ 404 — Not found</p>
        <h1 className="mt-6 text-display-xl text-ink">
          Still <span className="accent">sealed.</span>
        </h1>
        <p className="mt-6 max-w-md text-[15px] leading-relaxed text-ink-slate">We couldn&apos;t find that page. It may have cleared, been refunded, or never existed.</p>
        <div className="mt-8 flex flex-wrap items-center gap-6">
          <Link href="/" className="btn-primary">Back to the lobby</Link>
          <Link href="/launch" className="btn-link">Launch Studio</Link>
        </div>
      </div>
      <div className="hidden justify-self-end text-ink md:col-span-5 md:block">
        <SealMark size={220} spin />
      </div>
    </section>
  );
}
