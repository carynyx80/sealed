"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useReducedMotion } from "@/components/motion/reduced";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import clsx from "clsx";
import {
  CREDIT_TIERS,
  CreateLaunchInputSchema,
  DEFAULT_DRIP_COUNT,
  DEFAULT_DRIP_INTERVAL_SEC,
  MAX_COMMIT_DURATION_SEC,
  MAX_CREATOR_ALLOCATION_BPS,
  MIN_COMMIT_DURATION_SEC_DEVNET,
  MIN_COMMIT_DURATION_SEC_MAINNET,
  QUOTE_ASSETS,
  type CreateLaunchInput,
  type CreditTier,
  type QuoteAssetSymbol,
} from "@sealed/shared";
import { api, ApiError } from "@/lib/api";
import { IS_MAINNET, NETWORK } from "@/lib/config";
import { fmtAmount, fmtCompact, fmtInt, fmtPrice, fmtUsd } from "@/lib/format";
import { SPRING } from "../motion/spring";
import { RollingNumber } from "../motion/RollingNumber";
import { ArrowRight, LockIcon } from "../ui/Icons";
import { Scale } from "./Scale";
import { Clause, lineInput, QuoteAssetList, SectionHead, StepRail, Term } from "./parts";

const STEPS = ["Identity & quote", "Auction terms", "Term sheet"] as const;
const MIN_DUR = IS_MAINNET ? MIN_COMMIT_DURATION_SEC_MAINNET : MIN_COMMIT_DURATION_SEC_DEVNET;
const REVEAL_SEC = 120;
const TIERS: { id: CreditTier; label: string }[] = [
  { id: "standard", label: "Standard" },
  { id: "plus", label: "Plus" },
  { id: "premier", label: "Premier" },
];

interface Form {
  name: string;
  ticker: string;
  description: string;
  imageUri: string;
  quoteAsset: QuoteAssetSymbol;
  creditTier: CreditTier;
  totalSupply: number;
  creatorAllocationBps: number;
  auctionSupplyBps: number;
  commitDurationSec: number;
  floorPrice: string;
  tickSize: string;
  targetRaise: string;
  clearingCap: string;
}

function suggest(quote: QuoteAssetSymbol, totalSupply: number, auctionBps: number, targetUsd = 120_000) {
  const target = Math.round((targetUsd / QUOTE_ASSETS[quote].demoUsdPrice) * 100) / 100;
  const forSale = (totalSupply * auctionBps) / 10_000;
  const floor = (target * 0.55) / forSale;
  // 3 significant digits, always in plain decimal notation (never "4.52e-8").
  const sig = (n: number) => {
    const decimals = Math.max(0, Math.min(18, 2 - Math.floor(Math.log10(Math.abs(n) || 1))));
    return Number(n.toPrecision(3)).toFixed(decimals);
  };
  return { targetRaise: String(target), clearingCap: String(Math.round(target * 1.5 * 100) / 100), floorPrice: sig(floor), tickSize: sig(floor * 0.05) };
}

const initial: Form = {
  name: "",
  ticker: "",
  description: "",
  imageUri: "",
  quoteAsset: "SOL",
  creditTier: "plus",
  totalSupply: 1_000_000_000,
  creatorAllocationBps: 100,
  auctionSupplyBps: 4_000,
  commitDurationSec: IS_MAINNET ? 20 * 60 : 15 * 60,
  ...suggest("SOL", 1_000_000_000, 4_000),
};

const FIELD_LABEL: Record<string, string> = {
  name: "Name", ticker: "Ticker", description: "Description", imageUri: "Image URI", totalSupply: "Total supply",
  creatorAllocationBps: "Creator allocation", auctionSupplyBps: "Auction supply", commitDurationSec: "Commit window",
  floorPrice: "Floor price", tickSize: "Tick size", targetRaise: "Target raise", clearingCap: "Clearing cap",
};

export function LaunchWizard() {
  const router = useRouter();
  const reduce = useReducedMotion();
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [f, setF] = useState<Form>(initial);
  const [touchedPricing, setTouchedPricing] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployErr, setDeployErr] = useState<string | null>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setF((prev) => {
      const next = { ...prev, [k]: v };
      if (!touchedPricing && (k === "quoteAsset" || k === "totalSupply" || k === "auctionSupplyBps")) Object.assign(next, suggest(next.quoteAsset, next.totalSupply, next.auctionSupplyBps));
      return next;
    });
  const setPricing = (k: "floorPrice" | "tickSize" | "targetRaise" | "clearingCap", v: string) => {
    setTouchedPricing(true);
    setF((p) => ({ ...p, [k]: v.replace(/[^0-9.]/g, "") }));
  };

  const input: CreateLaunchInput = {
    name: f.name.trim(),
    ticker: f.ticker.trim(),
    description: f.description.trim(),
    imageUri: f.imageUri.trim(),
    metadataUri: "",
    quoteAsset: f.quoteAsset,
    creditTier: f.creditTier,
    totalSupply: f.totalSupply,
    creatorAllocationBps: Math.min(MAX_CREATOR_ALLOCATION_BPS, f.creatorAllocationBps),
    auctionSupplyBps: f.auctionSupplyBps,
    commitDurationSec: f.commitDurationSec,
    revealDurationSec: REVEAL_SEC,
    floorPrice: Number(f.floorPrice),
    tickSize: Number(f.tickSize),
    targetRaise: Number(f.targetRaise),
    clearingCap: Number(f.clearingCap),
  };

  const parsed = useMemo(() => CreateLaunchInputSchema.safeParse(input), [JSON.stringify(input)]); // eslint-disable-line react-hooks/exhaustive-deps
  const issues = useMemo(() => {
    const m: Partial<Record<string, string>> = {};
    if (!parsed.success) for (const i of parsed.error.issues) m[String(i.path[0])] ??= i.message;
    if (input.clearingCap < input.targetRaise) m.clearingCap = "Cap must be ≥ target raise";
    if (input.commitDurationSec < MIN_DUR) m.commitDurationSec = `Minimum ${MIN_DUR / 60} minutes on ${NETWORK}`;
    return m;
  }, [parsed, input.clearingCap, input.targetRaise, input.commitDurationSec]);

  const step0Ok = !issues.name && !issues.ticker && !issues.description && !issues.imageUri;
  const step1Ok = !issues.creatorAllocationBps && !issues.floorPrice && !issues.tickSize && !issues.targetRaise && !issues.clearingCap && !issues.commitDurationSec && !issues.totalSupply;
  const canNext = step === 0 ? step0Ok : step === 1 ? step1Ok : true;

  const tierBps = CREDIT_TIERS[f.creditTier];
  const creditAtTarget = (input.targetRaise * tierBps) / 10_000;
  const creditAtCap = (input.clearingCap * tierBps) / 10_000;
  const dripAmt = creditAtTarget / DEFAULT_DRIP_COUNT;
  const usd = QUOTE_ASSETS[f.quoteAsset].demoUsdPrice;
  const forSale = (f.totalSupply * f.auctionSupplyBps) / 10_000;
  const creatorTokens = (f.totalSupply * input.creatorAllocationBps) / 10_000;
  const issueCount = Object.keys(issues).length;

  const go = (d: number) => {
    setDir(d);
    setStep((s) => Math.max(0, Math.min(2, s + d)));
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };

  const deploy = async () => {
    if (!parsed.success) return;
    setDeploying(true);
    setDeployErr(null);
    try {
      const { launch } = await api.createLaunch(parsed.data);
      router.push(`/token/${launch.mint}`);
    } catch (e) {
      setDeployErr(
        e instanceof ApiError && e.status >= 500
          ? e.message
          : e instanceof ApiError
            ? `The API rejected this launch: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
      );
      setDeploying(false);
    }
  };

  const minutes = (s: number) => `${Math.round(s / 60)} min`;

  return (
    <div className="pb-16 pt-10 sm:pt-16">
      {/* masthead */}
      <header className="grid gap-8 border-b border-ink pb-8 lg:grid-cols-12 lg:items-end">
        <div className="lg:col-span-8">
          <p className="section-mark">§ Launch Studio — Offering memorandum</p>
          <h1 className="mt-4 text-display-lg text-ink">
            Draft the <span className="accent">prospectus</span>
            <br className="hidden sm:block" /> for a sealed offering.
          </h1>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-slate">
            Three sections. Your token opens with a private commit-reveal auction that clears at one uniform price, and graduates with a buyback vault already funded.
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 text-[12px] lg:col-span-4 lg:grid-cols-1">
          {[
            ["Network", NETWORK],
            ["Settlement", "Uniform clearing price"],
            ["Day-one credit", "10.0 – 15.0% of raise"],
            ["Creator ceiling", "2.00% of supply"],
          ].map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3 border-b border-rule py-2 last:border-b-0 lg:last:border-b">
              <dt className="text-ink-muted">{k}</dt>
              <dd className="num text-right text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      </header>

      <div className="mt-8">
        <StepRail steps={STEPS} step={step} onGo={(i) => go(i - step)} />
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-12">
        {/* the document */}
        <div className="card relative min-w-0 overflow-hidden lg:col-span-8">
          <div className="px-5 py-7 sm:px-10 sm:py-10">
            <AnimatePresence mode="wait" initial={false} custom={dir}>
              <motion.div
                key={step}
                custom={dir}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
                transition={SPRING}
              >
                {step === 0 && (
                  <div>
                    <SectionHead mark="§ 01 — Identity & quote asset" title="Name the" accent="issue." lede="How the token will appear in the lobby, and the asset bidders escrow and holders are paid in." />
                    <div className="mt-8 space-y-8">
                      <Clause n="1.1" label="Name of issue" htmlFor="tok-name" hint={`${f.name.length}/32`} error={f.name ? issues.name : undefined}>
                        <input id="tok-name" className={clsx(lineInput, "font-display text-2xl font-semibold tracking-[-0.02em] sm:text-3xl")} maxLength={32} placeholder="Quiet Money" value={f.name} onChange={(e) => set("name", e.target.value)} autoComplete="off" />
                      </Clause>
                      <Clause n="1.2" label="Ticker" htmlFor="tok-ticker" hint="A–Z, 0–9" error={f.ticker ? issues.ticker : undefined}>
                        <div className="flex items-baseline gap-1">
                          <span className="num text-xl text-ink-muted">$</span>
                          <input id="tok-ticker" className={clsx(lineInput, "num text-xl uppercase")} maxLength={10} placeholder="QUIET" value={f.ticker} onChange={(e) => set("ticker", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} autoComplete="off" />
                        </div>
                      </Clause>
                      <Clause n="1.3" label="Description" htmlFor="tok-desc" hint={`${f.description.length}/280`} error={issues.description}>
                        <textarea id="tok-desc" className={clsx(lineInput, "min-h-[84px] resize-y text-[15px] leading-relaxed")} maxLength={280} placeholder="What is this token about?" value={f.description} onChange={(e) => set("description", e.target.value)} />
                      </Clause>
                      <Clause n="1.4" label={<>Image or metadata URI <span className="font-normal text-ink-muted">— optional</span></>} htmlFor="tok-uri" error={f.imageUri ? issues.imageUri : undefined}>
                        <input id="tok-uri" className={clsx(lineInput, "num text-sm")} placeholder="https://…" value={f.imageUri} onChange={(e) => set("imageUri", e.target.value)} autoComplete="off" />
                      </Clause>
                      <Clause n="1.5" label="Quote asset">
                        <QuoteAssetList value={f.quoteAsset} onChange={(s) => set("quoteAsset", s)} />
                      </Clause>
                      <Clause n="1.6" label="Credit tier" hint="advanced at graduation">
                        <div role="radiogroup" aria-label="Credit tier" className="mt-3 grid grid-cols-3 border-t border-ink">
                          {TIERS.map((t, i) => {
                            const on = f.creditTier === t.id;
                            return (
                              <button
                                key={t.id}
                                type="button"
                                role="radio"
                                aria-checked={on}
                                onClick={() => set("creditTier", t.id)}
                                className={clsx("relative border-b border-rule px-2 py-3 text-left outline-none transition-colors focus-visible:bg-signal-tint/60 sm:px-3", i > 0 && "border-l", on ? "bg-paper/70" : "hover:bg-paper/50")}
                              >
                                {on && <motion.span layoutId="tier-rule" className="absolute inset-x-0 -top-px h-[3px] bg-ink" transition={SPRING} />}
                                <span className="block text-sm font-medium">{t.label}</span>
                                <span className="num mt-1 block text-lg text-ink sm:text-xl">{(CREDIT_TIERS[t.id] / 100).toFixed(1)}%</span>
                                <span className="num block text-[10px] text-ink-muted">{fmtInt(CREDIT_TIERS[t.id])} bps</span>
                              </button>
                            );
                          })}
                        </div>
                      </Clause>
                    </div>
                  </div>
                )}

                {step === 1 && (
                  <div>
                    <SectionHead mark="§ 02 — Sealed auction parameters" title="Set the" accent="terms." lede="Bids are sealed commitments: count and time are public, sizes and prices are not. Everyone who clears pays the same price." />
                    <div className="mt-8 space-y-9">
                      <Clause n="2.1" label="Creator allocation" htmlFor="creator-cap" hint={<span className="text-ink">{(input.creatorAllocationBps / 100).toFixed(2)}% <span className="text-ink-muted">· {fmtCompact(creatorTokens, 2)} tokens</span></span>} error={issues.creatorAllocationBps}>
                        <Scale
                          id="creator-cap"
                          min={0}
                          max={MAX_CREATOR_ALLOCATION_BPS}
                          domainMax={300}
                          step={10}
                          value={f.creatorAllocationBps}
                          onChange={(v) => set("creatorAllocationBps", v)}
                          ticks={[0, 50, 100, 150, 200, 250, 300]}
                          tickLabel={(t) => `${(t / 100).toFixed(1)}%`}
                          cap={{ label: "Cap 2.00%", note: "not permitted" }}
                          valueText={`${(f.creatorAllocationBps / 100).toFixed(2)} percent of supply`}
                        />
                        <p className="text-[12px] leading-relaxed text-ink-muted">The ceiling is enforced by the program at listing; the handle cannot travel past the rule.</p>
                      </Clause>

                      <Clause n="2.2" label="Commit window" htmlFor="duration" hint={<span className="text-ink">{minutes(f.commitDurationSec)} <span className="text-ink-muted">+ {REVEAL_SEC / 60} min reveal</span></span>} error={issues.commitDurationSec}>
                        <Scale
                          id="duration"
                          min={MIN_DUR}
                          max={MAX_COMMIT_DURATION_SEC}
                          step={60}
                          value={f.commitDurationSec}
                          onChange={(v) => set("commitDurationSec", v)}
                          ticks={IS_MAINNET ? [900, 1200, 1500, 1800] : [120, 600, 900, 1200, 1500, 1800]}
                          tickLabel={(t) => `${t / 60}m`}
                          zone={IS_MAINNET ? undefined : { from: MIN_COMMIT_DURATION_SEC_DEVNET, to: MIN_COMMIT_DURATION_SEC_MAINNET, label: `${NETWORK} only` }}
                          marks={IS_MAINNET ? [] : [{ at: MIN_COMMIT_DURATION_SEC_MAINNET, label: "mainnet min." }]}
                          valueText={`${Math.round(f.commitDurationSec / 60)} minutes`}
                        />
                        <p className="text-[12px] leading-relaxed text-ink-muted">
                          15–30 minutes on mainnet{!IS_MAINNET && <>; down to 2 minutes on <span className="num">{NETWORK}</span> for testing</>}. A {REVEAL_SEC / 60}-minute reveal window follows; the relayer can auto-reveal for bidders.
                        </p>
                      </Clause>

                      <Clause n="2.3" label="Total supply" htmlFor="supply" hint="whole tokens" error={issues.totalSupply}>
                        <input id="supply" className={clsx(lineInput, "num text-lg")} inputMode="numeric" value={fmtInt(f.totalSupply)} onChange={(e) => set("totalSupply", Math.max(1, Math.floor(Number(e.target.value.replace(/\D/g, "")) || 0)))} />
                      </Clause>

                      <Clause n="2.4" label="Sold in the sealed auction" htmlFor="sale" hint={<span className="text-ink">{(f.auctionSupplyBps / 100).toFixed(1)}% <span className="text-ink-muted">· {fmtCompact(forSale, 2)} tokens</span></span>}>
                        <Scale
                          id="sale"
                          min={2000}
                          max={6000}
                          step={250}
                          value={f.auctionSupplyBps}
                          onChange={(v) => set("auctionSupplyBps", v)}
                          ticks={[2000, 3000, 4000, 5000, 6000]}
                          tickLabel={(t) => `${t / 100}%`}
                          valueText={`${f.auctionSupplyBps / 100} percent of supply`}
                        />
                      </Clause>

                      <Clause
                        n="2.5"
                        label={<>Pricing <span className="num font-normal text-ink-muted">in {f.quoteAsset}</span></>}
                        hint={
                          <button type="button" className="text-ink-slate underline decoration-rule-strong underline-offset-4 hover:text-ink hover:decoration-ink" onClick={() => { setTouchedPricing(false); setF((p) => ({ ...p, ...suggest(p.quoteAsset, p.totalSupply, p.auctionSupplyBps) })); }}>
                            Suggest for ≈ $120k
                          </button>
                        }
                      >
                        <div className="mt-3 border-t border-ink">
                          {([
                            ["floorPrice", "Floor price", "per token", fmtPrice(input.floorPrice)],
                            ["tickSize", "Tick size", "bid increment", fmtPrice(input.tickSize)],
                            ["targetRaise", "Target raise", "sets the credit line", `≈ ${fmtUsd(input.targetRaise * usd)}`],
                            ["clearingCap", "Clearing cap", "hard maximum", `≈ ${fmtUsd(input.clearingCap * usd)}`],
                          ] as const).map(([k, label, sub, hint]) => (
                            <div key={k} className="grid grid-cols-[5.75rem_minmax(0,1fr)] items-center gap-2 border-b border-rule py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_7rem] sm:gap-3">
                              <label htmlFor={`px-${k}`} className="min-w-0">
                                <span className="block text-[13px] text-ink-soft">{label}</span>
                                <span className="block text-[11px] text-ink-muted">{sub}</span>
                              </label>
                              <div className="min-w-0">
                                <div className="flex items-baseline gap-2">
                                  <input id={`px-${k}`} className={clsx(lineInput, "num text-right text-[13px] sm:text-[15px]")} inputMode="decimal" value={f[k]} onChange={(e) => setPricing(k, e.target.value)} />
                                  <span className="num w-10 shrink-0 text-[11px] text-ink-muted sm:w-12">{f.quoteAsset}</span>
                                </div>
                                {issues[k] && <p role="alert" className="num mt-1 text-right text-[11px] text-burn">— {issues[k]}</p>}
                                <span className="num mt-0.5 block text-right text-[11px] text-ink-muted sm:hidden">{hint}</span>
                              </div>
                              <span className="num hidden text-right text-[11px] text-ink-muted sm:block">{hint}</span>
                            </div>
                          ))}
                        </div>
                      </Clause>
                    </div>
                  </div>
                )}

                {step === 2 && (
                  <div>
                    <SectionHead mark="§ 03 — Review" title="Summary of" accent="terms." lede="Read it once more. Deploying opens the commit window immediately." />

                    <section aria-labelledby="credit-h" className="card-night relative mt-8 overflow-hidden p-6 sm:p-8">
                      <svg aria-hidden viewBox="0 0 200 200" className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 text-night-rule motion-safe:animate-ring">
                        <circle cx="100" cy="100" r="96" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 6" />
                        <circle cx="100" cy="100" r="72" fill="none" stroke="currentColor" strokeWidth="1" />
                        <circle cx="100" cy="100" r="48" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="1 4" />
                      </svg>
                      <p id="credit-h" className="num relative text-[11px] uppercase tracking-[0.08em] text-night-muted">Projected Day-One Buyback Credit</p>
                      <p className="relative mt-4 flex flex-wrap items-baseline gap-x-3 text-night-text">
                        <RollingNumber value={creditAtTarget} className="text-[clamp(2.75rem,10vw,5.75rem)] leading-none tracking-[-0.04em]" />
                        <span className="num text-xl text-night-muted sm:text-2xl">{f.quoteAsset}</span>
                      </p>
                      <p className="num relative mt-4 text-[12px] text-night-muted">
                        {fmtAmount(input.targetRaise)} {f.quoteAsset} target × {fmtInt(tierBps)} bps <span className="text-night-text">= {fmtAmount(creditAtTarget)}</span>
                      </p>
                      <dl className="relative mt-6 grid grid-cols-2 border-t border-night-rule text-[12px] sm:grid-cols-3">
                        <div className="border-b border-night-rule py-3 pr-3 sm:border-b-0">
                          <dt className="text-night-muted">At clearing cap</dt>
                          <dd className="num mt-1 text-night-text">{fmtAmount(creditAtCap)} {f.quoteAsset}</dd>
                        </div>
                        <div className="border-b border-l border-night-rule py-3 pl-3 sm:border-b-0">
                          <dt className="text-night-muted">≈ USD at target</dt>
                          <dd className="num mt-1 text-night-text">{fmtUsd(creditAtTarget * usd, false)}</dd>
                        </div>
                        <div className="col-span-2 py-3 sm:col-span-1 sm:border-l sm:border-night-rule sm:pl-3">
                          <dt className="text-night-muted">Drip schedule</dt>
                          <dd className="num mt-1 text-night-text">{DEFAULT_DRIP_COUNT} × {fmtAmount(dripAmt)} / {DEFAULT_DRIP_INTERVAL_SEC / 60} min</dd>
                        </div>
                      </dl>
                      <p className="relative mt-3 max-w-lg text-[12px] leading-relaxed text-night-muted">
                        Buy-and-burn starts the minute the pool opens and is repaid from 80% of trading fees; at 100% repaid the holder flywheel switches on.
                      </p>
                    </section>

                    <dl className="mt-8 grid border-t border-ink sm:grid-cols-2 sm:gap-x-8">
                      <div>
                        <Term k="Issuer">{f.name || "—"}</Term>
                        <Term k="Ticker">${f.ticker || "—"}</Term>
                        <Term k="Quote asset">{f.quoteAsset} <span className="text-ink-muted">· {QUOTE_ASSETS[f.quoteAsset].name.replace(" (tokenized)", "")}</span></Term>
                        <Term k="Total supply">{fmtInt(f.totalSupply)}</Term>
                        <Term k="Offered">{fmtCompact(forSale, 2)} <span className="text-ink-muted">({(f.auctionSupplyBps / 100).toFixed(1)}%)</span></Term>
                        <Term k="Creator allocation" note="1">{(input.creatorAllocationBps / 100).toFixed(2)}% <span className="text-ink-muted">of 2.00% max</span></Term>
                        <Term k="Credit tier" note="3">{TIERS.find((t) => t.id === f.creditTier)!.label} <span className="text-ink-muted">· {fmtInt(tierBps)} bps</span></Term>
                      </div>
                      <div>
                        <Term k="Format" note="4">Sealed bid, uniform price</Term>
                        <Term k="Commit window">{minutes(f.commitDurationSec)}</Term>
                        <Term k="Reveal window" note="2">{REVEAL_SEC / 60} min</Term>
                        <Term k="Floor / tick">{fmtPrice(input.floorPrice)} / {fmtPrice(input.tickSize)}</Term>
                        <Term k="Target raise">{fmtAmount(input.targetRaise)} {f.quoteAsset}</Term>
                        <Term k="Clearing cap">{fmtAmount(input.clearingCap)} {f.quoteAsset}</Term>
                        <Term k="Network">{NETWORK}</Term>
                      </div>
                    </dl>

                    <ol className="mt-6 space-y-1.5 text-[12px] leading-relaxed text-ink-slate">
                      <li><span className="num mr-1.5 text-ink-muted">1</span>Enforced on-chain at listing; cannot be raised after deploy.</li>
                      <li><span className="num mr-1.5 text-ink-muted">2</span>Unrevealed bids are slashed 1%; the auto-reveal relayer submits for bidders who opt in.</li>
                      <li><span className="num mr-1.5 text-ink-muted">3</span>The buyback vault can only swap-to-burn; no one, including the creator, can withdraw it.</li>
                      <li>
                        <span className="num mr-1.5 text-ink-muted">4</span>
                        Bidders may fund deposits privately via <span className="text-signal">Helius Privacy Rings</span>.
                      </li>
                    </ol>

                    {issueCount > 0 && (
                      <div role="alert" className="mt-6 border-l-2 border-burn bg-burn-tint/60 px-4 py-3 text-[12px] text-burn">
                        <p className="font-medium">Correct before deploying</p>
                        <ul className="num mt-1 space-y-0.5">
                          {Object.entries(issues).map(([k, v]) => <li key={k}>{FIELD_LABEL[k] ?? k} — {v}</li>)}
                        </ul>
                      </div>
                    )}
                    {deployErr && <p role="alert" className="mt-4 border-l-2 border-burn bg-burn-tint/60 px-4 py-3 text-[12px] text-burn">{deployErr}</p>}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-rule bg-paper/40 px-5 py-4 sm:px-10">
            <button type="button" className="btn-ghost" onClick={() => go(-1)} disabled={step === 0 || deploying} style={{ visibility: step === 0 ? "hidden" : "visible" }}>
              Back
            </button>
            <div className="flex items-center gap-4">
              <span className="num hidden text-[11px] text-ink-muted sm:inline">{step + 1} / 3</span>
              {step < 2 ? (
                <button type="button" className="btn-primary" disabled={!canNext} onClick={() => go(1)}>
                  Continue to § 0{step + 2} <ArrowRight width={14} height={14} />
                </button>
              ) : (
                <button type="button" className="btn-primary sm:px-6" disabled={!parsed.success || issueCount > 0 || deploying} onClick={deploy}>
                  <LockIcon width={14} height={14} /> {deploying ? "Deploying…" : <>Deploy<span className="hidden sm:inline"> sealed auction</span></>}
                </button>
              )}
            </div>
          </footer>
        </div>

        {/* running summary */}
        <aside className="lg:col-span-4">
          <div className="lg:sticky lg:top-24">
            <div className="card p-5 sm:p-6">
              <p className="eyebrow">Running summary</p>
              <div className="mt-4 flex items-start gap-3">
                <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-rule bg-paper-deep">
                  <span className="num text-[13px] text-ink">{(f.ticker || "··").slice(0, 2)}</span>
                </span>
                <div className="min-w-0">
                  <p className="truncate text-display-sm text-ink">{f.name || <span className="text-ink-muted">Untitled issue</span>}</p>
                  <p className="num mt-0.5 text-[12px] text-ink-muted">${f.ticker || "TICKER"} · quoted in {f.quoteAsset}</p>
                </div>
              </div>
              <div className="mt-5 border-t border-ink pt-4">
                <p className="text-[12px] text-ink-slate">Day-one buyback credit</p>
                <p className="mt-1 flex items-baseline gap-2">
                  <RollingNumber value={creditAtTarget} className="text-3xl tracking-[-0.03em] text-ink" />
                  <span className="num text-sm text-ink-muted">{f.quoteAsset}</span>
                </p>
                <p className="num mt-1 text-[11px] text-ink-muted">{fmtInt(tierBps)} bps of {fmtAmount(input.targetRaise)} target</p>
              </div>
              <dl className="mt-4 text-[12px]">
                {[
                  ["Creator", `${(input.creatorAllocationBps / 100).toFixed(2)}%`],
                  ["Commit / reveal", `${minutes(f.commitDurationSec)} / ${REVEAL_SEC / 60} min`],
                  ["Offered", `${(f.auctionSupplyBps / 100).toFixed(1)}% · ${fmtCompact(forSale, 1)}`],
                  ["Floor", `${fmtPrice(input.floorPrice)} ${f.quoteAsset}`],
                  ["Target / cap", `${fmtAmount(input.targetRaise)} / ${fmtAmount(input.clearingCap)}`],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-3 border-t border-rule py-2">
                    <dt className="text-ink-muted">{k}</dt>
                    <dd className="num truncate text-right text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className={clsx("num mt-3 flex items-center gap-2 text-[11px]", issueCount ? "text-ink-muted" : "text-gain")}>
                <span className={clsx("h-1.5 w-1.5 rounded-full", issueCount ? "bg-rule-strong" : "bg-gain")} />
                {issueCount ? `${issueCount} item${issueCount > 1 ? "s" : ""} outstanding` : "Ready to deploy"}
              </p>
            </div>
            <ol className="mt-5 space-y-2 px-1 text-[12px] leading-relaxed text-ink-slate">
              <li className="flex gap-2.5"><span className="num text-ink-muted">a.</span>Bids are sealed commitments; nobody sees size or price until reveal.</li>
              <li className="flex gap-2.5"><span className="num text-ink-muted">b.</span>Wallets buying in the graduation slot receive 0% of holder rewards.</li>
              <li className="flex gap-2.5"><span className="num text-ink-muted">c.</span>The buyback vault only swaps to burn. It is not withdrawable.</li>
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}
