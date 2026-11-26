"use client";
// Original inline-SVG figures for /how-it-works. Printed broadsheet style: 1px hairlines, 1.25px strokes, mono labels,
// one accent per figure. Every figure is role="img" with a <title>; motion is reveal-once and off for reduced motion.
import clsx from "clsx";
import { motion } from "framer-motion";
import { useId, type ReactNode, type RefObject } from "react";
import { useFig } from "./anim";
import { EXAMPLE, FACTS, fmtNum, fmtPrice, share } from "./facts";

const L = "font-mono text-[length:calc(10px*var(--k,1))] uppercase tracking-[0.08em]";
const LS = "font-mono text-[length:calc(9px*var(--k,1))] uppercase tracking-[0.08em]";

function Fig({ title, viewBox, children, className, svgRef }: { title: string; viewBox: string; children: ReactNode; className?: string; svgRef?: RefObject<SVGSVGElement | null> }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg
      ref={svgRef}
      viewBox={viewBox}
      fill="none"
      /* --k scales every label: a 400-unit figure renders at ~260px on a 320px phone, so labels grow there to stay legible. */
      className={clsx("block h-auto w-full [--k:1.3] min-[480px]:[--k:1.15] sm:[--k:1]", className)}
      role="img"
      aria-labelledby={`t${id}`}
    >
      <title id={`t${id}`}>{title}</title>
      {children}
    </svg>
  );
}

function useSafeId(prefix: string) {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/** Small wallet glyph: body, flap line and clasp. */
function Wallet({ x, y, w, h, className = "stroke-ink" }: { x: number; y: number; w: number; h: number; className?: string }) {
  return (
    <g className={className} strokeWidth="1.25">
      <rect x={x} y={y} width={w} height={h} rx="9" className="fill-sheet" />
      <path d={`M${x} ${y + h * 0.28} H${x + w}`} />
      <rect x={x + w - 30} y={y + h * 0.42} width="30" height={h * 0.28} rx="4" className="fill-paper" />
      <circle cx={x + w - 18} cy={y + h * 0.56} r="2.6" className="fill-ink" stroke="none" />
    </g>
  );
}

/* ================================================================== hero: the whole loop */

/** Round SVG coordinates so server and client trig output serialise identically (no hydration mismatch). */
const r2 = (n: number) => Math.round(n * 100) / 100;

const LOOP = ["Sign in", "Deposit", "Seal a bid", "Reveal", "Clear", "Claim", "Buy back", "Fees", "Anti-snipe", "Withdraw"];

export function LoopFigure({ stepIds }: { stepIds?: string[] } = {}) {
  const f = useFig();
  const cx = 320;
  const cy = 280;
  const R = 186;
  const nodes = LOOP.map((label, i) => {
    const a = ((-90 + i * 36) * Math.PI) / 180;
    return { label, i, x: r2(cx + R * Math.cos(a)), y: r2(cy + R * Math.sin(a)), c: Math.cos(a), s: Math.sin(a), a };
  });
  return (
    <>
    <Fig
      svgRef={f.ref}
      viewBox="0 0 640 560"
      className="[--k:1.8] min-[480px]:[--k:1.5] sm:[--k:1.25] lg:[--k:1]"
      title="The Sealed loop in ten steps arranged in a circle: sign in, deposit, seal a bid, reveal, clear at one price, claim, buy back, fees, anti-snipe and withdraw. At the centre, sealed bids resolve to one clearing price."
    >
      {/* fine tick ring */}
      <g className="stroke-rule-strong" strokeWidth="1">
        {Array.from({ length: 120 }, (_, k) => {
          const a = (k * 3 * Math.PI) / 180;
          const r1 = R + 6;
          const ro = k % 12 === 0 ? R + 14 : R + 10;
          return <path key={k} d={`M${r2(cx + r1 * Math.cos(a))} ${r2(cy + r1 * Math.sin(a))} L${r2(cx + ro * Math.cos(a))} ${r2(cy + ro * Math.sin(a))}`} />;
        })}
      </g>
      {/* the loop path */}
      <motion.circle cx={cx} cy={cy} r={R} className="stroke-ink" strokeWidth="1.25" {...f.draw(0.1, 1.8)} style={{ rotate: -90 }} />
      {/* direction chevrons between stations */}
      {nodes.map((n) => {
        const a = n.a + (18 * Math.PI) / 180;
        const x = r2(cx + R * Math.cos(a));
        const y = r2(cy + R * Math.sin(a));
        const deg = r2((a * 180) / Math.PI + 90);
        return <path key={`c${n.i}`} d="M-3.5 -4 L1.5 0 L-3.5 4" transform={`translate(${x} ${y}) rotate(${deg})`} className="stroke-ink" strokeWidth="1.25" />;
      })}

      {/* centre: the seal */}
      <g className="animate-ring-slow motion-reduce:animate-none" style={{ transformOrigin: `${cx}px ${cy}px`, transformBox: "view-box" }}>
        <circle cx={cx} cy={cy} r="118" className="stroke-ink" strokeWidth="1.25" strokeDasharray="2 5" />
      </g>
      <circle cx={cx} cy={cy} r="78" className="stroke-rule-strong" strokeWidth="1" />
      <circle cx={cx} cy={cy} r="30" className="fill-ink" />
      <motion.path d={`M${cx - 150} ${cy} H${cx - 36} M${cx + 36} ${cy} H${cx + 150}`} className="stroke-signal" strokeWidth="1.5" {...f.draw(0.9, 0.9)} />
      <text x={cx} y={cy - 46} textAnchor="middle" className={`${L} fill-ink-muted`}>Sealed bids in</text>
      <text x={cx} y={cy + 56} textAnchor="middle" className={`${L} fill-signal`}>One price out</text>

      {/* stations */}
      {nodes.map((n) => {
        const lr = R + 32;
        const lx = r2(cx + lr * n.c);
        const ly = r2(cy + lr * n.s);
        const anchor = n.c > 0.25 ? "start" : n.c < -0.25 ? "end" : "middle";
        const dy = n.s < -0.9 ? -6 : n.s > 0.9 ? 14 : 5;
        return (
          <motion.g key={n.i} {...f.fade(0.2 + n.i * 0.06)}>
            <circle cx={n.x} cy={n.y} r="16" className={clsx("max-sm:[r:23px]", n.i === 4 ? "fill-ink stroke-ink" : "fill-sheet stroke-ink")} strokeWidth="1.25" />
            <text x={n.x} y={n.y} dominantBaseline="central" textAnchor="middle" className={clsx("font-mono text-[length:calc(11px*var(--k,1))]", n.i === 4 ? "fill-paper" : "fill-ink")}>
              {String(n.i + 1).padStart(2, "0")}
            </text>
            <text x={lx} y={ly + dy} textAnchor={anchor} className="fill-ink font-sans text-[16px] font-semibold tracking-[-0.01em] max-sm:hidden">
              {n.label}
            </text>
          </motion.g>
        );
      })}
    </Fig>
    {/* Phones: station names would render at ~7px around the ring, so they move into a two-column key below it. */}
    <nav aria-label="Jump to a step" className="sm:hidden">
      <ol className="mt-5 grid grid-cols-2 gap-x-6 border-t border-rule">
        {LOOP.map((label, i) => {
          const inner = (
            <>
              <span className={clsx("num text-[11px]", i === 4 ? "text-signal" : "text-ink-muted")}>{String(i + 1).padStart(2, "0")}</span>
              {label}
            </>
          );
          const id = stepIds?.[i];
          return (
            <li key={label} className="border-b border-rule">
              {id ? (
                <a href={`#${id}`} className="flex min-h-[44px] items-center gap-2.5 text-[13px] text-ink">
                  {inner}
                </a>
              ) : (
                <span className="flex min-h-[44px] items-center gap-2.5 text-[13px] text-ink">{inner}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
    </>
  );
}

/* ================================================================== 01 connect & sign */

export function SignFigure() {
  const f = useFig();
  return (
    <Fig svgRef={f.ref} viewBox="0 0 400 260" title="Your wallet signs a short text message. The message says it is not a transaction and costs no fee.">
      <motion.g {...f.fade(0)}>
        <Wallet x={20} y={92} w={120} h={84} />
        <text x={80} y={198} textAnchor="middle" className={`${L} fill-ink-muted`}>Your wallet</text>
      </motion.g>
      <motion.path d="M148 134 C 182 134, 190 104, 220 104" className="stroke-ink-muted" strokeWidth="1" strokeDasharray="3 3" {...f.draw(0.2, 0.7)} />
      <motion.g {...f.fade(0.25, 8)}>
        <rect x="222" y="30" width="160" height="190" rx="6" className="fill-sheet stroke-ink" strokeWidth="1.25" />
        <text x="236" y="52" className={`${LS} fill-ink-muted`}>Message</text>
        <path d="M236 60 H368" className="stroke-rule" strokeWidth="1" />
        <text x="236" y="80" className="fill-ink font-mono text-[length:calc(10.5px*var(--k,1))]">Sign in to Sealed.</text>
        <text x="236" y="98" className="fill-ink-slate font-mono text-[length:calc(10.5px*var(--k,1))]">No transaction.</text>
        <text x="236" y="116" className="fill-ink-slate font-mono text-[length:calc(10.5px*var(--k,1))]">No fee.</text>
        <path d="M236 136 H368" className="stroke-rule" strokeWidth="1" />
      </motion.g>
      <motion.path
        d="M238 178 C 246 160, 252 160, 254 172 S 262 190, 268 170 S 280 150, 284 172 S 296 184, 304 168 L 312 176"
        className="stroke-ink"
        strokeWidth="1.25"
        strokeLinecap="round"
        {...f.draw(0.7, 1.1)}
      />
      <text x="236" y="206" className={`${LS} fill-ink-muted`}>Signed by you</text>
      <motion.g {...f.fade(1.4)}>
        <circle cx="348" cy="174" r="18" className="fill-signal-tint stroke-signal" strokeWidth="1.25" />
        <circle cx="348" cy="174" r="12.5" className="stroke-signal" strokeWidth="1" strokeDasharray="1.6 2" />
        <path d="M341.5 174.5 l4.5 4.5 l8 -9" className="stroke-signal" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </motion.g>
      <text x="20" y="246" className={`${L} fill-ink`}>Network fee <tspan className="fill-ink-muted">0 SOL</tspan></text>
      <text x="382" y="246" textAnchor="end" className={`${L} fill-ink`}>Transaction <tspan className="fill-ink-muted">none</tspan></text>
    </Fig>
  );
}

/* ================================================================== 02 deposit */

export function DepositFigure() {
  const f = useFig();
  return (
    <Fig svgRef={f.ref} viewBox="0 0 400 260" title="You send SOL or USDC from your wallet to the Sealed company wallet with your memo attached. After the transfer is finalized, your Sealed balance is credited.">
      <Wallet x={16} y={70} w={96} h={66} />
      <text x={64} y={156} textAnchor="middle" className={`${L} fill-ink-muted`}>Your wallet</text>

      <motion.path d="M120 103 H262" className="stroke-ink" strokeWidth="1.25" {...f.draw(0.15, 0.8)} />
      <motion.path d="M256 97 L263 103 L256 109" className="stroke-ink" strokeWidth="1.25" {...f.fade(0.8)} />
      <motion.g {...f.fade(0.4, -6)}>
        <path d="M190 84 V103" className="stroke-ink-muted" strokeWidth="1" strokeDasharray="2 2" />
        <rect x="132" y="62" width="116" height="22" rx="4" className="fill-sheet stroke-rule-strong" strokeWidth="1" />
        <text x="190" y="77" textAnchor="middle" className="fill-ink font-mono text-[length:calc(9.5px*var(--k,1))]">
          <tspan className="fill-ink-muted">MEMO </tspan>sealed:7xk2
        </text>
      </motion.g>

      {/* company wallet as a private bank */}
      <motion.g {...f.fade(0.3)}>
        <path d="M272 64 L330 36 L388 64 Z" className="fill-paper-deep stroke-ink" strokeWidth="1.25" strokeLinejoin="round" />
        <rect x="278" y="64" width="104" height="76" className="fill-sheet stroke-ink" strokeWidth="1.25" />
        {[294, 314, 334, 354, 370].slice(0, 4).map((x) => (
          <path key={x} d={`M${x + 4} 74 V130`} className="stroke-ink" strokeWidth="1" />
        ))}
        <path d="M272 140 H388" className="stroke-ink" strokeWidth="1.25" />
        <text x="330" y="158" textAnchor="middle" className={`${L} fill-ink-muted`}>Company wallet</text>
        <text x="330" y="172" textAnchor="middle" className="fill-ink-slate font-mono text-[length:calc(9.5px*var(--k,1))]">{FACTS.companyWalletShort}</text>
      </motion.g>

      {/* finality, then the ledger credit */}
      {[0, 1, 2].map((k) => (
        <motion.rect key={k} x={16 + k * 30} y="204" width="26" height="6" className="fill-ink" {...f.growX(0.9 + k * 0.25)} />
      ))}
      <motion.g {...f.fade(1.7)}>
        <path d="M114 207 l4 4 l7 -8" className="stroke-gain" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <text x="132" y="211" className={`${L} fill-gain`}>Finalized</text>
      </motion.g>
      <path d="M16 226 H384" className="stroke-rule" strokeWidth="1" />
      <text x="16" y="246" className={`${L} fill-ink-muted`}>Sealed balance</text>
      <motion.text x="384" y="246" textAnchor="end" className="fill-gain font-mono text-[length:calc(12px*var(--k,1))]" {...f.fade(1.9)}>
        +2.50 SOL
      </motion.text>
    </Fig>
  );
}

/* ================================================================== 03 sealed bid */

function Envelope({ x, y, w, h, front = false }: { x: number; y: number; w: number; h: number; front?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="5" className={clsx("fill-sheet", front ? "stroke-ink" : "stroke-rule-strong")} strokeWidth={front ? 1.25 : 1} />
      <path d={`M${x} ${y + 1} L${x + w / 2} ${y + 56} L${x + w} ${y + 1}`} className={front ? "stroke-ink" : "stroke-rule-strong"} strokeWidth={front ? 1.25 : 1} strokeLinejoin="round" />
    </g>
  );
}

export function SealFigure() {
  const f = useFig();
  const W = 220;
  const H = 140;
  const fx = 120;
  const fy = 96;
  return (
    <Fig svgRef={f.ref} viewBox="0 0 400 260" title="A stack of sealed envelopes. On the front envelope the max price and amount are blacked out; only a fingerprint code is visible.">
      <text x="16" y="18" className={`${L} fill-ink-muted`}>Sealed book</text>
      <text x="384" y="18" textAnchor="end" className={`${L} fill-ink`}>4 bids <tspan className="fill-ink-muted">· 0 visible</tspan></text>
      {[0, 1, 2].map((k) => (
        <motion.g key={k} {...f.fade(k * 0.1, -10)}>
          <Envelope x={30 + k * 30} y={30 + k * 22} w={W} h={H} />
        </motion.g>
      ))}
      <motion.g {...f.fade(0.35, -10)}>
        <Envelope x={fx} y={fy} w={W} h={H} front />
        <text x={fx + 16} y={fy + 84} className={`${LS} fill-ink-muted`}>Max price</text>
        <motion.rect x={fx + 96} y={fy + 76} width="104" height="10" rx="1" className="fill-ink" {...f.growX(0.7)} />
        <text x={fx + 16} y={fy + 106} className={`${LS} fill-ink-muted`}>Amount</text>
        <motion.rect x={fx + 96} y={fy + 98} width="72" height="10" rx="1" className="fill-ink" {...f.growX(0.85)} />
        <path d={`M${fx + 12} ${fy + 116} H${fx + W - 12}`} className="stroke-rule" strokeWidth="1" />
        <text x={fx + 16} y={fy + 131} className="fill-ink font-mono text-[length:calc(9.5px*var(--k,1))]">
          <tspan className="fill-ink-muted">FINGERPRINT </tspan>0x9f3a…c21e
        </text>
        {/* the wax seal */}
        <circle cx={fx + W / 2} cy={fy + 56} r="14" className="fill-signal-tint stroke-signal" strokeWidth="1.25" />
        <g className="animate-ring motion-reduce:animate-none" style={{ transformOrigin: `${fx + W / 2}px ${fy + 56}px`, transformBox: "view-box" }}>
          <circle cx={fx + W / 2} cy={fy + 56} r="9" className="stroke-signal" strokeWidth="1" strokeDasharray="1.6 2" />
        </g>
        <circle cx={fx + W / 2} cy={fy + 56} r="3.2" className="fill-signal" />
      </motion.g>
    </Fig>
  );
}

/* ================================================================== 04 reveal */

export function RevealFigure() {
  const f = useFig();
  return (
    <Fig svgRef={f.ref} viewBox="0 0 400 250" title="A timeline: a long bidding window, then a short reveal window. With auto-reveal on, your envelope opens by itself and shows your price and amount.">
      {/* auto-reveal toggle */}
      <motion.g {...f.fade(0)}>
        <rect x="20" y="54" width="44" height="24" rx="12" className="fill-ink" />
        <circle cx="52" cy="66" r="8" className="fill-paper" />
        <text x="76" y="64" className={`${L} fill-ink`}>Auto-reveal</text>
        <text x="76" y="78" className={`${L} fill-gain`}>On</text>
        <text x="20" y="102" className={`${LS} fill-ink-muted`}>We open it for you</text>
      </motion.g>
      <motion.path d="M150 84 C 176 84, 180 118, 196 118" className="stroke-ink-muted" strokeWidth="1" strokeDasharray="3 3" {...f.draw(0.3, 0.6)} />

      {/* envelope with the card rising out */}
      <path d="M200 64 L280 22 L360 64" className="stroke-ink" strokeWidth="1.25" strokeLinejoin="round" />
      <rect x="200" y="64" width="160" height="92" rx="4" className="fill-sheet stroke-ink" strokeWidth="1.25" />
      <motion.g {...f.fade(0.6, 22)}>
        <rect x="204" y="30" width="152" height="74" rx="3" className="fill-sheet stroke-ink" strokeWidth="1" />
        <text x="214" y="50" className={`${LS} fill-ink-muted`}>Price</text>
        <text x="346" y="50" textAnchor="end" className="fill-ink font-mono text-[length:calc(10px*var(--k,1))]">{fmtPrice(EXAMPLE.bids[2]!.maxPrice)} USDC</text>
        <text x="214" y="68" className={`${LS} fill-ink-muted`}>Amount</text>
        <text x="346" y="68" textAnchor="end" className="fill-ink font-mono text-[length:calc(10px*var(--k,1))]">{fmtNum(EXAMPLE.bids[2]!.amount)} USDC</text>
      </motion.g>
      <path d="M200 64 L280 108 L360 64 V156 H200 Z" className="fill-sheet stroke-ink" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M344 158 V188" className="stroke-ink-muted" strokeWidth="1" strokeDasharray="2 2" />

      {/* the two windows */}
      <text x="16" y="186" className={`${L} fill-ink`}>Bidding <tspan className="fill-ink-muted">{FACTS.commitMin} to {FACTS.commitMax} min</tspan></text>
      <text x="384" y="186" textAnchor="end" className={`${L} fill-signal`}>Reveal {FACTS.revealMin} min</text>
      <motion.rect x="16" y="194" width="286" height="10" className="fill-ink" {...f.growX(0.1)} />
      <motion.rect x="306" y="194" width="78" height="10" className="fill-signal" {...f.growX(0.9)} />
      <text x="16" y="226" className={`${LS} fill-ink-muted`}>Only fingerprints</text>
      <text x="384" y="226" textAnchor="end" className={`${LS} fill-ink-muted`}>Real numbers counted</text>
    </Fig>
  );
}

/* ================================================================== 05 one clearing price */

export function ClearingFigure() {
  const f = useFig();
  const x0 = 64;
  const yOf = (p: number) => 240 - ((p - 0.01) / 0.01) * 196;
  const maxAmt = Math.max(...EXAMPLE.bids.map((b) => b.amount));
  const wOf = (a: number) => (a / maxAmt) * 200;
  const yP = yOf(EXAMPLE.price);
  return (
    <Fig
      svgRef={f.ref}
      viewBox="0 0 400 280"
      title={`Bids drawn on a price ladder. A line at ${fmtPrice(EXAMPLE.price)} USDC splits them: bids at or above the line win and all pay ${fmtPrice(EXAMPLE.price)}; bids below are refunded.`}
    >
      <text x="16" y="18" className={`${L} fill-ink-muted`}>Price · USDC per token</text>
      {/* axis */}
      <path d={`M${x0} 36 V244 H330`} className="stroke-ink" strokeWidth="1" />
      {Array.from({ length: 11 }, (_, k) => {
        const p = 0.01 + k * 0.001;
        const y = yOf(p);
        const major = k % 5 === 0;
        return (
          <g key={k}>
            <path d={`M${x0 - (major ? 7 : 4)} ${y} H${x0}`} className="stroke-ink" strokeWidth="1" />
            {major && (
              <text x={x0 - 11} y={y + 3.5} textAnchor="end" className="fill-ink-muted font-mono text-[length:calc(9.5px*var(--k,1))]">
                {fmtPrice(p)}
              </text>
            )}
          </g>
        );
      })}
      <text x="330" y="262" textAnchor="end" className={`${LS} fill-ink-muted`}>Amount · USDC</text>

      {/* bids */}
      {EXAMPLE.bids.map((b, i) => {
        const y = yOf(b.maxPrice);
        return (
          <g key={b.who}>
            <motion.rect
              x={x0 + 1}
              y={y - 7}
              width={wOf(b.amount)}
              height="14"
              className={b.won ? "fill-ink" : "fill-paper-deep stroke-rule-strong"}
              strokeWidth="1"
              {...f.growX(0.1 + i * 0.1)}
            />
            <motion.text x={x0 + wOf(b.amount) + 7} y={b.maxPrice === EXAMPLE.price ? y - 4 : y + 3.5} className={clsx("font-mono text-[length:calc(10px*var(--k,1))]", b.won ? "fill-ink" : "fill-ink-muted")} {...f.fade(0.5 + i * 0.1)}>
              {b.who} · {fmtNum(b.amount)}
            </motion.text>
          </g>
        );
      })}

      {/* the clearing line */}
      <motion.path d={`M${x0} ${yP} H392`} className="stroke-signal" strokeWidth="1.25" strokeDasharray="4 3" {...f.draw(1, 0.9)} />
      <motion.g {...f.fade(1.5)}>
        <text x="392" y={yP + 16} textAnchor="end" className={`${L} fill-signal`}>Clears {fmtPrice(EXAMPLE.price)}</text>
        <text x="392" y={yP - 26} textAnchor="end" className={`${LS} fill-ink`}>Above: win, pay {fmtPrice(EXAMPLE.price)}</text>
        <text x="392" y={yP + 33} textAnchor="end" className={`${LS} fill-ink-muted`}>Below: refunded</text>
      </motion.g>
    </Fig>
  );
}

/* ================================================================== 06 claim & refund */

export function ClaimFigure() {
  const f = useFig();
  const win = EXAMPLE.bids.find((b) => b.won && b.maxPrice === EXAMPLE.price) ?? EXAMPLE.bids[0]!;
  const lose = EXAMPLE.bids.find((b) => !b.won) ?? EXAMPLE.bids[EXAMPLE.bids.length - 1]!;
  return (
    <Fig svgRef={f.ref} viewBox="0 0 400 240" title={`A winning bid of ${fmtNum(win.amount)} USDC becomes ${fmtNum(win.tokens)} tokens. A bid below the price returns ${fmtNum(lose.refund)} USDC to your balance.`}>
      {/* winning lane */}
      <rect x="16" y="28" width="118" height="58" rx="6" className="fill-sheet stroke-ink" strokeWidth="1.25" />
      <text x="28" y="48" className={`${LS} fill-ink-muted`}>Bid {win.who}</text>
      <text x="28" y="72" className="fill-ink font-mono text-[length:calc(12px*var(--k,1))]">{fmtNum(win.amount)} USDC</text>
      <motion.path d="M142 57 H244" className="stroke-ink" strokeWidth="1.25" {...f.draw(0.2, 0.7)} />
      <path d="M238 51 L245 57 L238 63" className="stroke-ink" strokeWidth="1.25" />
      <text x="193" y="48" textAnchor="middle" className={`${LS} fill-ink-muted`}>at {fmtPrice(EXAMPLE.price)}</text>
      {[0, 1, 2].map((k) => (
        <motion.g key={k} {...f.fade(0.7 + k * 0.12, -8)}>
          <ellipse cx="282" cy={74 - k * 11} rx="24" ry="7" className="fill-sheet stroke-ink" strokeWidth="1.25" />
          <path d={`M258 ${74 - k * 11} v5 a24 7 0 0 0 48 0 v-5`} className="fill-sheet stroke-ink" strokeWidth="1.25" />
        </motion.g>
      ))}
      <text x="316" y="56" className="fill-ink font-mono text-[length:calc(12px*var(--k,1))]">{fmtNum(win.tokens)}</text>
      <text x="316" y="72" className={`${LS} fill-ink-muted`}>Tokens</text>

      <path d="M16 120 H384" className="stroke-rule" strokeWidth="1" strokeDasharray="2 3" />

      {/* refund lane */}
      <rect x="16" y="150" width="118" height="58" rx="6" className="fill-paper-deep stroke-rule-strong" strokeWidth="1" />
      <text x="28" y="170" className={`${LS} fill-ink-muted`}>Bid {lose.who}</text>
      <text x="28" y="194" className="fill-ink-slate font-mono text-[length:calc(12px*var(--k,1))]">{fmtNum(lose.amount)} USDC</text>
      <motion.path d="M142 179 H244" className="stroke-ink-muted" strokeWidth="1.25" strokeDasharray="4 3" {...f.draw(0.5, 0.7)} />
      <path d="M238 173 L245 179 L238 185" className="stroke-ink-muted" strokeWidth="1.25" />
      <text x="193" y="170" textAnchor="middle" className={`${LS} fill-ink-muted`}>Below the price</text>
      <motion.g {...f.fade(1)}>
        <rect x="252" y="150" width="132" height="58" rx="6" className="fill-gain-tint stroke-gain" strokeWidth="1.25" />
        <text x="264" y="170" className={`${LS} fill-gain`}>Refunded</text>
        <text x="264" y="194" className="fill-gain font-mono text-[length:calc(12px*var(--k,1))]">+{fmtNum(lose.refund)} USDC</text>
      </motion.g>
      <text x="16" y="232" className={`${LS} fill-ink-muted`}>Both land in your Sealed balance</text>
    </Fig>
  );
}

/* ================================================================== 07 buyback vault (night band) */

export function VaultFigure() {
  const f = useFig();
  const ticks = 12;
  return (
    <Fig svgRef={f.ref} viewBox="0 0 400 280" title={`A locked vault holding the credit line. Every ${FACTS.dripEvery} minutes it drips a slice into the market, buys the token and burns it. The vault cannot be withdrawn.`}>
      {/* lock */}
      <path d="M92 30 v-8 a8 8 0 0 1 16 0 v8" className="stroke-night-text" strokeWidth="1.25" />
      <rect x="86" y="30" width="28" height="20" rx="3" className="fill-night stroke-night-text" strokeWidth="1.25" />
      <circle cx="100" cy="40" r="2" className="fill-night-text" />
      {/* vault body */}
      <rect x="40" y="58" width="120" height="156" rx="10" className="stroke-night-text" strokeWidth="1.25" />
      <motion.rect x="48" y="118" width="104" height="88" rx="4" className="fill-gain-bright/25" {...f.growY(0.1)} />
      <path d="M48 118 H152" className="stroke-gain-bright" strokeWidth="1.25" />
      {Array.from({ length: ticks + 1 }, (_, k) => (
        <path key={k} d={`M${k % 3 === 0 ? 140 : 145} ${66 + k * (140 / ticks)} H152`} className="stroke-night-muted" strokeWidth="1" />
      ))}
      <text x="56" y="80" className={`${LS} fill-night-muted`}>Credit</text>
      <text x="56" y="96" className="fill-night-text font-mono text-[length:calc(11px*var(--k,1))]">{FACTS.creditMin} to {FACTS.creditMax}</text>
      <text x="56" y="108" className={`${LS} fill-night-muted`}>of the raise</text>
      <text x="100" y="236" textAnchor="middle" className={`${LS} fill-night-muted`}>Locked · no withdrawals</text>

      {/* spout and drips */}
      <path d="M160 190 H214 V198" className="stroke-night-text" strokeWidth="1.25" />
      {[0, 1, 2].map((k) => (
        <motion.circle key={k} cx="214" cy={210 + k * 12} r={3 - k * 0.5} className="fill-gain-bright" {...f.fade(0.6 + k * 0.18, -8)} />
      ))}
      <text x="226" y="212" className={`${LS} fill-night-muted`}>Every {FACTS.dripEvery} min</text>
      <path d="M180 252 H262" className="stroke-night-text" strokeWidth="1.25" />
      <text x="180" y="270" className={`${LS} fill-night-muted`}>Buy on the market</text>

      {/* to the flame */}
      <motion.path d="M262 252 C 300 252, 318 224, 320 186" className="stroke-night-muted" strokeWidth="1" strokeDasharray="3 3" {...f.draw(1, 0.8)} />
      <motion.g {...f.fade(1.4, 6)}>
        <g transform="translate(284 86) scale(3)">
          <path d="M12 22c4 0 7-2.7 7-6.8C19 10 14 8 14 3c-3 1.5-5 4.6-5 7.5-1-.5-2-1.7-2-3C5.3 9 5 11.6 5 15.2 5 19.3 8 22 12 22Z" className="fill-burn-bright/15 stroke-burn-bright" strokeWidth="1.25" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          <path d="M12 22c-2 0-3.2-1.4-3.2-3.2 0-2 1.6-3 2.4-4.8.6 1.4 1.6 2 2.4 2.8.9.9 1.6 1.6 1.6 2.4 0 1.6-1.2 2.8-3.2 2.8Z" className="stroke-burn-bright" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </g>
        <text x="320" y="174" textAnchor="middle" className={`${L} fill-burn-bright`}>Burned</text>
        <text x="320" y="72" textAnchor="middle" className={`${LS} fill-night-muted`}>Out of circulation</text>
      </motion.g>
    </Fig>
  );
}

/* ================================================================== 08 fees: repay, then flywheel */

export function FeesFigure() {
  const f = useFig();
  const W = 368;
  const x = 16;
  const repay = W * share(FACTS.repayBps);
  const holders = W * share(FACTS.holdersBps);
  const burn = W * share(FACTS.burnBps);
  const pc = (bps: number) => `${bps / 100}%`;
  return (
    <Fig
      svgRef={f.ref}
      viewBox="0 0 400 260"
      title={`Two bars. Until the credit is repaid, ${pc(FACTS.repayBps)} of fees repay it and ${pc(FACTS.opsBps)} go to operations. After it is fully repaid, ${pc(FACTS.holdersBps)} go to holders, ${pc(FACTS.burnBps)} to buyback and burn, ${pc(FACTS.treasuryBps)} to the treasury.`}
    >
      <text x={x} y="20" className={`${L} fill-ink-muted`}>Phase 1 · until repaid</text>
      <motion.rect x={x} y="30" width={repay} height="24" className="fill-ink" {...f.growX(0.1)} />
      <rect x={x + repay} y="30" width={W - repay} height="24" className="fill-paper-deep stroke-rule-strong" strokeWidth="1" />
      <text x={x + 10} y="46" className={`${L} fill-paper`}>{pc(FACTS.repayBps)} repays credit</text>
      <text x={x + repay + 8} y="46" className={`${L} fill-ink-slate`}>{pc(FACTS.opsBps)} ops</text>

      <text x={x} y="88" className={`${LS} fill-ink-muted`}>Credit repaid</text>
      <text x={x + W} y="88" textAnchor="end" className="fill-gain font-mono text-[length:calc(10px*var(--k,1))]">100%</text>
      <rect x={x} y="94" width={W} height="4" className="fill-rule" />
      <motion.rect x={x} y="94" width={W} height="4" className="fill-gain" {...f.growX(0.6)} />
      <motion.path d="M200 108 V128 M194 122 L200 128 L206 122" className="stroke-ink" strokeWidth="1.25" {...f.fade(1.3)} />

      <text x={x} y="156" className={`${L} fill-ink-muted`}>Phase 2 · forever after</text>
      <motion.g {...f.fade(1.4)}>
        <rect x={x} y="166" width={holders} height="24" className="fill-gain" />
        <rect x={x + holders} y="166" width={burn} height="24" className="fill-ink" />
        <rect x={x + holders + burn} y="166" width={W - holders - burn} height="24" className="fill-paper-deep stroke-rule-strong" strokeWidth="1" />
        <text x={x + 10} y="182" className={`${L} fill-sheet`}>{pc(FACTS.holdersBps)} holders</text>
        <text x={x + holders + 8} y="182" className={`${L} fill-paper`}>{pc(FACTS.burnBps)} burn</text>
        <text x={x + holders + burn + 6} y="182" className={`${L} fill-ink-slate`}>{pc(FACTS.treasuryBps)}</text>
        <text x={x} y="208" className={`${LS} fill-ink-muted`}>To stakers, in SOL or USDC</text>
        <text x={x + W} y="208" textAnchor="end" className={`${LS} fill-ink-muted`}>Treasury</text>
      </motion.g>
      <path d={`M${x} 226 H${x + W}`} className="stroke-rule" strokeWidth="1" />
      <text x={x} y="246" className={`${LS} fill-ink`}>Every trade pays a {FACTS.poolFee} pool fee</text>
    </Fig>
  );
}

/* ================================================================== 09 anti-snipe */

export function AntiSnipeFigure() {
  const f = useFig();
  const hatch = useSafeId("hatch");
  const x0 = 40;
  const per = 34;
  const xt = (t: number) => x0 + t * per;
  const axis = 156;
  const win = FACTS.antiSnipeSec;
  const buys = [
    { t: 0.25, h: 64 },
    { t: 0.9, h: 84 },
    { t: 1.6, h: 52 },
    { t: 3.1, h: 40 },
    { t: 4.4, h: 58 },
    { t: 5.9, h: 34 },
    { t: 7.3, h: 50 },
    { t: 8.8, h: 42 },
  ];
  return (
    <Fig svgRef={f.ref} viewBox="0 0 400 240" title={`A timeline starting at graduation. Buys in the first ${win} seconds are marked with a cross and earn no holder rewards. Later buys are marked with a dot and can earn rewards.`}>
      <defs>
        <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <path d="M0 0 V6" className="stroke-burn" strokeWidth="1" strokeOpacity="0.35" />
        </pattern>
      </defs>
      <motion.rect x={x0} y="50" width={win * per} height={axis - 50} fill={`url(#${hatch})`} className="stroke-burn" strokeWidth="1" strokeOpacity="0.5" {...f.growX(0.1)} />
      <text x={x0 + (win * per) / 2} y="42" textAnchor="middle" className={`${L} fill-burn`}>First {win} s</text>
      <path d={`M${x0} 24 V${axis + 6}`} className="stroke-ink" strokeWidth="1.25" />
      <text x={x0 + 6} y="22" className={`${L} fill-ink`}>Graduation</text>

      <path d={`M${x0} ${axis} H384`} className="stroke-ink" strokeWidth="1" />
      {Array.from({ length: 11 }, (_, t) => (
        <g key={t}>
          <path d={`M${xt(t)} ${axis} v${t % 2 === 0 ? 6 : 3}`} className="stroke-ink" strokeWidth="1" />
          {t % 2 === 0 && (
            <text x={xt(t)} y={axis + 18} textAnchor="middle" className="fill-ink-muted font-mono text-[length:calc(9.5px*var(--k,1))]">
              {t}s
            </text>
          )}
        </g>
      ))}

      {buys.map((b, i) => {
        const x = xt(b.t);
        const y = axis - b.h;
        const snipe = b.t < win;
        return (
          <motion.g key={i} {...f.fade(0.3 + i * 0.08, 6)}>
            <path d={`M${x} ${axis} V${y}`} className={snipe ? "stroke-burn" : "stroke-ink-muted"} strokeWidth="1" />
            {snipe ? (
              <path d={`M${x - 4} ${y - 4} l8 8 M${x + 4} ${y - 4} l-8 8`} className="stroke-burn" strokeWidth="1.5" strokeLinecap="round" />
            ) : (
              <circle cx={x} cy={y} r="3.5" className="fill-gain" />
            )}
          </motion.g>
        );
      })}

      <path d={`M${x0 - 4} 204 l8 8 M${x0 + 4} 204 l-8 8`} className="stroke-burn" strokeWidth="1.5" strokeLinecap="round" />
      <text x={x0 + 12} y="212" className={`${LS} fill-ink`}>No holder rewards</text>
      <circle cx="222" cy="208" r="3.5" className="fill-gain" />
      <text x="232" y="212" className={`${LS} fill-ink`}>Can earn rewards</text>
    </Fig>
  );
}

/* ================================================================== 10 withdraw */

export function WithdrawFigure() {
  const f = useFig();
  return (
    <Fig svgRef={f.ref} viewBox="0 0 400 260" title={`Your Sealed balance goes back to your wallet. Up to ${FACTS.autoWithdrawMax} is sent automatically; larger amounts pass a manual approval first. Proof of reserves compares what is held on chain with what is owed.`}>
      <rect x="16" y="96" width="112" height="60" rx="6" className="fill-sheet stroke-ink" strokeWidth="1.25" />
      <text x="28" y="116" className={`${LS} fill-ink-muted`}>Your balance</text>
      <text x="28" y="140" className="fill-ink font-mono text-[length:calc(11px*var(--k,1))]">{FACTS.assets.join(" · ")}</text>

      <motion.path d="M128 126 C 160 126, 160 66, 196 66 H254 C 276 66, 286 88, 288 112" className="stroke-ink" strokeWidth="1.25" {...f.draw(0.2, 1)} />
      <text x="200" y="56" className={`${LS} fill-ink`}>Up to {FACTS.autoWithdrawMax} <tspan className="fill-ink-muted">· automatic</tspan></text>

      <motion.path d="M128 126 C 160 126, 160 186, 196 186 H254 C 276 186, 286 164, 288 140" className="stroke-ink-muted" strokeWidth="1.25" strokeDasharray="4 3" {...f.draw(0.4, 1)} />
      <motion.g {...f.fade(1)}>
        <circle cx="244" cy="186" r="12" className="fill-gain-tint stroke-gain" strokeWidth="1.25" />
        <path d="M238.5 186.5 l4 4 l7 -8" className="stroke-gain" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </motion.g>
      <text x="200" y="214" className={`${LS} fill-ink`}>Above <tspan className="fill-ink-muted">· manual approval</tspan></text>

      <Wallet x={290} y={96} w={94} h={60} />
      <text x="337" y="176" textAnchor="middle" className={`${LS} fill-ink-muted`}>Your wallet</text>

      <path d="M16 232 H384" className="stroke-rule" strokeWidth="1" />
      <text x="16" y="252" className={`${LS} fill-ink`}>Proof of reserves <tspan className="fill-ink-muted">· held ≥ owed</tspan></text>
      <motion.rect x="290" y="240" width="94" height="5" className="fill-ink" {...f.growX(0.6)} />
      <motion.rect x="290" y="249" width="81" height="5" className="fill-paper-deep stroke-rule-strong" strokeWidth="1" {...f.growX(0.8)} />
    </Fig>
  );
}
