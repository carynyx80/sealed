import type { HolderReward, QuoteAssetSymbol } from "@sealed/shared";
import { acct, fromAtoms, move, postIn, toAtoms, tokenAsset } from "../ledger.js";
import type { LaunchRow, PositionRow, RepoTx } from "../repo/types.js";
import { EngineError, REWARD_SCALE, invalidate, nowS, type EngineDeps } from "./common.js";
import { quoteDecimals } from "./launches.js";

/**
 * Holder rewards: reward-per-share accumulator (mirrors Rust staking.rs). Only ELIGIBLE staked tokens count
 * toward `eligibleStaked`; anti-snipe wallets accrue nothing and cannot claim.
 */
export function pendingOf(p: PositionRow, rps: bigint): bigint {
  if (!p.eligible) return 0n;
  const acc = (p.staked * rps) / REWARD_SCALE;
  return acc > p.rewardDebt ? acc - p.rewardDebt : 0n;
}

export function settle(p: PositionRow, rps: bigint): PositionRow {
  const unclaimed = p.unclaimed + pendingOf(p, rps);
  return { ...p, unclaimed, rewardDebt: (p.staked * rps) / REWARD_SCALE };
}

const blank = (launchId: string, wallet: string, eligible: boolean): PositionRow => ({ launchId, wallet, staked: 0n, rewardDebt: 0n, unclaimed: 0n, claimed: 0n, eligible });

/** Called when a wallet lands in the anti-snipe registry: forfeit accrued, exclude its stake. */
export async function markIneligible(t: RepoTx, l: LaunchRow, wallet: string): Promise<LaunchRow> {
  const p = await t.getPosition(l.id, wallet);
  if (!p || !p.eligible) return l;
  await t.upsertPosition({ ...p, eligible: false, unclaimed: 0n, rewardDebt: (p.staked * l.rewardPerShare) / REWARD_SCALE });
  const eligibleStaked = l.eligibleStaked - p.staked;
  await t.updateLaunch(l.id, { eligibleStaked });
  return { ...l, eligibleStaked };
}

/** amount > 0 stakes, < 0 unstakes (whole-token UI units). */
export async function stake(d: EngineDeps, wallet: string, launchId: string, amount: number, idemKey: string): Promise<{ staked: number; eligible: boolean }> {
  if (!Number.isFinite(amount) || amount === 0) throw new EngineError(400, "amount must be non-zero");
  const atoms = toAtoms(Math.abs(amount), 6);
  if (atoms <= 0n) throw new EngineError(400, "amount too small");
  const key = `stake:${launchId}:${wallet}:${idemKey}`;
  const out = await d.repo.tx(async (t) => {
    let l = await t.getLaunch(launchId, true);
    if (!l) throw new EngineError(404, "launch not found");
    if (await t.findTx(key)) {
      const p = (await t.getPosition(l.id, wallet)) ?? blank(l.id, wallet, true);
      return { p };
    }
    if (l.status !== "live" && l.status !== "flywheel") throw new EngineError(409, "launch not live");
    const sniper = await t.isSniper(l.id, wallet);
    if (sniper) l = await markIneligible(t, l, wallet);
    let p = settle((await t.getPosition(l.id, wallet)) ?? blank(l.id, wallet, !sniper), l.rewardPerShare);
    const tok = tokenAsset(l.id);
    let delta: bigint;
    if (amount > 0) {
      await postIn(t, { idempotencyKey: key, kind: "stake", launchId: l.id, meta: { wallet, amount: atoms.toString() }, legs: move(acct.available(wallet, tok), acct.staked(wallet, l.id), atoms), createdTs: nowS(d) });
      delta = atoms;
    } else {
      if (p.staked < atoms) throw new EngineError(409, "unstake exceeds staked balance");
      await postIn(t, { idempotencyKey: key, kind: "unstake", launchId: l.id, meta: { wallet, amount: atoms.toString() }, legs: move(acct.staked(wallet, l.id), acct.available(wallet, tok), atoms), createdTs: nowS(d) });
      delta = -atoms;
    }
    p = { ...p, staked: p.staked + delta };
    p.rewardDebt = (p.staked * l.rewardPerShare) / REWARD_SCALE;
    await t.upsertPosition(p);
    if (p.eligible) await t.updateLaunch(l.id, { eligibleStaked: l.eligibleStaked + delta });
    return { p };
  });
  await invalidate(d);
  return { staked: fromAtoms(out.p.staked, 6), eligible: out.p.eligible };
}

export async function claimRewards(d: EngineDeps, wallet: string, launchId: string): Promise<{ amount: number }> {
  const out = await d.repo.tx(async (t) => {
    const l = await t.getLaunch(launchId, true);
    if (!l) throw new EngineError(404, "launch not found");
    if (await t.isSniper(l.id, wallet)) throw new EngineError(403, "wallet is in the anti-snipe registry: 0% holder rewards");
    const cur = await t.getPosition(l.id, wallet);
    if (!cur) return { l, amount: 0n };
    const p = settle(cur, l.rewardPerShare);
    const vault = (await t.getAccount(acct.launch("rewards", l.id, l.quoteAsset)))?.balance ?? 0n;
    const amount = p.unclaimed < vault ? p.unclaimed : vault;
    if (amount > 0n) {
      const claimed = p.claimed + amount;
      await postIn(t, {
        idempotencyKey: `rewards:${l.id}:${wallet}:${claimed}`,
        kind: "rewards_claim",
        launchId: l.id,
        meta: { wallet, amount: amount.toString() },
        legs: move(acct.launch("rewards", l.id, l.quoteAsset), acct.available(wallet, l.quoteAsset), amount),
        createdTs: nowS(d),
      });
      await t.upsertPosition({ ...p, unclaimed: p.unclaimed - amount, claimed });
    } else await t.upsertPosition(p);
    return { l, amount };
  });
  return { amount: fromAtoms(out.amount, quoteDecimals(out.l)) };
}

export async function holderReward(d: EngineDeps, l: LaunchRow, wallet: string): Promise<HolderReward> {
  const r = d.repo.read;
  const sniper = await r.isSniper(l.id, wallet);
  const p = await r.getPosition(l.id, wallet);
  const qd = quoteDecimals(l);
  const claimable = p && !sniper ? p.unclaimed + pendingOf(p, l.rewardPerShare) : 0n;
  return {
    launchId: l.id,
    wallet,
    staked: p ? fromAtoms(p.staked, 6) : 0,
    claimable: fromAtoms(claimable, qd),
    claimed: p ? fromAtoms(p.claimed, qd) : 0,
    quoteAsset: l.quoteAsset as QuoteAssetSymbol,
    eligible: !sniper,
  };
}
