import { splitFees, type WsEvent } from "@sealed/shared";
import { acct, move, postIn } from "../ledger.js";
import type { LaunchRow, TxRow } from "../repo/types.js";
import { REWARD_SCALE, invalidate, nowS, publish, type EngineDeps } from "./common.js";
import { creditEntriesFromTx, toSummary } from "./launches.js";

/**
 * Fee distribution (mirrors Rust distribute_fees) using the shared splitFees():
 *   repaying: 80% → credit_pool (until outstanding = 0), 20% → platform_ops; overflow → flywheel split
 *   flywheel: 50% holders (rewards:<launch>, reward-per-share over ELIGIBLE stake; → treasury if none staked),
 *             35% platform buyback-burn (platform_ops), 15% (+dust) treasury.
 * Flips live → flywheel once credit is fully repaid.
 */
export async function distributeFees(d: EngineDeps, launchId: string): Promise<{ launch: LaunchRow; tx: TxRow } | null> {
  const out = await d.repo.tx(async (t) => {
    const l = await t.getLaunch(launchId, true);
    if (!l || (l.status !== "live" && l.status !== "flywheel")) return null;
    const Q = l.quoteAsset;
    const fees = (await t.getAccount(acct.launch("fee_collector", l.id, Q)))?.balance ?? 0n;
    if (fees <= 0n) return null;
    const split = splitFees(fees, l.creditOutstanding);
    const toRewards = l.eligibleStaked > 0n ? split.holders : 0n;
    const toTreasury = split.treasury + (split.holders - toRewards);
    const toPlatform = split.platformOps + split.platformBuybackBurn;
    const fc = acct.launch("fee_collector", l.id, Q);
    const n = l.feeDistributions + 1;
    const r = await postIn(t, {
      idempotencyKey: `fees:${l.id}:${n}`,
      kind: "distribute",
      launchId: l.id,
      meta: {
        fees: fees.toString(),
        creditRepay: split.creditRepay.toString(),
        platformOps: split.platformOps.toString(),
        holders: toRewards.toString(),
        platformBuybackBurn: split.platformBuybackBurn.toString(),
        treasury: toTreasury.toString(),
        creditOutstandingAfter: split.creditOutstandingAfter.toString(),
      },
      legs: [
        ...move(fc, acct.system("credit_pool", Q), split.creditRepay),
        ...move(fc, acct.system("platform_ops", Q), toPlatform),
        ...move(fc, acct.launch("rewards", l.id, Q), toRewards),
        ...move(fc, acct.system("treasury", Q), toTreasury),
      ],
      createdTs: nowS(d),
    });
    const flip = split.creditOutstandingAfter === 0n && l.status === "live";
    const patch: Partial<LaunchRow> = {
      feeDistributions: n,
      creditOutstanding: split.creditOutstandingAfter,
      creditRepaid: l.creditRepaid + split.creditRepay,
      holderPayouts: l.holderPayouts + toRewards,
      platformBurn: l.platformBurn + toPlatform,
      treasuryTotal: l.treasuryTotal + toTreasury,
      rewardPerShare: toRewards > 0n ? l.rewardPerShare + (toRewards * REWARD_SCALE) / l.eligibleStaked : l.rewardPerShare,
      ...(flip ? { status: "flywheel" as const } : {}),
    };
    await t.updateLaunch(l.id, patch);
    return { launch: { ...l, ...patch }, tx: r.tx, flip };
  });
  if (!out) return null;
  await invalidate(d);
  const l = out.launch;
  const repaidPct = l.creditLine > 0n ? Number((l.creditRepaid * 10_000n) / l.creditLine) / 100 : 100;
  const evts: WsEvent[] = creditEntriesFromTx(l, out.tx).map((e) => ({ type: "credit.ledger" as const, data: { ...e, repaidPct } }));
  if (out.flip) evts.push({ type: "auction.phase_changed", data: { launchId: l.id, from: "live", to: "flywheel" } }, { type: "credit.flywheel_activated", data: { launchId: l.id, ts: nowS(d) } });
  evts.push({ type: "launch.updated", data: await toSummary(d, l) });
  publish(d, evts);
  return { launch: l, tx: out.tx };
}
