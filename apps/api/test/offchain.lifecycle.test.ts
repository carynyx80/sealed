import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import {
  NUM_PRICE_TICKS,
  computeClearing,
  computeCommitment,
  randomSalt,
  revealSignMessage,
  sealReveal,
  settleBid,
  tickIndex,
  toHex,
  type HolderReward,
  type LaunchListResponse,
  type LaunchSummary,
  type OffchainSwapResponse,
  type TradesResponse,
  type VaultResponse,
} from "@sealed/shared";
import type { App } from "../src/server.js";
import { acct, tokenAsset } from "../src/offchain/ledger.js";
import { makeApp, validLaunch } from "./helpers.js";
import { bearer, installDevAuth } from "./offchain.helpers.js";

const U = 1_000_000n; // USDC atoms
const usdc = (n: number) => BigInt(Math.round(n * 1e6));
const pk = () => Keypair.generate();

let app: App;
let clock = Date.now();
before(async () => {
  app = await makeApp();
  installDevAuth(app);
  app.ctx.offchain!.engine.deps.nowMs = () => clock;
});
after(async () => {
  await app.close();
});

async function post<T>(url: string, wallet: string | null, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "POST", url, payload: (payload ?? {}) as object, headers: { ...(wallet ? bearer(wallet) : {}), ...headers } });
  return { status: res.statusCode, body: res.json() as T & { error?: string } };
}
const get = async <T>(url: string) => {
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as T;
};

describe("offchain custodial lifecycle (API, x-dev auth)", () => {
  const creator = pk(), A = pk(), B = pk(), C = pk(), D = pk(), E = pk(), S = pk(), H = pk(), W = pk();
  const w = (k: Keypair) => k.publicKey.toBase58();
  const FLOOR = 10_000n, TICK = 1_000n; // 0.01 / 0.001 USDC per token
  const bids = [
    { who: A, maxPrice: 20_000n, bidAmount: 3_000n * U, deposit: 3_000 },
    { who: B, maxPrice: 15_000n, bidAmount: 2_000n * U, deposit: 2_500 },
    { who: C, maxPrice: 10_000n, bidAmount: 2_000n * U, deposit: 2_000 },
    { who: D, maxPrice: 12_000n, bidAmount: 900n * U, deposit: 1_000, noReveal: true },
    { who: E, maxPrice: 12_000n, bidAmount: 500n * U, deposit: 600, auto: true },
  ].map((b) => ({ ...b, salt: randomSalt() }));
  let launch: LaunchSummary;
  let gradClock = 0;

  it("funds users via ledger credit and seeds the credit pool", async () => {
    const ledger = app.ctx.offchain!.ledger;
    for (const k of [A, B, C, D, E]) await ledger.credit(w(k), "USDC", 5_000n * U, `dep:${w(k)}`);
    for (const k of [S, H]) await ledger.credit(w(k), "USDC", 2_000n * U, `dep:${w(k)}`);
    await ledger.credit(w(W), "USDC", 1_000_000n * U, `dep:${w(W)}`);
    await ledger.creditSystem("credit_pool", "USDC", 100_000n * U, "seed:credit_pool");
    const replay = await ledger.credit(w(A), "USDC", 5_000n * U, `dep:${w(A)}`);
    assert.equal(replay.replayed, true);
    assert.equal(await ledger.balanceOf(w(A), "USDC", "user_available"), 5_000n * U);
  });

  it("POST /api/launches (offchain) creates a real launch for the signed-in creator; enforces ≤2%", async () => {
    const bad = await post("/api/launches", w(creator), { ...validLaunch, creatorAllocationBps: 250 });
    assert.equal(bad.status, 400);
    const res = await post<LaunchSummary>("/api/launches", w(creator), {
      ...validLaunch, ticker: "OFFC", name: "Offchain Coin", totalSupply: 1_000_000, auctionSupplyBps: 4000, creatorAllocationBps: 200,
      commitDurationSec: 120, revealDurationSec: 120, floorPrice: 0.01, tickSize: 0.001, targetRaise: 4_000, clearingCap: 6_000, creator: w(pk()),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    launch = res.body;
    assert.equal(launch.isDemo, false);
    assert.equal(launch.status, "commit");
    assert.equal(launch.creator, w(creator)); // body.creator ignored
    assert.equal(launch.auction.tokensForSale, 400_000);
    const listed = await get<LaunchListResponse>("/api/launches?status=auctions&limit=200");
    assert.ok(listed.launches.some((l) => l.id === launch.id && !l.isDemo));
    assert.ok(listed.launches.some((l) => l.isDemo), "demo world still merged in DEMO_MODE");
  });

  it("rejects unauthenticated trading", async () => {
    const r = await post("/api/trade/swap", null, { launchId: launch.id, side: "buy", amountIn: 1, minAmountOut: 0 });
    assert.equal(r.status, 401);
  });

  it("commits sealed bids (deposits locked, nothing leaked)", async () => {
    const relayerPub = app.ctx.relayer.boxPubkeyB64;
    for (const b of bids) {
      const commitment = toHex(computeCommitment({ bidder: w(b.who), maxPrice: b.maxPrice, bidAmount: b.bidAmount, salt: b.salt }));
      let sealedReveal: unknown;
      if (b.auto) {
        const signature = nacl.sign.detached(revealSignMessage(launch.id, commitment), b.who.secretKey);
        sealedReveal = sealReveal({ launchId: launch.id, bidder: w(b.who), commitmentHex: commitment, relayerPubkeyB64: relayerPub, plaintext: { maxPrice: b.maxPrice.toString(), bidAmount: b.bidAmount.toString(), salt: toHex(b.salt) }, signature });
      }
      const r = await post<{ bidId: string; bidCount: number }>("/api/trade/commit", w(b.who), { launchId: launch.id, commitment, deposit: b.deposit, sealedReveal });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await app.ctx.offchain!.ledger.balanceOf(w(b.who), "USDC", `bid_escrow:${launch.id}`), usdc(b.deposit));
    }
    const dup = await post("/api/trade/commit", w(A), { launchId: launch.id, commitment: "ab".repeat(32), deposit: 1 });
    assert.equal(dup.status, 409);
    const broke = await post("/api/trade/commit", w(pk()), { launchId: launch.id, commitment: "cd".repeat(32), deposit: 1 });
    assert.equal(broke.status, 409); // INSUFFICIENT_FUNDS
    const res = await app.inject({ method: "GET", url: `/api/auctions/${launch.id}` });
    const a = res.json().launch as LaunchSummary;
    assert.equal(a.auction.bidCount, 5);
    assert.equal(a.auction.totalEscrowed, 9_100);
    assert.ok(!res.body.includes("maxPrice") && !res.body.includes("bidAmount"));
    assert.equal(a.auction.clearingPrice, null);
  });

  it("commit → reveal (auto-reveal from sealed envelope) → manual reveals", async () => {
    const engine = app.ctx.offchain!.engine;
    clock += 121_000;
    await engine.tick();
    let l = await get<LaunchSummary>(`/api/launches/${launch.id}`);
    assert.equal(l.status, "reveal");
    assert.equal(l.auction.revealedCount, 1); // E auto-revealed by the relayer
    const bad = await post("/api/trade/reveal", w(A), { launchId: launch.id, maxPrice: "20000", bidAmount: (3_000n * U).toString(), salt: "00".repeat(32) });
    assert.equal(bad.status, 400);
    for (const b of bids.filter((x) => !x.noReveal && !x.auto)) {
      const r = await post("/api/trade/reveal", w(b.who), { launchId: launch.id, maxPrice: b.maxPrice.toString(), bidAmount: b.bidAmount.toString(), salt: toHex(b.salt) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    l = await get<LaunchSummary>(`/api/launches/${launch.id}`);
    assert.equal(l.auction.revealedCount, 4);
  });

  it("clears at the shared uniform price, graduates with a credit line, refunds are exact", async () => {
    const engine = app.ctx.offchain!.engine;
    const ledger = app.ctx.offchain!.ledger;
    clock += 121_000;
    gradClock = clock;
    await engine.tick();
    const l = await get<LaunchSummary>(`/api/launches/${launch.id}`);
    assert.equal(l.status, "live");

    const buckets = Array.from({ length: NUM_PRICE_TICKS }, () => 0n);
    for (const b of bids.filter((x) => !x.noReveal)) buckets[tickIndex(FLOOR, TICK, b.maxPrice, NUM_PRICE_TICKS)]! += b.bidAmount;
    const r = computeClearing({ floorPrice: FLOOR, tickSize: TICK, numTicks: NUM_PRICE_TICKS, buckets, tokensForSale: 400_000n * U, clearingCap: 6_000n * U });
    assert.equal(l.auction.clearingPrice, Number(r.clearingPrice) / 1e6);

    let raised = 0n;
    for (const b of bids) {
      const before = await ledger.balanceOf(w(b.who), "USDC", "user_available");
      const res = await post<{ tokens: number; refund: number }>(`/api/trade/claim/${launch.id}`, w(b.who));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const dep = usdc(b.deposit);
      const s = b.noReveal ? { spent: 0n, tokens: 0n, refund: dep - dep / 100n } : settleBid(r, FLOOR, TICK, tickIndex(FLOOR, TICK, b.maxPrice, NUM_PRICE_TICKS), b.bidAmount, dep);
      raised += s.spent;
      assert.equal((await ledger.balanceOf(w(b.who), "USDC", "user_available")) - before, s.refund, "exact refund");
      assert.equal(await ledger.balanceOf(w(b.who), tokenAsset(launch.id), "user_available"), s.tokens);
      // claim is idempotent
      const again = await post<{ tokens: number; refund: number }>(`/api/trade/claim/${launch.id}`, w(b.who));
      assert.equal(again.status, 200);
      assert.equal(await ledger.balanceOf(w(b.who), "USDC", "user_available") - before, s.refund);
    }
    assert.equal(usdc(l.auction.totalRaised!), raised);
    assert.equal(await ledger.balanceOf("system", "USDC", acct.launch("pool_quote", launch.id, "USDC").kind), raised);
    assert.equal(await ledger.balanceOf("system", "USDC", acct.launch("auction_escrow", launch.id, "USDC").kind), 0n, "escrow fully paid out");
    const credit = (raised * 1_000n) / 10_000n; // standard tier 10%
    assert.equal(usdc(l.vault!.creditLine), credit);
    assert.equal(await ledger.balanceOf("system", "USDC", `buyback_vault:${launch.id}`), credit);
    assert.equal(await ledger.balanceOf("system", "USDC", "credit_pool"), 100_000n * U - credit);
    assert.equal(await ledger.balanceOf(w(creator), tokenAsset(launch.id), "user_available"), 20_000n * U); // 2% of 1M
  });

  let sniperSwap: OffchainSwapResponse;
  it("swaps charge 1% to the fee collector; a buy inside the anti-snipe window is flagged", async () => {
    clock = gradClock + 500;
    const s = await post<OffchainSwapResponse>("/api/trade/swap", w(S), { launchId: launch.id, side: "buy", amountIn: 100, minAmountOut: 0 });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.isSniper, true);
    sniperSwap = s.body;
    clock = gradClock + 5_000;
    const h = await post<OffchainSwapResponse>("/api/trade/swap", w(H), { launchId: launch.id, side: "buy", amountIn: 200, minAmountOut: 1 }, { "idempotency-key": "h-buy-00001" });
    assert.equal(h.body.isSniper, false);
    assert.equal(h.body.fee, 2);
    const replay = await post<OffchainSwapResponse>("/api/trade/swap", w(H), { launchId: launch.id, side: "buy", amountIn: 200, minAmountOut: 1 }, { "idempotency-key": "h-buy-00001" });
    assert.equal(replay.body.tradeId, h.body.tradeId);
    assert.equal(await app.ctx.offchain!.ledger.balanceOf(w(H), "USDC", "user_available"), 1_800n * U, "replay did not double-spend");
    const slip = await post("/api/trade/swap", w(H), { launchId: launch.id, side: "buy", amountIn: 1, minAmountOut: 1e9 });
    assert.equal(slip.status, 409);
    assert.equal(await app.ctx.offchain!.ledger.balanceOf("system", "USDC", `fee_collector:${launch.id}`), 3n * U);
    const trades = await get<TradesResponse>(`/api/launches/${launch.id}/trades`);
    assert.ok(trades.trades.some((t) => t.isSniper && t.wallet === w(S)));
  });

  it("holders stake (sniper stake is ineligible)", async () => {
    const st = await post<{ staked: number; eligible: boolean }>("/api/trade/stake", w(H), { launchId: launch.id, amount: sniperSwap.amountOut });
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal(st.body.eligible, true);
    const ss = await post<{ staked: number; eligible: boolean }>("/api/trade/stake", w(S), { launchId: launch.id, amount: sniperSwap.amountOut / 2 });
    assert.equal(ss.body.eligible, false);
  });

  it("buyback drip buys from the pool and burns tokens", async () => {
    const engine = app.ctx.offchain!.engine;
    const ledger = app.ctx.offchain!.ledger;
    const vaultBefore = await ledger.balanceOf("system", "USDC", `buyback_vault:${launch.id}`);
    clock = gradClock + 181_000;
    await engine.tick();
    const burned = await ledger.balanceOf("system", tokenAsset(launch.id), "burned");
    assert.ok(burned > 0n);
    const vaultAfter = await ledger.balanceOf("system", "USDC", `buyback_vault:${launch.id}`);
    assert.equal(vaultBefore - vaultAfter, vaultBefore / 48n);
    const v = await get<VaultResponse>(`/api/vaults/${launch.mint}`);
    assert.equal(v.recentBuybacks.length, 1);
    assert.equal(v.launch.vault!.dripsExecuted, 1);
    assert.ok(v.launch.vault!.tokensBurned > 0);
  });

  it("fee distribution repays the credit line, then flips to the flywheel", async () => {
    const engine = app.ctx.offchain!.engine;
    let l = await get<LaunchSummary>(`/api/launches/${launch.id}`);
    assert.ok(l.credit!.repaid > 0, "first distribution (in tick) repaid 80% of fees");
    for (let i = 0; i < 30 && l.status === "live"; i++) {
      const buy = await post<OffchainSwapResponse>("/api/trade/swap", w(W), { launchId: launch.id, side: "buy", amountIn: 20_000, minAmountOut: 0 });
      assert.equal(buy.status, 200, JSON.stringify(buy.body));
      await post("/api/trade/swap", w(W), { launchId: launch.id, side: "sell", amountIn: buy.body.amountOut, minAmountOut: 0 });
      await engine.distributeFees(launch.id);
      l = await get<LaunchSummary>(`/api/launches/${launch.id}`);
    }
    assert.equal(l.status, "flywheel");
    assert.equal(l.credit!.phase, "flywheel");
    assert.equal(l.credit!.repaid, l.credit!.creditLine);
    assert.equal(await app.ctx.offchain!.ledger.balanceOf("system", "USDC", "credit_pool"), 100_000n * U, "credit pool made whole");
  });

  it("flywheel fees accrue holder rewards; the sniper gets 0", async () => {
    const engine = app.ctx.offchain!.engine;
    const buy = await post<OffchainSwapResponse>("/api/trade/swap", w(W), { launchId: launch.id, side: "buy", amountIn: 10_000, minAmountOut: 0 });
    await post("/api/trade/swap", w(W), { launchId: launch.id, side: "sell", amountIn: buy.body.amountOut, minAmountOut: 0 });
    await engine.distributeFees(launch.id);
    const hr = await get<HolderReward>(`/api/rewards/${launch.mint}/${w(H)}`);
    assert.equal(hr.eligible, true);
    assert.ok(hr.claimable > 0, "holder accrued rewards");
    const sr = await get<HolderReward>(`/api/rewards/${launch.mint}/${w(S)}`);
    assert.equal(sr.eligible, false);
    assert.equal(sr.claimable, 0);
    const claimH = await post<{ amount: number }>(`/api/trade/rewards/${launch.id}`, w(H));
    assert.equal(claimH.status, 200);
    assert.ok(Math.abs(claimH.body.amount - hr.claimable) < 1e-6);
    const claimS = await post(`/api/trade/rewards/${launch.id}`, w(S));
    assert.equal(claimS.status, 403);
    const l = await get<LaunchSummary>(`/api/launches/${launch.id}`);
    assert.ok(l.credit!.holderPayouts > 0);
  });

  it("ledger invariants hold end-to-end; supply and liabilities reconcile", async () => {
    const { ledger, repo } = app.ctx.offchain!;
    const report = await ledger.verify();
    assert.deepEqual(report, { ok: true, unbalancedTxs: [], balanceMismatches: [], negativeBalances: [] });
    const tok = tokenAsset(launch.id);
    const accts = await repo.read.listAccounts({ asset: tok });
    const issued = accts.filter((a) => a.kind.startsWith("token_issuance:")).reduce((s, a) => s + a.balance, 0n);
    const held = accts.filter((a) => !a.kind.startsWith("token_issuance:")).reduce((s, a) => s + a.balance, 0n);
    assert.equal(-issued, 1_000_000n * U);
    assert.equal(held, 1_000_000n * U);
    // liabilities = all deposits credited + admin credit-pool seed (no withdrawals happened)
    assert.equal(await ledger.liabilities("USDC"), 5n * 5_000n * U + 2n * 2_000n * U + 1_000_000n * U + 100_000n * U);
    const stats = await get<{ snipersBlocked: number; activeVaults: number }>("/api/stats");
    assert.ok(stats.snipersBlocked >= 1);
    const sniperFlags = await app.ctx.offchain!.engine.sniperFlags(w(S));
    assert.deepEqual(sniperFlags, [launch.id]);
    const rows = await app.ctx.offchain!.engine.accountBalances(w(H));
    assert.ok(rows.some((r) => r.asset === "USDC" && r.available > 0));
    assert.ok(rows.some((r) => r.asset === tok && r.symbol === "OFFC" && r.locked > 0));
  });
});
