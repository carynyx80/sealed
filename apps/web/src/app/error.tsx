"use client";
import Link from "next/link";
import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Surface for monitoring without crashing the shell.
    console.warn("[sealed] route error", error.digest ?? error.message);
  }, [error]);
  return (
    <section className="border-b border-rule py-20 sm:py-28">
      <p className="section-mark">§ Error{error.digest ? ` · ${error.digest}` : ""}</p>
      <h1 className="mt-6 max-w-3xl text-display-xl text-ink">
        A seal <span className="accent">cracked.</span>
      </h1>
      <p className="mt-6 max-w-md text-[15px] leading-relaxed text-ink-slate">This view hit an unexpected error. Your funds and bids live on-chain and are unaffected.</p>
      <div className="mt-8 flex flex-wrap items-center gap-6">
        <button onClick={reset} className="btn-primary">Try again</button>
        <Link href="/" className="btn-link">Back to the lobby</Link>
      </div>
    </section>
  );
}
