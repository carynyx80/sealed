import { computeCreditLine } from "@sealed/shared";
import { acct, move, postIn, tokenAsset } from "../ledger.js";
import type { LaunchRow, RepoTx } from "../repo/types.js";
import { EngineError, nowS, type EngineDeps } from "./common.js";

/**
 * Graduation (mirrors Rust graduate.rs), one balanced ledger tx:
 *   auction_escrow → pool_quote            Σspent (exact)
 *   token_issuance → pool_token            poolTokenAllocation + unsold auction supply
 *   token_issuance → auction_tokens        Σtokens won (claimable)
 *   token_issuance → creator available     creatorAllocation (≤ 2%)
 *   credit_pool    → buyback_vault         computeCreditLine(raise, tier bps, pool balance, per-launch max)
 * Total issued == totalSupply. The buyback vault has no withdrawal path: only drips (vault → pool → burned).
 */
export async function graduateIn(d: EngineDeps, t: RepoTx, l: LaunchRow): Promise<{ launch: LaunchRow; credit: bigint; txId: string }> {
  if (l.status !== "clearing" || l.totalRaised === null || l.tokensSold === null) throw new EngineError(409, "auction not cleared");
  const tok = tokenAsset(l.id);
  const seedQuote = l.totalRaised;
  const seedTokens = l.poolTokenAllocation + (l.tokensForSale - l.tokensSold);
  if (seedQuote <= 0n || seedTokens <= 0n) throw new EngineError(409, "nothing to seed");
  const poolBal = (await t.getAccount(acct.system("credit_pool", l.quoteAsset)))?.balance ?? 0n;
  const credit = computeCreditLine(l.totalRaised, l.creditBps, poolBal, d.maxCreditPerLaunch);
  const issuance = acct.issuance(l.id);

  const res = await postIn(t, {
    idempotencyKey: `graduate:${l.id}`,
    kind: "graduate",
    launchId: l.id,
    meta: { seedQuote: seedQuote.toString(), seedTokens: seedTokens.toString(), credit: credit.toString(), creator: l.creator },
    legs: [
      ...move(acct.launch("auction_escrow", l.id, l.quoteAsset), acct.launch("pool_quote", l.id, l.quoteAsset), seedQuote),
      ...move(issuance, acct.launch("pool_token", l.id, tok), seedTokens),
      ...move(issuance, acct.launch("auction_tokens", l.id, tok), l.tokensSold),
      ...move(issuance, acct.available(l.creator, tok), l.creatorAllocation),
      ...move(acct.system("credit_pool", l.quoteAsset), acct.launch("buyback_vault", l.id, l.quoteAsset), credit),
    ],
    createdTs: nowS(d),
  });
  const now = nowS(d);
  const patch: Partial<LaunchRow> = {
    status: credit > 0n ? "live" : "flywheel",
    graduatedAtMs: d.nowMs(),
    creditLine: credit,
    creditOutstanding: credit,
    vaultInitial: credit,
    nextDripTs: credit > 0n ? now + l.dripIntervalSec : 0,
  };
  await t.updateLaunch(l.id, patch);
  return { launch: { ...l, ...patch }, credit, txId: res.txId };
}
