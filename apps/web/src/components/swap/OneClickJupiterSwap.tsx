"use client";
// Owned by defi-integrations-agent. One-click buy/sell card for a live launch.
// Venue: the program's internal CPMM pool (`swap` ix, 1% fee → Fee Collector). On mainnet, paying with a
// different quote asset first converts via Jupiter v6, then swaps through the pool. Demo launches simulate fills.
// OFFCHAIN custodial mode (web-offchain-agent): when the custody API is available the swap is a POST /api/trade/swap
// against the signed-in wallet's internal balances (no wallet transaction); quote/min-out are computed locally.
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { PublicKey } from "@solana/web3.js";
import { POOL_FEE_BPS, QUOTE_ASSETS, pdas, type LaunchSummary, type QuoteAssetSymbol } from "@sealed/shared";
import {
  JupiterClient,
  atomsToUi,
  buildTransaction,
  ensureAtaIx,
  isWsol,
  minOutWithSlippage,
  programErrorName,
  quoteSwap,
  reservesFromMarket,
  resolveQuoteAsset,
  selectSwapVenue,
  uiToAtoms,
  unwrapSolIx,
  wrapSolIxs,
  type CpmmQuote,
  type JupiterQuoteResponse,
  type PoolReserves,
} from "@sealed/defi";
import { demoSignature, errorMessage, sleep } from "@/lib/defi/config";
import { getSealedClient, launchKeys } from "@/lib/defi/program";
import { custodyTrade, openDeposit, tokenAssetId, useCustodyBalance, useCustodySession } from "@/lib/custody";

type Side = "buy" | "sell";
type Phase = "idle" | "confirm" | "pending" | "filled" | "error";

const spring = { type: "spring", stiffness: 260, damping: 26 } as const;
const SLIPPAGE_BPS = 100;
const TOKEN_DECIMALS = 6;

function fmt(n: number, max = 6): string {
  if (!Number.isFinite(n)) return "—";
  if (n !== 0 && Math.abs(n) < 10 ** -max) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

export function OneClickJupiterSwap({ launch }: { launch: LaunchSummary }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [payWith, setPayWith] = useState<QuoteAssetSymbol>(launch.quoteAsset);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [onchainReserves, setOnchainReserves] = useState<PoolReserves | null>(null);
  const [jupQuote, setJupQuote] = useState<JupiterQuoteResponse | null>(null);
  const [jupError, setJupError] = useState<string | null>(null);

  const custody = useCustodySession();
  const offchain = custody.availability === "available";
  const quoteBal = useCustodyBalance(launch.quoteAsset);
  const tokenBal = useCustodyBalance(tokenAssetId(launch.id));

  const quote = QUOTE_ASSETS[launch.quoteAsset];
  const isMainnet = launch.network === "mainnet";
  const tradable = (launch.status === "live" || launch.status === "flywheel") && !!launch.market;
  const convert = !offchain && !launch.isDemo && isMainnet && side === "buy" && payWith !== launch.quoteAsset && selectSwapVenue(launch.network, "quote-conversion") === "jupiter";

  /* ----------------------------------------------------------------------------- pool reserves */
  useEffect(() => {
    if (launch.isDemo || !tradable || offchain) return;
    let cancelled = false;
    (async () => {
      try {
        const client = await getSealedClient(connection, null);
        const [pool] = pdas.pool(launch.id, client.programId);
        const accounts = client.program.account as unknown as Record<string, { fetch(k: PublicKey): Promise<{ quoteReserve: { toString(): string }; tokenReserve: { toString(): string } }> }>;
        const acc = await accounts.pool!.fetch(pool);
        if (!cancelled) setOnchainReserves({ quoteReserve: BigInt(acc.quoteReserve.toString()), tokenReserve: BigInt(acc.tokenReserve.toString()) });
      } catch {
        /* IDL/pool unavailable → fall back to market snapshot */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, launch.id, launch.isDemo, tradable, offchain]);

  const reserves = useMemo<PoolReserves | null>(() => {
    if (onchainReserves) return onchainReserves;
    if (!launch.market) return null;
    return reservesFromMarket(launch.market, quote.decimals);
  }, [onchainReserves, launch.market, quote.decimals]);

  /* ------------------------------------------------------------------------- Jupiter (mainnet) */
  const payAsset = QUOTE_ASSETS[convert ? payWith : launch.quoteAsset];
  useEffect(() => {
    setJupQuote(null);
    setJupError(null);
    if (!convert) return;
    const n = Number(amount);
    if (!(n > 0)) return;
    const inMint = resolveQuoteAsset(payWith, launch.network).mint;
    const outMint = resolveQuoteAsset(launch.quoteAsset, launch.network).mint;
    if (!inMint || !outMint) {
      setJupError(`${payWith} is not configured on ${launch.network}`);
      return;
    }
    const ctrl = { cancelled: false };
    const t = setTimeout(async () => {
      try {
        const q = await new JupiterClient({ network: launch.network }).getQuote({
          inputMint: inMint, outputMint: outMint, amount: uiToAtoms(n, payAsset.decimals), slippageBps: 50,
        });
        if (!ctrl.cancelled) setJupQuote(q);
      } catch (e) {
        if (!ctrl.cancelled) setJupError(errorMessage(e));
      }
    }, 350);
    return () => {
      ctrl.cancelled = true;
      clearTimeout(t);
    };
  }, [convert, amount, payWith, launch.network, launch.quoteAsset, payAsset.decimals]);

  /* ------------------------------------------------------------------------------ pool quote */
  const poolQuote = useMemo<CpmmQuote | null>(() => {
    if (!reserves) return null;
    const n = Number(amount);
    if (!(n > 0)) return null;
    try {
      let amountIn: bigint;
      if (side === "buy") {
        if (convert) {
          if (!jupQuote) return null;
          amountIn = BigInt(jupQuote.otherAmountThreshold);
        } else amountIn = uiToAtoms(n, quote.decimals);
      } else amountIn = uiToAtoms(n, TOKEN_DECIMALS);
      return quoteSwap(amountIn, side === "buy", reserves);
    } catch {
      return null;
    }
  }, [reserves, amount, side, convert, jupQuote, quote.decimals]);

  const outDecimals = side === "buy" ? TOKEN_DECIMALS : quote.decimals;
  const outUi = poolQuote ? atomsToUi(poolQuote.amountOut, outDecimals) : 0;
  const minOutUi = poolQuote ? atomsToUi(minOutWithSlippage(poolQuote.amountOut, SLIPPAGE_BPS), outDecimals) : 0;
  const feeUi = poolQuote ? atomsToUi(poolQuote.feeQuote, quote.decimals) : 0;
  const impactPct = poolQuote ? poolQuote.priceImpactBps / 100 : 0;
  const priceUi = poolQuote ? atomsToUi(poolQuote.executionPrice, quote.decimals) : launch.market?.price ?? 0;
  const inSymbol = side === "buy" ? payAsset.symbol : launch.ticker;
  const outSymbol = side === "buy" ? launch.ticker : quote.symbol;
  const inBal = side === "buy" ? quoteBal : tokenBal;
  const showBal = offchain && custody.signedIn && inBal.known;
  const insufficient = showBal && Number(amount) > 0 && Number(amount) > inBal.available + 1e-12;

  /* -------------------------------------------------------------------------------- execute */
  async function execute() {
    if (!poolQuote) return;
    setMessage(null);
    if (offchain) {
      if (!custody.wallet) {
        setVisible(true);
        setPhase("idle");
        return;
      }
      setPhase("pending");
      try {
        if (!custody.signedIn) await custody.signIn();
        const r = await custodyTrade.swap(custody.wallet, {
          launchId: launch.id,
          side,
          amountIn: Number(amount),
          minAmountOut: Math.max(0, Number(minOutUi.toFixed(outDecimals))),
        });
        setLastSig(`ledger:${r.tradeId}`);
        setMessage(`Filled: ${fmt(r.amountOut)} ${outSymbol} · fee ${fmt(r.fee)} ${quote.symbol}${r.isSniper ? " · flagged by anti-snipe (0% rewards)" : ""}`);
        setPhase("filled");
        setAmount("");
      } catch (e) {
        const m = errorMessage(e);
        setMessage(/slippage|min.?amount/i.test(m) ? "Price moved beyond 1% slippage — try again" : m);
        setPhase("error");
      }
      return;
    }
    if (launch.isDemo) {
      setPhase("pending");
      await sleep(900);
      setLastSig(demoSignature(side));
      setMessage(`Simulated fill: ${fmt(outUi)} ${outSymbol}`);
      setPhase("filled");
      return;
    }
    if (!publicKey || !sendTransaction) {
      setVisible(true);
      setPhase("idle");
      return;
    }
    setPhase("pending");
    try {
      // Leg 1 (mainnet, optional): convert pay asset → launch quote asset via Jupiter.
      if (convert && jupQuote) {
        const jup = new JupiterClient({ network: launch.network });
        const built = await jup.buildSwapTx({ quote: jupQuote, userPublicKey: publicKey });
        const sig1 = await sendTransaction(built.transaction, connection);
        const c1 = await connection.confirmTransaction(
          { signature: sig1, blockhash: built.transaction.message.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight },
          "confirmed",
        );
        if (c1.value.err) throw new Error("Jupiter conversion failed");
      }
      // Leg 2: internal pool swap.
      const keys = launchKeys(launch);
      const quoteMint = keys.quoteMint;
      const client = await getSealedClient(connection, publicKey);
      const ixs = [
        ensureAtaIx(publicKey, publicKey, keys.tokenMint).ix,
        ensureAtaIx(publicKey, publicKey, quoteMint, keys.quoteTokenProgram).ix,
      ];
      const wsol = isWsol(quoteMint);
      if (wsol && side === "buy" && !convert) ixs.push(...wrapSolIxs(publicKey, poolQuote.amountIn).slice(1));
      ixs.push(await client.swapIx(keys, publicKey, poolQuote.amountIn, minOutWithSlippage(poolQuote.amountOut, SLIPPAGE_BPS), side === "buy"));
      if (wsol && side === "sell") ixs.push(unwrapSolIx(publicKey));
      const { tx, blockhash, lastValidBlockHeight } = await buildTransaction(connection, publicKey, ixs);
      const sig = await sendTransaction(tx, connection);
      const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (conf.value.err) throw new Error(`swap failed: ${JSON.stringify(conf.value.err)}`);
      setLastSig(sig);
      setMessage(`Filled: ~${fmt(outUi)} ${outSymbol}`);
      setPhase("filled");
    } catch (e) {
      const code = programErrorName(e);
      setMessage(code === "SlippageExceeded" ? "Price moved beyond 1% slippage — try again" : code ? `${code}: ${errorMessage(e)}` : errorMessage(e));
      setPhase("error");
    }
  }

  const canQuote = tradable && !!poolQuote && poolQuote.amountOut > 0n;
  const needsWallet = offchain ? !custody.wallet : !launch.isDemo && !publicKey;
  const needsSignIn = offchain && !!custody.wallet && !custody.signedIn;
  const depositCta = insufficient && side === "buy";
  const cta = !tradable
    ? "Trading opens at graduation"
    : needsWallet
      ? "Connect wallet"
      : needsSignIn
        ? custody.signingIn ? "Check your wallet…" : "Sign in to trade"
      : depositCta
        ? `Deposit ${quote.symbol} to buy`
      : insufficient
        ? `Insufficient ${launch.ticker} balance`
      : !(Number(amount) > 0)
        ? "Enter an amount"
        : convert && !jupQuote
          ? jupError ?? "Routing via Jupiter…"
          : side === "buy"
            ? `Buy ${launch.ticker}`
            : `Sell ${launch.ticker}`;

  return (
    <motion.div
      layout
      transition={spring}
      className="w-full rounded-card border border-rule bg-sheet p-5 text-ink shadow-card sm:p-6"
    >
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <p className="section-mark min-w-0">§ Trade — Swap</p>
        <span className="shrink-0 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
          {offchain ? "Internal ledger" : launch.isDemo ? "Demo · simulated fills" : isMainnet ? "Pool · Jupiter" : "Internal pool"}
        </span>
      </div>
      <div className="mb-4 flex items-center justify-between">
        <div className="relative grid w-full grid-cols-2 rounded-full border border-rule bg-paper p-1">
          {(["buy", "sell"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSide(s);
                setPhase("idle");
                setMessage(null);
              }}
              className={`relative z-10 rounded-full px-5 py-2 text-sm font-semibold capitalize transition-colors ${side === s ? "text-paper" : "text-ink-slate hover:text-ink"}`}
            >
              {side === s && (
                <motion.span
                  layoutId={`swap-side-pill-${launch.id}`}
                  transition={spring}
                  className="absolute inset-0 -z-10 rounded-full bg-ink"
                />
              )}
              {s}
            </button>
          ))}
        </div>
      </div>

      <label className="block rounded-field border border-rule bg-white p-4 transition focus-within:border-signal focus-within:shadow-focus">
        <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
          <span>
            You pay
            {showBal && (
              <button
                type="button"
                onClick={() => {
                  setAmount(String(Number(inBal.available.toFixed(side === "buy" ? quote.decimals : TOKEN_DECIMALS))));
                  if (phase !== "pending") setPhase("idle");
                }}
                className={`ml-2 normal-case tracking-normal underline decoration-rule-strong underline-offset-2 hover:text-ink ${insufficient ? "text-burn" : ""}`}
                aria-label={`Use full balance: ${fmt(inBal.available)} ${inSymbol}`}
              >
                bal {fmt(inBal.available, 4)}
              </button>
            )}
          </span>
          {side === "buy" && isMainnet && !launch.isDemo && !offchain ? (
            <select
              value={payWith}
              onChange={(e) => setPayWith(e.target.value as QuoteAssetSymbol)}
              className="rounded-full border border-rule bg-sheet px-2 py-0.5 font-mono text-[11px] text-ink"
            >
              {Object.values(QUOTE_ASSETS).filter((q) => q.jupiterRoutable).map((q) => (
                <option key={q.symbol} value={q.symbol}>{q.symbol}</option>
              ))}
            </select>
          ) : (
            <span>{inSymbol}</span>
          )}
        </div>
        <div className="flex items-baseline gap-2">
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => {
              const v = e.target.value.replace(",", ".");
              if (/^\d*\.?\d*$/.test(v)) {
                setAmount(v);
                if (phase !== "pending") setPhase("idle");
              }
            }}
            className="num w-full min-w-0 bg-transparent text-3xl text-ink outline-none placeholder:text-ink-muted"
            aria-label={`Amount in ${inSymbol}`}
          />
          <span className="shrink-0 font-mono text-sm text-ink-slate">{inSymbol}</span>
        </div>
      </label>

      <div className="mt-2 rounded-field border border-rule bg-paper-deep/60 p-4">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">You receive (est.)</div>
        <div className="flex items-baseline justify-between">
          <span className="num min-w-0 truncate text-2xl">{canQuote ? fmt(outUi) : "0.00"}</span>
          <span className="shrink-0 font-mono text-sm text-ink-slate">{outSymbol}</span>
        </div>
      </div>

      <dl className="mt-4 divide-y divide-rule border-y border-rule text-[12px]">
        <Row label="Price" value={`${fmt(priceUi, 9)} ${quote.symbol}`} />
        <Row label={`Pool fee (${POOL_FEE_BPS / 100}%)`} value={`${fmt(feeUi)} ${quote.symbol}`} />
        <Row
          label="Price impact"
          value={`${impactPct.toFixed(2)}%`}
          tone={impactPct >= 5 ? "warn" : impactPct >= 1 ? "muted" : "ok"}
        />
        <Row label={`Min received (${SLIPPAGE_BPS / 100}% slippage)`} value={`${fmt(minOutUi)} ${outSymbol}`} />
        {convert && jupQuote && (
          <Row label="Jupiter route" value={`${jupQuote.routePlan.map((r) => r.swapInfo.label ?? "AMM").join(" → ") || "direct"}`} />
        )}
      </dl>

      <AnimatePresence mode="wait" initial={false}>
        {phase === "confirm" ? (
          <motion.div key="confirm" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={spring} className="mt-5">
            <p className="mb-3 text-sm text-ink-slate">
              {side === "buy" ? "Buy" : "Sell"} <span className="num text-ink">{fmt(outUi)}</span> {outSymbol} for{" "}
              <span className="num text-ink">{amount}</span> {inSymbol}?{offchain ? " Settled on Sealed's internal ledger." : launch.isDemo ? " (simulated)" : ""}
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setPhase("idle")} className="h-11 flex-1 rounded-full border border-rule text-sm font-semibold text-ink transition hover:border-rule-strong">
                Back
              </button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.98 }}
                onClick={() => void execute()}
                className="h-11 flex-[2] rounded-full bg-ink text-sm font-semibold text-paper transition hover:-translate-y-px hover:bg-ink-soft"
              >
                Confirm
              </motion.button>
            </div>
          </motion.div>
        ) : (
          <motion.button
            key="cta"
            type="button"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={spring}
            whileTap={{ scale: 0.98 }}
            disabled={phase === "pending" || custody.signingIn || (tradable && !needsWallet && !needsSignIn && !depositCta && (!canQuote || insufficient))}
            onClick={() => {
              if (needsWallet) return setVisible(true);
              if (needsSignIn) return void custody.signIn().catch(() => undefined);
              if (depositCta) return openDeposit(launch.quoteAsset, Math.max(0, Number(amount) - inBal.available));
              if (canQuote) setPhase("confirm");
            }}
            className="mt-5 h-12 w-full rounded-full bg-ink text-sm font-semibold text-paper transition hover:-translate-y-px hover:bg-ink-soft disabled:translate-y-0 disabled:opacity-40"
          >
            {phase === "pending" ? "Submitting…" : cta}
          </motion.button>
        )}
      </AnimatePresence>

      {offchain && custody.error && needsSignIn && <p className="mt-2 text-[12px] text-burn">{custody.error}</p>}
      {depositCta && (
        <p className="mt-2 text-[12px] leading-relaxed text-ink-slate">
          Your internal balance is <span className="num text-ink">{fmt(inBal.available, 4)}</span> {quote.symbol}. Deposits are credited after on-chain confirmation.
        </p>
      )}

      <AnimatePresence>
        {message && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring}
            className={`mt-3 overflow-hidden rounded-field border px-4 py-3 text-[13px] ${phase === "error" ? "border-burn/20 bg-burn-tint text-burn" : "border-gain/20 bg-gain-tint text-gain"}`}
          >
            <div>{message}</div>
            {lastSig && phase === "filled" && (
              <div className="num mt-1 truncate text-xs opacity-80">
                {lastSig.startsWith("ledger:") ? `Receipt ${lastSig.slice(0, 27)}` : lastSig.startsWith("demo") ? lastSig.slice(0, 20) + "…" : (
                  <a
                    className="underline underline-offset-2"
                    target="_blank"
                    rel="noreferrer"
                    href={`https://solscan.io/tx/${lastSig}${isMainnet ? "" : `?cluster=${launch.network === "localnet" ? "custom" : "devnet"}`}`}
                  >
                    {lastSig.slice(0, 20)}…
                  </a>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "ok" | "muted" | "warn" }) {
  const c = tone === "warn" ? "text-burn" : tone === "ok" ? "text-gain" : "text-ink";
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="min-w-0 text-ink-slate">{label}</dt>
      <dd className={`num truncate text-right ${c}`}>{value}</dd>
    </div>
  );
}
