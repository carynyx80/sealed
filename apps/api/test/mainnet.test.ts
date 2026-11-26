import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { QUOTE_ASSET_MAINNET, isQuoteAssetEnabled, type QuoteAssetSymbol } from "@sealed/shared";
import { loadConfig } from "../src/config.js";
import { ata, custodyAssets } from "../src/offchain/custody/chain.js";
import { loadCustodyConfig } from "../src/offchain/custody/config.js";
import { FEE_PAYER_REASON } from "../src/offchain/custody/payout.js";
import {
  LivePriceService,
  StaticPriceService,
  createPriceService,
  jupiterPriceSource,
  type PriceQuote,
  type PriceService,
  type PriceSource,
} from "../src/offchain/custody/prices.js";
import { MemoryRepo } from "../src/offchain/repo/memory.js";
import { MemoryStore } from "../src/store/index.js";
import { EventBus } from "../src/events.js";
import { buildServer, type App } from "../src/server.js";
import { MockRpc, makeCustodyApp, signIn } from "./custodyHelpers.js";
import { validLaunch } from "./helpers.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const ADMIN = "test-admin-token-mainnet-0123456789";

/** Mocked price fetcher: programmable per call. */
class FakeSource implements PriceSource {
  calls = 0;
  constructor(public name: string, public impl: (mints: string[]) => Promise<Map<string, number>>) {}
  fetchPrices(mints: string[]) {
    this.calls++;
    return this.impl(mints);
  }
}
const fixed = (p: Record<string, number>) => async () => new Map(Object.entries(p));

/** Price service that always (or never) has a fresh price. */
class StubPrices implements PriceService {
  readonly live = true;
  constructor(public prices: Partial<Record<QuoteAssetSymbol, number>> | null) {}
  async usdPrice(s: QuoteAssetSymbol): Promise<PriceQuote | null> {
    const p = this.prices?.[s];
    return p ? { usd: p, asOfMs: Date.now(), source: "stub" } : null;
  }
  lastKnown(s: QuoteAssetSymbol) {
    const p = this.prices?.[s];
    return p ? { usd: p, asOfMs: Date.now(), source: "stub" } : null;
  }
}

async function mainnetApp(opts: { env?: Record<string, string>; custody?: Record<string, unknown>; prices?: PriceService; rpc?: MockRpc | null; custodyEnv?: Record<string, string> } = {}): Promise<App> {
  const config = loadConfig({ NODE_ENV: "test", NETWORK: "mainnet", ...opts.env });
  const app = await buildServer({
    config, logger: false, workers: false, offchainRepo: new MemoryRepo(),
    custody: { env: opts.custodyEnv ?? {}, rpc: opts.rpc === undefined ? null : opts.rpc, prices: opts.prices ?? new StubPrices({ SOL: 70, USDC: 1 }), config: { workers: false, ...opts.custody } },
    rpcProxy: { upstreamUrl: null },
  });
  await app.ready();
  return app;
}

describe("live prices (mainnet withdrawal limits)", () => {
  it("Jupiter v3 response shape is parsed; invalid prices ignored", async () => {
    let url = "";
    const fetchFn = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({
        [WSOL]: { usdPrice: 70.87, blockId: 474166148, decimals: 9, liquidity: 1, priceChange24h: 5 },
        [USDC]: { usdPrice: -1 },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const got = await jupiterPriceSource("https://lite-api.jup.ag/price/v3", { fetchFn }).fetchPrices([WSOL, USDC], new AbortController().signal);
    assert.equal(url, `https://lite-api.jup.ag/price/v3?ids=${WSOL},${USDC}`);
    assert.equal(got.get(WSOL), 70.87);
    assert.equal(got.has(USDC), false);
  });

  it("60s cache, 5 min staleness limit, fallback source, timeout", async () => {
    let now = 1_000_000;
    const jup = new FakeSource("jupiter", fixed({ [WSOL]: 70, [USDC]: 1 }));
    const helius = new FakeSource("helius", fixed({ [WSOL]: 71 }));
    const svc = new LivePriceService([jup, helius], [{ symbol: "SOL", mint: WSOL }, { symbol: "USDC", mint: USDC }], undefined, { now: () => now, timeoutMs: 50 });
    assert.equal((await svc.usdPrice("SOL"))!.usd, 70);
    assert.equal((await svc.usdPrice("USDC"))!.usd, 1);
    assert.equal(jup.calls, 1, "second lookup within 60s served from cache");
    assert.equal(helius.calls, 0);
    now += 61_000;
    jup.impl = async () => {
      throw new Error("HTTP 500 api-key=SECRET");
    };
    const q = await svc.usdPrice("SOL"); // refresh fails on jupiter → helius fallback
    assert.equal(q!.usd, 71);
    assert.equal(q!.source, "helius");
    assert.equal(jup.calls, 2);
    // USDC: no source succeeded, cached value still ≤ 5 min old → used
    assert.equal((await svc.usdPrice("USDC"))!.usd, 1);
    // everything down: after 5 min the cached prices are stale → null (fail safe)
    helius.impl = () => new Promise(() => undefined); // hangs → timeout
    now += 5 * 60_000 + 1;
    assert.equal(await svc.usdPrice("SOL"), null);
    assert.equal(await svc.usdPrice("USDC"), null);
    assert.equal(svc.lastKnown("SOL")!.usd, 71, "last known kept for recording only");
    assert.equal(await svc.usdPrice("NVDAx"), null, "unpriced asset");
  });

  it("devnet uses static demo prices; mainnet uses the live service", () => {
    assert.ok(createPriceService("devnet", { jupiterPriceApiUrl: "https://x" }) instanceof StaticPriceService);
    const live = createPriceService("mainnet", { jupiterPriceApiUrl: "https://x" });
    assert.ok(live instanceof LivePriceService);
    assert.equal(live.live, true);
  });

  it("withdrawal with no fresh price → pending_approval (never auto-approved)", async () => {
    const app = await makeCustodyApp({ adminToken: ADMIN });
    try {
      (app.custody.withdrawals as unknown as { prices: PriceService }).prices = new StubPrices(null);
      const { token, wallet } = await signIn(app);
      await app.ctx.offchain!.ledger.credit(wallet, "USDC", 100_000_000n, `fund:${wallet}`);
      const r = await app.inject({ method: "POST", url: "/api/account/withdrawals", headers: { authorization: `Bearer ${token}` }, payload: { asset: "USDC", amount: 10, destination: wallet } });
      assert.equal(r.statusCode, 201, r.body);
      assert.equal(r.json().status, "pending_approval");
      assert.match(r.json().reason, /no fresh USDC USD price/);
      // live price present → small withdrawal auto-approved; live price used for the limit
      (app.custody.withdrawals as unknown as { prices: PriceService }).prices = new StubPrices({ USDC: 1 });
      const ok = await app.inject({ method: "POST", url: "/api/account/withdrawals", headers: { authorization: `Bearer ${token}` }, payload: { asset: "USDC", amount: 10, destination: wallet } });
      assert.equal(ok.json().status, "queued");
    } finally {
      await app.close();
    }
  });
});

describe("mainnet config guards", () => {
  it("DEMO_MODE=true is forced OFF on mainnet (loud startup error); implicit demo too", () => {
    const c = loadConfig({ NODE_ENV: "test", NETWORK: "mainnet", DEMO_MODE: "true" });
    assert.equal(c.isDemo, false);
    assert.match(c.startupErrors.join(" "), /FORCED OFF/);
    const implicit = loadConfig({ NODE_ENV: "test", NETWORK: "mainnet", HELIUS_API_KEY: "k" });
    assert.equal(implicit.isDemo, false);
    assert.equal(loadConfig({ NODE_ENV: "test", NETWORK: "mainnet" }, { isDemo: true }).isDemo, false);
    assert.equal(loadConfig({ NODE_ENV: "test", NETWORK: "devnet", DEMO_MODE: "true" }).isDemo, true);
  });

  it("test-only hooks can never be enabled on mainnet (env or overrides)", () => {
    const c = loadCustodyConfig(loadConfig({ NODE_ENV: "test", NETWORK: "mainnet" }), { ENABLE_TEST_CREDIT: "true", ENABLE_TEST_CLOCK: "true" }, { testCredit: true, testClock: true });
    assert.equal(c.testCredit, false);
    assert.equal(c.testClock, false);
  });

  it("DEPOSIT_CONFIRMATIONS: finalized by default on mainnet; numeric < 32 refused", () => {
    const main = loadConfig({ NODE_ENV: "test", NETWORK: "mainnet" });
    assert.equal(loadCustodyConfig(main, {}).depositConfirmations, "finalized");
    assert.throws(() => loadCustodyConfig(main, { DEPOSIT_CONFIRMATIONS: "5" }), /mainnet/);
    assert.equal(loadCustodyConfig(main, { DEPOSIT_CONFIRMATIONS: "40" }).depositConfirmations, 40);
    assert.equal(loadCustodyConfig(loadConfig({ NODE_ENV: "test" }), { DEPOSIT_CONFIRMATIONS: "5" }).depositConfirmations, 5);
  });

  it("ADMIN_TOKEN missing on mainnet → manualApprovalOnly", () => {
    const main = loadConfig({ NODE_ENV: "test", NETWORK: "mainnet" });
    assert.equal(loadCustodyConfig(main, {}).manualApprovalOnly, true);
    assert.equal(loadCustodyConfig(main, { ADMIN_TOKEN: ADMIN }).manualApprovalOnly, false);
    assert.equal(loadCustodyConfig(loadConfig({ NODE_ENV: "test" }), {}).manualApprovalOnly, false);
  });

  it("demo store is refused on mainnet", () => {
    assert.throws(() => new MemoryStore({ isDemo: true, network: "mainnet", bus: new EventBus(), autoTick: false }), /mainnet/);
  });
});

describe("mainnet quote assets", () => {
  it("only SOL + USDC enabled; verified xStocks are Token-2022 and stay disabled; env overrides ignored", () => {
    const enabled = (Object.keys(QUOTE_ASSET_MAINNET) as QuoteAssetSymbol[]).filter((s) => isQuoteAssetEnabled(s, "mainnet"));
    assert.deepEqual(enabled.sort(), ["SOL", "USDC"]);
    for (const s of ["NVDAx", "TSLAx", "TTWOx", "AAPLx", "SPYx"] as const) {
      assert.equal(QUOTE_ASSET_MAINNET[s].tokenProgram, "token-2022");
      assert.match(QUOTE_ASSET_MAINNET[s].mint!, /^Xs/);
    }
    const assets = custodyAssets("mainnet", { QUOTE_MINT_NVDAX_MAINNET: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", QUOTE_MINT_USDC_MAINNET: Keypair.generate().publicKey.toBase58() });
    assert.deepEqual(assets.map((a) => [a.symbol, a.mint]), [["SOL", null], ["USDC", USDC]]);
  });
});

describe("mainnet app (offchain, in-memory ledger injected)", () => {
  let app: App;
  before(async () => {
    app = await mainnetApp({ env: { DEMO_MODE: "true", ENABLE_TEST_CREDIT: "true" }, custodyEnv: { ENABLE_TEST_CREDIT: "true", ENABLE_TEST_CLOCK: "true" } });
  });
  after(async () => {
    await app.close();
  });

  it("no demo world: health isDemo=false, no launches, demo-bid refused", async () => {
    const h = (await app.inject({ method: "GET", url: "/api/health" })).json();
    assert.equal(h.isDemo, false);
    assert.equal(h.network, "mainnet");
    const l = (await app.inject({ method: "GET", url: "/api/launches?limit=200" })).json();
    assert.equal(l.launches.length, 0);
    assert.ok(!(app.ctx.store as unknown as { demo?: unknown }).demo);
  });

  it("test-only hooks do not exist on mainnet", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/test-credit", payload: { wallet, asset: "USDC", amount: 1, reference: "ref-0001" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/test-clock", payload: { advanceSec: 60 } })).statusCode, 404);
  });

  it("POST /api/launches: commit window 15–30 min and enabled quote assets only", async () => {
    const { token } = await signIn(app);
    const h = { authorization: `Bearer ${token}` };
    const short = await app.inject({ method: "POST", url: "/api/launches", headers: h, payload: { ...validLaunch, commitDurationSec: 600 } });
    assert.equal(short.statusCode, 400);
    assert.match(short.body, /900/);
    const stock = await app.inject({ method: "POST", url: "/api/launches", headers: h, payload: { ...validLaunch, quoteAsset: "NVDAx", commitDurationSec: 900 } });
    assert.equal(stock.statusCode, 400);
    assert.match(stock.body, /not enabled on mainnet/);
    const ok = await app.inject({ method: "POST", url: "/api/launches", headers: h, payload: { ...validLaunch, commitDurationSec: 900 } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().isDemo, false);
    assert.equal(ok.json().network, "mainnet");
    // unauthenticated → 401 (no demo fallback on mainnet)
    assert.equal((await app.inject({ method: "POST", url: "/api/launches", payload: { ...validLaunch, commitDurationSec: 900 } })).statusCode, 401);
  });

  it("deposit instructions: disabled quote asset → 400; USDC uses the verified mainnet mint", async () => {
    const { token } = await signIn(app);
    const h = { authorization: `Bearer ${token}` };
    const nv = await app.inject({ method: "GET", url: "/api/account/deposit/NVDAx", headers: h });
    assert.equal(nv.statusCode, 400);
    assert.match(nv.body, /Token-2022/);
    const u = await app.inject({ method: "GET", url: "/api/account/deposit/USDC", headers: h });
    assert.equal(u.statusCode, 200);
    assert.equal(u.json().mint, USDC);
    assert.equal(u.json().minConfirmations, 32);
  });

  it("no ADMIN_TOKEN: withdrawals accepted but ALL pending_approval; admin disabled", async () => {
    const { token, wallet } = await signIn(app);
    await app.ctx.offchain!.ledger.credit(wallet, "USDC", 100_000_000n, `fund:${wallet}`);
    const r = await app.inject({ method: "POST", url: "/api/account/withdrawals", headers: { authorization: `Bearer ${token}` }, payload: { asset: "USDC", amount: 1, destination: wallet } });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().status, "pending_approval");
    assert.match(r.json().reason, /ADMIN_TOKEN/);
    assert.equal((await app.inject({ method: "GET", url: "/api/admin/withdrawals", headers: { "x-admin-token": "x" } })).statusCode, 503);
    const info = (await app.inject({ method: "GET", url: "/api/custody/info" })).json();
    assert.equal(info.network, "mainnet");
    assert.equal(info.payoutsEnabled, false);
    assert.match(info.payoutsReason, /COMPANY_WALLET_SECRET_KEY/);
    assert.deepEqual(info.proofOfReserves.map((x: { asset: string }) => x.asset), ["SOL", "USDC"]);
  });
});

describe("payout fee-payer health", () => {
  const company = Keypair.generate();
  const cw = company.publicKey.toBase58();
  let app: App;
  let rpc: MockRpc;
  before(async () => {
    rpc = new MockRpc();
    app = await mainnetApp({ rpc, custody: { adminToken: ADMIN, companyWallet: cw, companySecretKey: bs58.encode(company.secretKey) } });
  });
  after(async () => {
    await app.close();
  });

  it("company wallet without spare SOL → withdrawal stays queued with reason; info payoutsEnabled:false", async () => {
    const { token, wallet } = await signIn(app);
    // User deposit of 2 SOL is a liability; the wallet holds exactly that → no surplus for fees.
    await app.ctx.offchain!.ledger.credit(wallet, "SOL", 2_000_000_000n, `fund:${wallet}`);
    rpc.balances.set(cw, 2_000_000_000n);
    const r = await app.inject({ method: "POST", url: "/api/account/withdrawals", headers: { authorization: `Bearer ${token}` }, payload: { asset: "SOL", amount: 0.5, destination: wallet } });
    assert.equal(r.json().status, "queued", r.body);
    await app.custody.payouts!.tick();
    let w = (await app.custody.repo.getWithdrawal(r.json().id))!;
    assert.equal(w.status, "queued");
    assert.equal(w.reason, FEE_PAYER_REASON);
    assert.equal(rpc.sent.length, 0, "nothing broadcast");
    const info = (await app.inject({ method: "GET", url: "/api/custody/info" })).json();
    assert.equal(info.payoutsEnabled, false);
    assert.equal(info.payoutsReason, FEE_PAYER_REASON);
    assert.equal(info.feePayer.ok, false);
    assert.equal(info.feePayer.surplusSol, 0);

    // Operator funds the wallet with 0.01 SOL of its own → payout proceeds, reason cleared.
    rpc.balances.set(cw, 2_010_000_000n);
    await app.custody.payouts!.tick();
    w = (await app.custody.repo.getWithdrawal(r.json().id))!;
    assert.equal(w.status, "sending");
    assert.equal(w.reason, null);
    assert.equal(rpc.sent.length, 1);
  });

  it("token payout: needs recipient ATA rent from surplus and the token balance in the company ATA", async () => {
    const { token, wallet } = await signIn(app);
    await app.ctx.offchain!.ledger.credit(wallet, "USDC", 50_000_000n, `fund:${wallet}`);
    const r = await app.inject({ method: "POST", url: "/api/account/withdrawals", headers: { authorization: `Bearer ${token}` }, payload: { asset: "USDC", amount: 20, destination: wallet } });
    assert.equal(r.json().status, "queued", r.body);
    const companyAta = ata(cw, USDC).toBase58();
    rpc.balances.set(companyAta, 10_000_000n); // only 10 USDC on-chain
    await app.custody.payouts!.tick();
    let w = (await app.custody.repo.getWithdrawal(r.json().id))!;
    assert.equal(w.status, "queued");
    assert.match(w.reason!, /USDC balance below payout amount/);
    rpc.balances.set(companyAta, 100_000_000n);
    // SOL surplus: liabilities are 1.5 SOL (2 − 0.5 still locked/sending … locked stays a liability until settled)
    const liab = await app.ctx.offchain!.ledger.liabilities("SOL");
    rpc.balances.set(cw, liab + 1_000_000n); // 0.001 SOL surplus < fee + ATA rent + reserve
    await app.custody.payouts!.tick();
    w = (await app.custody.repo.getWithdrawal(r.json().id))!;
    assert.equal(w.status, "queued");
    assert.equal(w.reason, FEE_PAYER_REASON);
    rpc.balances.set(cw, liab + 10_000_000n);
    await app.custody.payouts!.tick();
    assert.equal((await app.custody.repo.getWithdrawal(r.json().id))!.status, "sending");
  });
});

describe("POST /api/rpc proxy", () => {
  const KEY = "SECRET-HELIUS-KEY-123";
  const UP = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
  let app: App;
  let calls: { url: string; body: unknown }[];
  let respond: (body: unknown) => Response | Promise<Response>;
  let echo: (body: unknown) => Response | Promise<Response>;
  let now = 0;
  before(async () => {
    calls = [];
    respond = echo = (body) => new Response(JSON.stringify(Array.isArray(body) ? body.map((b: { id: unknown }) => ({ jsonrpc: "2.0", id: b.id, result: 1 })) : { jsonrpc: "2.0", id: (body as { id: unknown }).id, result: { value: 42 } }), { status: 200 });
    const fetchFn = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      return respond(body);
    }) as unknown as typeof fetch;
    const config = loadConfig({ NODE_ENV: "test", CORS_ORIGIN: "https://sealed.app" });
    app = await buildServer({ config, logger: false, workers: false, custody: { env: {}, rpc: null, config: { workers: false } }, rpcProxy: { upstreamUrl: UP, fetchFn, now: () => now } });
    await app.ready();
  });
  after(async () => {
    await app.close();
  });
  const post = (payload: unknown, ip = "1.1.1.1", headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/api/rpc", payload: payload as object, remoteAddress: ip, headers: { "content-type": "application/json", ...headers } });

  it("forwards allowlisted methods to the upstream; never echoes the key", async () => {
    const r = await post({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["11111111111111111111111111111111"] });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { jsonrpc: "2.0", id: 1, result: { value: 42 } });
    assert.equal(calls.at(-1)!.url, UP);
    assert.deepEqual(calls.at(-1)!.body, { jsonrpc: "2.0", id: 1, method: "getBalance", params: ["11111111111111111111111111111111"] });
    assert.ok(!r.body.includes(KEY));
    // upstream echoing its own url is redacted
    respond = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: `bad request at ${UP}` } }), { status: 200 });
    const e = await post({ jsonrpc: "2.0", id: 2, method: "getSlot" });
    assert.ok(!e.body.includes(KEY), e.body);
    respond = () => new Response("oops", { status: 503 });
    const down = await post({ jsonrpc: "2.0", id: 3, method: "getSlot" }, "1.1.1.2");
    assert.equal(down.statusCode, 502);
    assert.ok(!down.body.includes(KEY));
    respond = () => Promise.reject(new Error(`connect ECONNREFUSED ${UP}`));
    const err = await post({ jsonrpc: "2.0", id: 4, method: "getSlot" }, "1.1.1.2");
    assert.equal(err.statusCode, 502);
    assert.ok(!err.body.includes(KEY));
    respond = echo;
  });

  it("rejects non-allowlisted methods, malformed requests, large batches, big bodies", async () => {
    const n = calls.length;
    const bad = await post({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [] }, "2.2.2.2");
    assert.equal(bad.statusCode, 403);
    assert.equal(bad.json().error.code, -32601);
    assert.equal((await post({ id: 1, method: "getSlot" }, "2.2.2.2")).statusCode, 400);
    assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "getSlot", params: 5 }, "2.2.2.2")).statusCode, 400);
    const batch11 = Array.from({ length: 11 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "getSlot" }));
    assert.equal((await post(batch11, "2.2.2.2")).statusCode, 400);
    assert.equal((await post([], "2.2.2.2")).statusCode, 400);
    const mixed = [{ jsonrpc: "2.0", id: 1, method: "getSlot" }, { jsonrpc: "2.0", id: 2, method: "requestAirdrop" }];
    assert.equal((await post(mixed, "2.2.2.2")).statusCode, 403);
    const big = await post({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["A".repeat(70 * 1024)] }, "2.2.2.2");
    assert.equal(big.statusCode, 413);
    assert.equal(calls.length, n, "nothing forwarded");
    const ok = await post(batch11.slice(0, 10), "2.2.2.2");
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().length, 10);
  });

  it("per-IP rate limits: 120/min overall, 20 sendTransaction/min", async () => {
    now = 10 * 60_000;
    const send = { jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["AQ=="] };
    for (let i = 0; i < 20; i++) assert.equal((await post(send, "3.3.3.3")).statusCode, 200);
    assert.equal((await post(send, "3.3.3.3")).statusCode, 429);
    assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "getSlot" }, "3.3.3.3")).statusCode, 200, "other methods still allowed");
    assert.equal((await post(send, "4.4.4.4")).statusCode, 200, "other IP unaffected");
    const batch = Array.from({ length: 10 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "getSlot" }));
    for (let i = 0; i < 12; i++) assert.equal((await post(batch, "5.5.5.5")).statusCode, 200);
    assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "getSlot" }, "5.5.5.5")).statusCode, 429);
    now += 61_000;
    assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "getSlot" }, "5.5.5.5")).statusCode, 200, "window resets");
  });

  it("CORS same as API; no upstream → 503", async () => {
    const pre = await app.inject({ method: "OPTIONS", url: "/api/rpc", headers: { origin: "https://sealed.app", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    assert.equal(pre.headers["access-control-allow-origin"], "https://sealed.app");
    const r = await post({ jsonrpc: "2.0", id: 1, method: "getSlot" }, "6.6.6.6", { origin: "https://sealed.app" });
    assert.equal(r.headers["access-control-allow-origin"], "https://sealed.app");
    const noUp = await mainnetApp();
    try {
      const x = await noUp.inject({ method: "POST", url: "/api/rpc", payload: { jsonrpc: "2.0", id: 1, method: "getSlot" } });
      assert.equal(x.statusCode, 503);
    } finally {
      await noUp.close();
    }
  });
});
