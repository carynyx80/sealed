import { ANTI_SNIPE_WINDOW_SEC, BPS_DENOMINATOR, POOL_FEE_BPS, cpmmOut, type OffchainSwapResponse } from "@sealed/shared";
import { acct, fromAtoms, move, postIn, toAtoms, tokenAsset } from "../ledger.js";
import type { LaunchRow, TxRow } from "../repo/types.js";
import { EngineError, invalidate, nowS, publish, type EngineDeps } from "./common.js";
import { poolReserves, quoteDecimals, spotPriceUi, toSummary, tradeFromTx } from "./launches.js";
import { markIneligible } from "./rewards.js";

export interface SwapInput {
  launchId: string;
  side: "buy" | "sell";
  amountIn: number;
  minAmountOut: number;
}

const poolFee = (x: bigint) => (x * BigInt(POOL_FEE_BPS)) / BigInt(BPS_DENOMINATOR);

function responseFromTx(l: LaunchRow, tx: TxRow): OffchainSwapResponse {
  const qd = quoteDecimals(l);
  const m = tx.meta;
  const buy = m.side === "buy";
  const amountIn = buy ? fromAtoms(BigInt(String(m.amountQuote)), qd) : fromAtoms(BigInt(String(m.amountToken)), 6);
  const amountOut = buy ? fromAtoms(BigInt(String(m.amountToken)), 6) : fromAtoms(BigInt(String(m.amountQuote)), qd);
  return { tradeId: tx.id, amountIn, amountOut, fee: fromAtoms(BigInt(String(m.fee)), qd), price: Number(m.price), isSniper: m.isSniper === true };
}

/**
 * Internal CPMM swap (mirrors Rust trading.rs). 1% fee to fee_collector:<launch> (buy: on quote in; sell: on
 * gross quote out). Buys within ANTI_SNIPE_WINDOW_SEC of graduation land the wallet in the anti-snipe registry.
 * The launch row is locked FOR UPDATE so reserves cannot change between quote and execution.
 */
export async function swap(d: EngineDeps, wallet: string, input: SwapInput, idemKey: string): Promise<OffchainSwapResponse> {
  const key = `swap:${wallet}:${idemKey}`;
  const out = await d.repo.tx(async (t) => {
    let l = await t.getLaunch(input.launchId, true);
    if (!l) throw new EngineError(404, "launch not found");
    const prior = await t.findTx(key);
    if (prior) return { l, tx: prior, replay: true };
    if (l.status !== "live" && l.status !== "flywheel") throw new EngineError(409, "pool not live", { status: l.status });
    const qd = quoteDecimals(l);
    const tok = tokenAsset(l.id);
    const Q = l.quoteAsset;
    const res = await poolReserves(d, l, t);
    const priceBefore = spotPriceUi(l, res.quote, res.token);
    const nowMs = d.nowMs();
    const isSniper = input.side === "buy" && l.graduatedAtMs !== null && nowMs - l.graduatedAtMs < ANTI_SNIPE_WINDOW_SEC * 1000;

    let amountQuote: bigint, amountToken: bigint, fee: bigint;
    let legs;
    if (input.side === "buy") {
      const inAtoms = toAtoms(input.amountIn, qd);
      fee = poolFee(inAtoms);
      const net = inAtoms - fee;
      const outTok = cpmmOut(net, res.quote, res.token);
      if (outTok <= 0n || outTok >= res.token) throw new EngineError(400, "amount too small or exceeds pool liquidity");
      if (outTok < toAtoms(input.minAmountOut, 6)) throw new EngineError(409, "slippage: output below minAmountOut", { amountOut: fromAtoms(outTok, 6) });
      amountQuote = inAtoms;
      amountToken = outTok;
      legs = [
        ...move(acct.available(wallet, Q), acct.launch("fee_collector", l.id, Q), fee),
        ...move(acct.available(wallet, Q), acct.launch("pool_quote", l.id, Q), net),
        ...move(acct.launch("pool_token", l.id, tok), acct.available(wallet, tok), outTok),
      ];
    } else {
      const inAtoms = toAtoms(input.amountIn, 6);
      const gross = cpmmOut(inAtoms, res.token, res.quote);
      if (gross <= 0n || gross >= res.quote) throw new EngineError(400, "amount too small or exceeds pool liquidity");
      fee = poolFee(gross);
      const net = gross - fee;
      if (net < toAtoms(input.minAmountOut, qd)) throw new EngineError(409, "slippage: output below minAmountOut", { amountOut: fromAtoms(net, qd) });
      amountQuote = net;
      amountToken = inAtoms;
      legs = [
        ...move(acct.available(wallet, tok), acct.launch("pool_token", l.id, tok), inAtoms),
        ...move(acct.launch("pool_quote", l.id, Q), acct.available(wallet, Q), net),
        ...move(acct.launch("pool_quote", l.id, Q), acct.launch("fee_collector", l.id, Q), fee),
      ];
    }
    const price = fromAtoms(amountToken, 6) > 0 ? fromAtoms(amountQuote, qd) / fromAtoms(amountToken, 6) : 0;
    const r = await postIn(t, {
      idempotencyKey: key,
      kind: "swap",
      launchId: l.id,
      meta: { wallet, side: input.side, amountQuote: amountQuote.toString(), amountToken: amountToken.toString(), fee: fee.toString(), price, priceBefore, isSniper },
      legs,
      createdTs: nowS(d),
    });
    await t.updateLaunch(l.id, { feesCollected: l.feesCollected + fee, volumeQuote: l.volumeQuote + amountQuote });
    l = { ...l, feesCollected: l.feesCollected + fee, volumeQuote: l.volumeQuote + amountQuote };
    if (isSniper && !(await t.isSniper(l.id, wallet))) {
      await t.addSniper({ launchId: l.id, wallet, ts: nowS(d), txId: r.txId });
      l = await markIneligible(t, l, wallet);
    }
    return { l, tx: r.tx, replay: false };
  });
  if (!out.replay) {
    await invalidate(d);
    publish(d, [
      { type: "trade", data: tradeFromTx(out.l, out.tx) },
      { type: "launch.updated", data: await toSummary(d, out.l) },
    ]);
  }
  return responseFromTx(out.l, out.tx);
}
