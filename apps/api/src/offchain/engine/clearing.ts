import { BPS_DENOMINATOR, NO_REVEAL_SLASH_BPS, computeClearing, settleBid, type ClearingResult, type WsEvent } from "@sealed/shared";
import { acct, fromAtoms, move, postIn, type Leg } from "../ledger.js";
import type { LaunchRow, RepoTx } from "../repo/types.js";
import { EngineError, invalidate, nowS, publish, type EngineDeps } from "./common.js";
import { graduateIn } from "./graduation.js";
import { quoteDecimals, toSummary } from "./launches.js";

export interface ClearOutcome {
  launch: LaunchRow;
  result: ClearingResult;
  spent: bigint;
  tokens: bigint;
  slashed: bigint;
  winners: number;
}

/**
 * Uniform-price clearing with the SHARED canonical algorithm (computeClearing + settleBid). Per-bid settlement
 * is exact: Σspent moves to the pool at graduation and escrow keeps exactly Σrefund for claims.
 * Unrevealed bids forfeit NO_REVEAL_SLASH_BPS of their deposit to treasury.
 */
export async function clearIn(d: EngineDeps, t: RepoTx, l: LaunchRow): Promise<ClearOutcome> {
  const bids = await t.listBids(l.id);
  const buckets: bigint[] = Array.from({ length: l.numTicks }, () => 0n);
  for (const b of bids) if (b.revealed && b.tick !== null && b.bidAmount !== null) buckets[b.tick]! += b.bidAmount;
  const result = computeClearing({ floorPrice: l.floorPrice, tickSize: l.tickSize, numTicks: l.numTicks, buckets, tokensForSale: l.tokensForSale, clearingCap: l.clearingCap });

  const D = BigInt(BPS_DENOMINATOR);
  const legs: Leg[] = [];
  let spent = 0n, tokens = 0n, slashed = 0n, winners = 0;
  for (const b of bids) {
    legs.push(...move(acct.bidEscrow(b.bidder, l.quoteAsset, l.id), acct.launch("auction_escrow", l.id, l.quoteAsset), b.deposit));
    let s: { spent: bigint; tokens: bigint; refund: bigint; slash: bigint };
    if (b.revealed && b.tick !== null && b.bidAmount !== null) {
      const r = settleBid(result, l.floorPrice, l.tickSize, b.tick, b.bidAmount, b.deposit);
      s = { spent: r.spent, tokens: r.tokens, refund: r.refund, slash: 0n };
      if (r.won) winners++;
    } else {
      const slash = (b.deposit * BigInt(NO_REVEAL_SLASH_BPS)) / D;
      s = { spent: 0n, tokens: 0n, refund: b.deposit - slash, slash };
    }
    spent += s.spent;
    tokens += s.tokens;
    slashed += s.slash;
    await t.updateBid(b.id, { settled: true, ...s });
  }
  if (tokens > l.tokensForSale) throw new EngineError(500, "clearing invariant violated: tokens sold > supply");
  if (spent > l.clearingCap) throw new EngineError(500, "clearing invariant violated: raise > cap");
  legs.push(...move(acct.launch("auction_escrow", l.id, l.quoteAsset), acct.system("treasury", l.quoteAsset), slashed));

  await postIn(t, {
    idempotencyKey: `clear:${l.id}`,
    kind: "clear",
    launchId: l.id,
    meta: { clearingPrice: result.clearingPrice.toString(), spent: spent.toString(), tokens: tokens.toString(), slashed: slashed.toString(), winners, rule: result.rule },
    legs,
    createdTs: nowS(d),
  });
  const patch: Partial<LaunchRow> = { clearingPrice: result.clearingPrice, totalRaised: spent, tokensSold: tokens, winners, status: spent > 0n ? "clearing" : "failed" };
  await t.updateLaunch(l.id, patch);
  return { launch: { ...l, ...patch }, result, spent, tokens, slashed, winners };
}

/** Scheduler step after the reveal window: clear, then graduate in the SAME serializable transaction. */
export async function clearAndGraduate(d: EngineDeps, launchId: string): Promise<LaunchRow | null> {
  const from = (await d.repo.read.getLaunch(launchId))?.status;
  const out = await d.repo.tx(async (t) => {
    const l = await t.getLaunch(launchId, true);
    if (!l || (l.status !== "reveal" && l.status !== "commit") || nowS(d) < l.revealEndTs) return null;
    const c = await clearIn(d, t, l);
    if (c.spent === 0n) return { c, g: null };
    const g = await graduateIn(d, t, c.launch);
    return { c, g };
  });
  if (!out) return null;
  await invalidate(d);
  const final = out.g?.launch ?? out.c.launch;
  const qd = quoteDecimals(final);
  const summary = await toSummary(d, final);
  const evts: WsEvent[] = [
    { type: "auction.phase_changed", data: { launchId: final.id, from: from ?? "reveal", to: final.status } },
    { type: "auction.cleared", data: { launchId: final.id, clearingPrice: fromAtoms(out.c.result.clearingPrice, qd), totalRaised: fromAtoms(out.c.spent, qd), winners: out.c.winners } },
  ];
  if (out.g) {
    if (out.g.credit > 0n) {
      evts.push({
        type: "credit.ledger",
        data: { id: `${out.g.txId}:advance`, launchId: final.id, ticker: final.ticker, kind: "advance", amount: fromAtoms(out.g.credit, qd), quoteAsset: summary.quoteAsset, signature: `offchain:${out.g.txId}`, ts: nowS(d), repaidPct: 0 },
      });
    } else evts.push({ type: "credit.flywheel_activated", data: { launchId: final.id, ts: nowS(d) } });
  }
  evts.push({ type: "launch.updated", data: summary });
  publish(d, evts);
  return final;
}
