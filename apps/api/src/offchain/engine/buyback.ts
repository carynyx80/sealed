import { cpmmOut, dripAmount } from "@sealed/shared";
import { acct, fromAtoms, move, postIn, tokenAsset } from "../ledger.js";
import type { LaunchRow, TxRow } from "../repo/types.js";
import { invalidate, nowS, publish, type EngineDeps } from "./common.js";
import { buybackFromTx, poolReserves, quoteDecimals, toSummary, tradeFromTx } from "./launches.js";

/**
 * Buyback drip (mirrors Rust execute_buyback_drip): buyback_vault → pool_quote (fee-free buy), tokens out of the
 * pool reserve → `burned` (permanently out of circulation). Equal slices via shared dripAmount().
 */
export async function executeDrip(d: EngineDeps, launchId: string): Promise<{ launch: LaunchRow; tx: TxRow } | null> {
  const out = await d.repo.tx(async (t) => {
    const l = await t.getLaunch(launchId, true);
    if (!l || (l.status !== "live" && l.status !== "flywheel")) return null;
    const now = nowS(d);
    if (l.dripsExecuted >= l.dripCount || l.nextDripTs <= 0 || now < l.nextDripTs) return null;
    const vaultBal = (await t.getAccount(acct.launch("buyback_vault", l.id, l.quoteAsset)))?.balance ?? 0n;
    const amount = dripAmount(l.vaultInitial, l.dripCount, l.dripsExecuted, vaultBal);
    if (amount <= 0n) {
      await t.updateLaunch(l.id, { nextDripTs: 0 });
      return null;
    }
    const res = await poolReserves(d, l, t);
    const burn = cpmmOut(amount, res.quote, res.token);
    if (burn >= res.token) return null;
    const tok = tokenAsset(l.id);
    const dripIndex = l.dripsExecuted + 1;
    const r = await postIn(t, {
      idempotencyKey: `drip:${l.id}:${dripIndex}`,
      kind: "drip",
      launchId: l.id,
      meta: { quoteSpent: amount.toString(), tokensBurned: burn.toString(), dripIndex },
      legs: [...move(acct.launch("buyback_vault", l.id, l.quoteAsset), acct.launch("pool_quote", l.id, l.quoteAsset), amount), ...move(acct.launch("pool_token", l.id, tok), acct.system("burned", tok), burn)],
      createdTs: now,
    });
    const last = dripIndex >= l.dripCount || amount === vaultBal;
    const patch: Partial<LaunchRow> = {
      dripsExecuted: dripIndex,
      nextDripTs: last ? 0 : now + l.dripIntervalSec,
      tokensBurned: l.tokensBurned + burn,
      vaultQuoteSpent: l.vaultQuoteSpent + amount,
    };
    await t.updateLaunch(l.id, patch);
    return { launch: { ...l, ...patch }, tx: r.tx, vaultAfter: vaultBal - amount };
  });
  if (!out) return null;
  await invalidate(d);
  const ev = buybackFromTx(out.launch, out.tx);
  publish(d, [
    { type: "vault.drip", data: { ...ev, nextDripTs: out.launch.nextDripTs, vaultBalance: fromAtoms(out.vaultAfter, quoteDecimals(out.launch)) } },
    { type: "trade", data: tradeFromTx(out.launch, out.tx) },
    { type: "launch.updated", data: await toSummary(d, out.launch) },
  ]);
  return { launch: out.launch, tx: out.tx };
}
