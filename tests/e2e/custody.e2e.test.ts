/**
 * Black-box e2e of the CUSTODIAL user journey against a REAL API process (apps/api/dist/server.js over HTTP + WS):
 *   SIWS sign-in → admin seeds credit pool + test-credits balances → creator launch (≤2% enforced) → sealed commits
 *   (real keccak commitments, one auto-reveal envelope) → locked deposits → auction privacy → reveal → clearing →
 *   claim (exact refunds/tokens vs shared computeClearing/settleBid) → 1% fee swaps → withdrawal queued (payouts off)
 *   → admin reject → funds unlocked → ledger invariants + proof-of-reserves liabilities reconcile.
 *
 * Process env: EXECUTION_MODE=offchain, DEMO_MODE=false, NETWORK=devnet, memory ledger (no DATABASE_URL), no RPC
 * (deposit watcher / payouts off), OFFCHAIN_TICK_MS=200, ADMIN_TOKEN random per run, and the test-only hooks
 * ENABLE_TEST_CREDIT (POST /api/admin/test-credit, unbacked balances) + ENABLE_TEST_CLOCK (POST /api/admin/test-clock,
 * fast-forwards the engine clock so the 120s/60s minimum commit/reveal windows pass instantly). Both hooks are
 * ignored on mainnet (see apps/api/src/offchain/custody/config.ts).
 *
 * All keypairs are throwaway ed25519 identities generated in-test; nothing touches a chain.
 * Requires a build: `pnpm --filter @sealed/shared build && pnpm --filter @sealed/api build` (skips otherwise).
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import {
  CUSTODY_ROUTES,
  NUM_PRICE_TICKS,
  computeClearing,
  computeCommitment,
  randomSalt,
  revealSignMessage,
  sealReveal,
  settleBid,
  tickIndex,
  toHex,
  type AccountResponse,
  type AuctionResponse,
  type BalanceRow,
  type CustodyInfoResponse,
  type LaunchSummary,
  type OffchainSwapResponse,
  type WithdrawalRecord,
  type WsEnvelope,
} from "@sealed/shared";
import { ApiClient, until } from "../lib/api.ts";
import { ROOT, freePort, start, waitFor, type Proc } from "../lib/proc.ts";
import { generateKeypair, type TestKeypair } from "../lib/solana.ts";

const SERVER = path.join(ROOT, "apps/api/dist/server.js");
const built = existsSync(SERVER);
const skip = built ? false : "apps/api/dist/server.js not built — run `pnpm --filter @sealed/shared build && pnpm --filter @sealed/api build` (custody e2e SKIPPED, not failed)";
if (!built) console.log(`# SKIP custody e2e: ${skip}`);

const ADMIN_TOKEN = randomBytes(24).toString("hex");
const U = 1_000_000n; // USDC atoms
const atoms = (ui: number, d = 6) => BigInt(Math.round(ui * 10 ** d));
const FLOOR = 10_000n; // 0.01 USDC/token
const TICK = 1_000n; // 0.001
const TOKENS_FOR_SALE = 400_000n * U;
const CLEARING_CAP = 6_000n * U;
const FUND = 5_000; // USDC per user
const SEED = 100_000; // credit pool seed

let proc: Proc | undefined;
let base = "";
let ws: WebSocket | undefined;
const wsMsgs: WsEnvelope[] = [];

const admin = () => new ApiClient(base, { "x-admin-token": ADMIN_TOKEN });

function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), allKeys(x, out));
  return out;
}
const PER_BID_KEYS = ["bids", "bid", "maxPrice", "max_price", "bidAmount", "bid_amount", "salt", "commitment", "commitments", "deposits", "bidder", "bidders", "preimage", "ciphertext", "sealedReveal"];

interface User {
  name: string;
  kp: TestKeypair;
  api: ApiClient;
}
interface Bid {
  user: User;
  maxPrice: bigint;
  bidAmount: bigint;
  deposit: number;
  salt: Uint8Array;
  auto?: boolean;
  commitment?: string;
}

async function bal(u: User, asset: string): Promise<{ available: bigint; locked: bigint }> {
  const r = await u.api.get<AccountResponse>(CUSTODY_ROUTES.me);
  assert.equal(r.status, 200, r.text);
  const row = r.body.balances.find((b: BalanceRow) => b.asset === asset);
  const d = asset.startsWith("tok:") ? 6 : 6; // USDC and launch tokens are both 6 decimals
  return row ? { available: atoms(row.available, d), locked: atoms(row.locked, d) } : { available: 0n, locked: 0n };
}

async function launchOf(id: string): Promise<LaunchSummary> {
  const r = await new ApiClient(base).get<LaunchSummary>(`/api/launches/${id}`);
  assert.equal(r.status, 200, r.text);
  return r.body;
}

async function advance(sec: number) {
  const r = await admin().post<{ offsetSec: number }>("/api/admin/test-clock", { advanceSec: sec });
  assert.equal(r.status, 200, `test clock: ${r.text}`);
}

describe("custody e2e (real process: offchain, devnet, memory ledger, payouts disabled)", { skip, timeout: 120_000 }, () => {
  const mk = (name: string): User => ({ name, kp: generateKeypair(), api: new ApiClient("") });
  const creator = mk("creator");
  const A = mk("A"), B = mk("B"), C = mk("C");
  const bidders = [A, B, C];
  const bids: Bid[] = [
    { user: A, maxPrice: 20_000n, bidAmount: 3_000n * U, deposit: 3_000, salt: randomSalt() },
    { user: B, maxPrice: 15_000n, bidAmount: 2_000n * U, deposit: 2_500, salt: randomSalt(), auto: true },
    { user: C, maxPrice: 10_000n, bidAmount: 2_000n * U, deposit: 2_000, salt: randomSalt() },
  ];
  let launch: LaunchSummary;
  let tok = "";
  let credited = 0n; // total USDC atoms test-credited to users

  before(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    for (const u of [creator, ...bidders]) (u as { api: ApiClient }).api = new ApiClient(base);
    proc = start(process.execPath, [SERVER], {
      cwd: path.join(ROOT, "apps/api"),
      env: {
        PORT: String(port),
        HOST: "127.0.0.1",
        NODE_ENV: "test",
        LOG_LEVEL: "warn",
        EXECUTION_MODE: "offchain",
        DEMO_MODE: "false",
        NETWORK: "devnet",
        ADMIN_TOKEN,
        OFFCHAIN_TICK_MS: "200",
        ENABLE_TEST_CREDIT: "true",
        ENABLE_TEST_CLOCK: "true",
        // no DATABASE_URL (memory ledger), no SOLANA_RPC_URL / HELIUS_API_KEY (custody workers + payouts off),
        // no COMPANY_WALLET_SECRET_KEY (payouts disabled → withdrawals queue).
      },
    });
    await waitFor(`${base}/api/health`, proc, 30_000);
  });
  after(async () => {
    ws?.close();
    await proc?.stop();
  });

  test("health: devnet, not demo, memory store", async () => {
    const h = await new ApiClient(base).get<{ ok: boolean; network: string; isDemo: boolean; db: string }>("/api/health");
    assert.equal(h.status, 200);
    assert.equal(h.body.network, "devnet");
    assert.equal(h.body.isDemo, false);
  });

  test("SIWS sign-in for creator + 3 bidders (nonce → ed25519 sign → verify); nonce is single-use", async () => {
    for (const u of [creator, ...bidders]) {
      const out = await u.api.signIn(u.kp);
      assert.equal(out.wallet, u.kp.address);
      const s = await u.api.get<{ wallet: string }>("/api/auth/session");
      assert.equal(s.body.wallet, u.kp.address);
    }
    // wrong signer is refused; replaying a consumed nonce is refused
    const anon = new ApiClient(base);
    const n = await anon.post<{ nonce: string; message: string }>(CUSTODY_ROUTES.nonce, { wallet: A.kp.address });
    const { b58encode } = await import("../lib/solana.ts");
    const forged = b58encode(B.kp.sign(new TextEncoder().encode(n.body.message)));
    const bad = await anon.post(CUSTODY_ROUTES.verify, { wallet: A.kp.address, nonce: n.body.nonce, signature: forged });
    assert.equal(bad.status, 401);
    const good = b58encode(A.kp.sign(new TextEncoder().encode(n.body.message)));
    const replay = await anon.post(CUSTODY_ROUTES.verify, { wallet: A.kp.address, nonce: n.body.nonce, signature: good });
    assert.equal(replay.status, 401, "consumed nonce must not be reusable");
    const unauth = await anon.get(CUSTODY_ROUTES.me);
    assert.equal(unauth.status, 401);
  });

  test("admin: token required; seeds credit pool; test-credits user balances (idempotent)", async () => {
    const noTok = await new ApiClient(base).post("/api/admin/credit-pool/seed", { asset: "USDC", amount: SEED, reference: "e2e-seed-0001" });
    assert.equal(noTok.status, 401);
    const seed = await admin().post<{ ok: boolean; replayed: boolean }>("/api/admin/credit-pool/seed", { asset: "USDC", amount: SEED, reference: "e2e-seed-0001" });
    assert.equal(seed.status, 200, seed.text);
    assert.equal(seed.body.replayed, false);
    for (const u of bidders) {
      const r = await admin().post<{ replayed: boolean }>("/api/admin/test-credit", { wallet: u.kp.address, asset: "USDC", amount: FUND, reference: `e2e-fund-${u.kp.address}` });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.replayed, false);
      credited += atoms(FUND);
      const again = await admin().post<{ replayed: boolean }>("/api/admin/test-credit", { wallet: u.kp.address, asset: "USDC", amount: FUND, reference: `e2e-fund-${u.kp.address}` });
      assert.equal(again.body.replayed, true);
      assert.deepEqual(await bal(u, "USDC"), { available: atoms(FUND), locked: 0n });
    }
    const acct = await A.api.get<AccountResponse>(CUSTODY_ROUTES.me);
    assert.equal(acct.body.network, "devnet");
    assert.match(acct.body.depositRef, /^[a-z2-9]{6,32}$/);
    const ins = await A.api.get<{ memo: string; companyWallet: string }>(CUSTODY_ROUTES.depositInstructions("SOL"));
    assert.equal(ins.status, 200, ins.text);
    assert.equal(ins.body.memo, `sealed:${acct.body.depositRef}`);
  });

  test("creator launch: creatorAllocationBps 250 → 400; valid → 200 (creator = session wallet)", async () => {
    const input = {
      name: "Custody E2E", ticker: "CUSTE", description: "tests/e2e/custody", quoteAsset: "USDC", creditTier: "standard",
      totalSupply: 1_000_000, auctionSupplyBps: 4000, creatorAllocationBps: 200, commitDurationSec: 120, revealDurationSec: 60,
      floorPrice: 0.01, tickSize: 0.001, targetRaise: 4_000, clearingCap: 6_000,
    };
    const unauth = await new ApiClient(base).post("/api/launches", input);
    assert.equal(unauth.status, 401);
    const bad = await creator.api.post("/api/launches", { ...input, creatorAllocationBps: 250 });
    assert.equal(bad.status, 400, bad.text);
    const r = await creator.api.post<LaunchSummary>("/api/launches", { ...input, creator: generateKeypair().address });
    assert.equal(r.status, 200, r.text);
    launch = r.body;
    tok = `tok:${launch.id}`;
    assert.equal(launch.isDemo, false);
    assert.equal(launch.status, "commit");
    assert.equal(launch.creator, creator.kp.address, "body.creator must be ignored");
    assert.equal(launch.auction.tokensForSale, 400_000);

    // WS: subscribe to the launch channel for the rest of the journey
    ws = new WebSocket(base.replace("http", "ws") + "/ws");
    ws.on("message", (raw) => {
      try {
        wsMsgs.push(JSON.parse(raw.toString()));
      } catch {
        /* ignore */
      }
    });
    await new Promise<void>((res, rej) => (ws!.once("open", () => res()), ws!.once("error", rej)));
    ws.send(JSON.stringify({ op: "subscribe", channels: [`launch:${launch.id}`] }));
    await until("ws snapshot", async () => wsMsgs.some((m) => m.type === "launch.updated" && m.channel === `launch:${launch.id}`));
  });

  test("sealed commits (keccak commitments; B carries an auto-reveal envelope) lock deposits", async () => {
    const relayer = await new ApiClient(base).get<{ pubkey: string }>("/api/relayer/pubkey");
    assert.equal(relayer.status, 200);
    for (const b of bids) {
      const w = b.user.kp.address;
      b.commitment = toHex(computeCommitment({ bidder: w, maxPrice: b.maxPrice, bidAmount: b.bidAmount, salt: b.salt }));
      let sealedReveal: unknown;
      if (b.auto) {
        const signature = b.user.kp.sign(revealSignMessage(launch.id, b.commitment));
        sealedReveal = sealReveal({
          launchId: launch.id, bidder: w, commitmentHex: b.commitment, relayerPubkeyB64: relayer.body.pubkey,
          plaintext: { maxPrice: b.maxPrice.toString(), bidAmount: b.bidAmount.toString(), salt: toHex(b.salt) }, signature,
        });
      }
      const r = await b.user.api.post<{ bidId: string; bidCount: number }>(CUSTODY_ROUTES.commitBid, { launchId: launch.id, commitment: b.commitment, deposit: b.deposit, sealedReveal });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(await bal(b.user, "USDC"), { available: atoms(FUND - b.deposit), locked: atoms(b.deposit) }, `${b.user.name} deposit locked`);
    }
    const dup = await A.api.post(CUSTODY_ROUTES.commitBid, { launchId: launch.id, commitment: "ab".repeat(32), deposit: 1 });
    assert.equal(dup.status, 409);
    const tooEarly = await A.api.post(CUSTODY_ROUTES.reveal, { launchId: launch.id, maxPrice: "20000", bidAmount: (3_000n * U).toString(), salt: toHex(bids[0]!.salt) });
    assert.equal(tooEarly.status, 409, "reveal before the window opens");
    const early = await A.api.post(`/api/trade/claim/${launch.id}`);
    assert.equal(early.status, 409);
  });

  test("auction privacy: GET /api/auctions/:id exposes aggregates only (no bid amounts/prices/commitments)", async () => {
    const r = await new ApiClient(base).get<AuctionResponse>(`/api/auctions/${launch.id}`);
    assert.equal(r.status, 200);
    const a = r.body.launch.auction;
    assert.equal(a.bidCount, 3);
    assert.equal(a.totalEscrowed, 7_500);
    assert.equal(a.clearingPrice, null);
    const keys = allKeys(r.body);
    for (const k of PER_BID_KEYS) assert.ok(!keys.has(k), `auction response leaks "${k}"`);
    for (const b of bids) {
      assert.ok(!r.text.includes(b.commitment!), "commitment leaked");
      assert.ok(!r.text.includes(toHex(b.salt)), "salt leaked");
      assert.ok(!r.text.includes(b.bidAmount.toString()), "bid amount leaked");
      assert.ok(!r.text.includes(b.user.kp.address), "bidder wallet leaked");
    }
    // WS commit events are aggregate-only too
    const committed = wsMsgs.filter((m) => m.type === "auction.bid_committed");
    assert.equal(committed.length, 3);
    for (const m of committed) for (const k of PER_BID_KEYS) assert.ok(!allKeys(m).has(k), `ws bid_committed leaks "${k}"`);
  });

  test("commit window ends → reveal phase; relayer auto-reveals B; A and C reveal manually", async () => {
    await advance(121);
    let l = await until("reveal phase + auto reveal", async () => {
      const x = await launchOf(launch.id);
      return x.status === "reveal" && x.auction.revealedCount === 1 ? x : null;
    });
    const wrong = await A.api.post(CUSTODY_ROUTES.reveal, { launchId: launch.id, maxPrice: "20000", bidAmount: (3_000n * U).toString(), salt: "00".repeat(32) });
    assert.equal(wrong.status, 400, "reveal must match the commitment");
    for (const b of bids.filter((x) => !x.auto)) {
      const r = await b.user.api.post(CUSTODY_ROUTES.reveal, { launchId: launch.id, maxPrice: b.maxPrice.toString(), bidAmount: b.bidAmount.toString(), salt: toHex(b.salt) });
      assert.equal(r.status, 200, r.text);
    }
    l = await launchOf(launch.id);
    assert.equal(l.auction.revealedCount, 3);
  });

  let clearing: ReturnType<typeof computeClearing>;
  test("reveal window ends → clears at the shared uniform price; claims pay exact tokens + refunds", async () => {
    await advance(61);
    const l = await until("clearing → live", async () => {
      const x = await launchOf(launch.id);
      return x.status === "live" ? x : null;
    });
    const buckets = Array.from({ length: NUM_PRICE_TICKS }, () => 0n);
    for (const b of bids) buckets[tickIndex(FLOOR, TICK, b.maxPrice, NUM_PRICE_TICKS)]! += b.bidAmount;
    clearing = computeClearing({ floorPrice: FLOOR, tickSize: TICK, numTicks: NUM_PRICE_TICKS, buckets, tokensForSale: TOKENS_FOR_SALE, clearingCap: CLEARING_CAP });
    assert.equal(atoms(l.auction.clearingPrice!), clearing.clearingPrice);

    let raised = 0n;
    for (const b of bids) {
      const before = await bal(b.user, "USDC");
      const dep = atoms(b.deposit);
      const s = settleBid(clearing, FLOOR, TICK, tickIndex(FLOOR, TICK, b.maxPrice, NUM_PRICE_TICKS), b.bidAmount, dep);
      raised += s.spent;
      const r = await b.user.api.post<{ tokens: number; refund: number }>(`/api/trade/claim/${launch.id}`);
      assert.equal(r.status, 200, r.text);
      assert.equal(atoms(r.body.refund), s.refund, `${b.user.name} refund`);
      assert.equal(atoms(r.body.tokens), s.tokens, `${b.user.name} tokens`);
      const after = await bal(b.user, "USDC");
      assert.equal(after.available - before.available, s.refund, `${b.user.name} exact refund credited`);
      assert.equal(after.locked, 0n, `${b.user.name} escrow released`);
      assert.deepEqual(await bal(b.user, tok), { available: s.tokens, locked: 0n });
      // idempotent claim
      const again = await b.user.api.post<{ tokens: number; refund: number }>(`/api/trade/claim/${launch.id}`);
      assert.equal(again.status, 200);
      assert.deepEqual(await bal(b.user, "USDC"), after);
    }
    assert.equal(atoms(l.auction.totalRaised!), raised);
    assert.deepEqual(await bal(creator, tok), { available: 20_000n * U, locked: 0n }, "creator gets exactly 2% of supply");

    const events = new Set(wsMsgs.map((m) => m.type));
    for (const t of ["auction.bid_committed", "auction.phase_changed", "auction.bid_revealed", "auction.cleared", "launch.updated"]) assert.ok(events.has(t as WsEnvelope["type"]), `ws saw ${t} (got ${[...events].join(",")})`);
    const cleared = wsMsgs.find((m) => m.type === "auction.cleared") as (WsEnvelope & { data: { clearingPrice: number } }) | undefined;
    assert.equal(atoms(cleared!.data.clearingPrice), clearing.clearingPrice);
  });

  test("swaps: buy then sell, 1% fee, balances move exactly", async () => {
    await advance(10); // past the anti-snipe window after graduation
    const u = C;
    const q0 = await bal(u, "USDC"), t0 = await bal(u, tok);
    const buy = await u.api.post<OffchainSwapResponse>(CUSTODY_ROUTES.swap, { launchId: launch.id, side: "buy", amountIn: 100, minAmountOut: 0 }, { "idempotency-key": "e2e-buy-000001" });
    assert.equal(buy.status, 200, buy.text);
    assert.equal(buy.body.fee, 1, "1% of 100 USDC");
    assert.equal(buy.body.isSniper, false);
    const replay = await u.api.post<OffchainSwapResponse>(CUSTODY_ROUTES.swap, { launchId: launch.id, side: "buy", amountIn: 100, minAmountOut: 0 }, { "idempotency-key": "e2e-buy-000001" });
    assert.equal(replay.body.tradeId, buy.body.tradeId, "idempotent replay");
    const q1 = await bal(u, "USDC"), t1 = await bal(u, tok);
    assert.equal(q0.available - q1.available, 100n * U);
    assert.equal(t1.available - t0.available, atoms(buy.body.amountOut));

    const sellTokens = Number(t1.available / 2n) / 1e6;
    const sell = await u.api.post<OffchainSwapResponse>(CUSTODY_ROUTES.swap, { launchId: launch.id, side: "sell", amountIn: sellTokens, minAmountOut: 0 });
    assert.equal(sell.status, 200, sell.text);
    const gross = atoms(sell.body.amountOut) + atoms(sell.body.fee);
    assert.equal(atoms(sell.body.fee), gross / 100n, "1% of gross quote out");
    const q2 = await bal(u, "USDC"), t2 = await bal(u, tok);
    assert.equal(q2.available - q1.available, atoms(sell.body.amountOut));
    assert.equal(t1.available - t2.available, atoms(sellTokens));
    const slip = await u.api.post(CUSTODY_ROUTES.swap, { launchId: launch.id, side: "buy", amountIn: 1, minAmountOut: 1e9 });
    assert.equal(slip.status, 409);
    const trades = await new ApiClient(base).get<{ trades: { wallet: string }[] }>(`/api/launches/${launch.id}/trades`);
    assert.ok(trades.body.trades.filter((t) => t.wallet === u.kp.address).length >= 2);
    await until("ws trade events", async () => wsMsgs.filter((m) => m.type === "trade").length >= 2);
  });

  let wd: WithdrawalRecord;
  test("withdrawal: queued (payouts disabled), funds reserved, stays queued", async () => {
    const info = await new ApiClient(base).get<CustodyInfoResponse>(CUSTODY_ROUTES.info);
    assert.equal(info.status, 200);
    assert.equal(info.body.payoutsEnabled, false);
    assert.equal(info.body.mode, "offchain");
    assert.equal(info.body.network, "devnet");
    const usdcPor = info.body.proofOfReserves.find((r) => r.asset === "USDC")!;
    assert.equal(atoms(usdcPor.liabilities), credited + atoms(SEED), "PoR liabilities = test credits + credit-pool seed");

    const before = await bal(A, "USDC");
    const tooMuch = await A.api.post(CUSTODY_ROUTES.withdrawals, { asset: "USDC", amount: 1e9, destination: A.kp.address });
    assert.equal(tooMuch.status, 400);
    const toCompany = await A.api.post(CUSTODY_ROUTES.withdrawals, { asset: "USDC", amount: 1, destination: info.body.companyWallet });
    assert.equal(toCompany.status, 400);
    const r = await A.api.post<WithdrawalRecord>(CUSTODY_ROUTES.withdrawals, { asset: "USDC", amount: 100, destination: A.kp.address });
    assert.equal(r.status, 201, r.text);
    wd = r.body;
    assert.equal(wd.status, "queued");
    assert.equal(wd.amount, 100);
    const held = await bal(A, "USDC");
    assert.equal(before.available - held.available, 100n * U);
    assert.equal(held.locked, 100n * U);
    await new Promise((res) => setTimeout(res, 800)); // several scheduler ticks
    const list = await A.api.get<{ withdrawals: WithdrawalRecord[] }>(CUSTODY_ROUTES.withdrawals);
    assert.equal(list.body.withdrawals.find((w) => w.id === wd.id)?.status, "queued", "no payout worker → stays queued");
    const other = await B.api.get<{ withdrawals: WithdrawalRecord[] }>(CUSTODY_ROUTES.withdrawals);
    assert.ok(!other.body.withdrawals.some((w) => w.id === wd.id), "withdrawals are per-wallet");
  });

  test("admin rejects the withdrawal → funds unlocked", async () => {
    const q = await admin().get<{ withdrawals: (WithdrawalRecord & { wallet: string })[]; payoutsEnabled: boolean }>(CUSTODY_ROUTES.adminWithdrawals);
    assert.equal(q.status, 200, q.text);
    assert.equal(q.body.payoutsEnabled, false);
    assert.ok(q.body.withdrawals.some((w) => w.id === wd.id && w.wallet === A.kp.address));
    const before = await bal(A, "USDC");
    const r = await admin().post<WithdrawalRecord>(CUSTODY_ROUTES.adminWithdrawals, { id: wd.id, action: "reject", reason: "e2e reject" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, "rejected");
    const after = await bal(A, "USDC");
    assert.equal(after.available - before.available, 100n * U);
    assert.equal(after.locked, 0n);
    const twice = await admin().post(CUSTODY_ROUTES.adminWithdrawals, { id: wd.id, action: "reject" });
    assert.equal(twice.status, 409, "cannot reject twice (no double unlock)");
    assert.deepEqual(await bal(A, "USDC"), after);
  });

  test("ledger invariants hold; liabilities reconcile with what was credited", async () => {
    const v = await admin().get<{ ok: boolean; unbalancedTxs: string[]; balanceMismatches: string[]; negativeBalances: string[]; liabilities: Record<string, string> }>("/api/admin/ledger/verify");
    assert.equal(v.status, 200, v.text);
    assert.deepEqual({ ok: v.body.ok, u: v.body.unbalancedTxs, m: v.body.balanceMismatches, n: v.body.negativeBalances }, { ok: true, u: [], m: [], n: [] });
    // nothing ever left custody (withdrawal rejected) → liabilities = credits + seed, exactly
    assert.equal(BigInt(v.body.liabilities.USDC!), credited + atoms(SEED));
    assert.equal(BigInt(v.body.liabilities.SOL!), 0n);
    // users' USDC (available + locked) ≤ liabilities; the rest sits in system pools (pool, fees, vault, credit pool)
    let users = 0n;
    for (const u of [creator, ...bidders]) {
      const b = await bal(u, "USDC");
      users += b.available + b.locked;
    }
    assert.ok(users > 0n && users <= credited, "users cannot hold more than was credited to them");
  });

  test("server logged no errors (level ≥ 50) and never echoed the admin token", () => {
    const logs = proc!.logs();
    const errors = logs.split("\n").filter((l) => /"level":(50|60)/.test(l));
    assert.deepEqual(errors, []);
    assert.ok(!logs.includes(ADMIN_TOKEN), "admin token must never be logged");
  });
});
