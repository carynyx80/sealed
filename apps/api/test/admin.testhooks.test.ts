import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import { loadCustodyConfig } from "../src/offchain/custody/config.js";
import type { App } from "../src/server.js";
import { makeCustodyApp, signIn } from "./custodyHelpers.js";

const ADMIN = "test-admin-token-hooks-0123456789";
const H = { "x-admin-token": ADMIN };

describe("test-only admin hooks: env gating", () => {
  it("ENABLE_TEST_CREDIT / ENABLE_TEST_CLOCK are ignored on mainnet; test clock ignored in production", () => {
    const on = { ENABLE_TEST_CREDIT: "true", ENABLE_TEST_CLOCK: "true" };
    const dev = loadCustodyConfig(loadConfig({ NODE_ENV: "test", NETWORK: "devnet" }), on);
    assert.equal(dev.testCredit, true);
    assert.equal(dev.testClock, true);
    const main = loadCustodyConfig(loadConfig({ NODE_ENV: "test", NETWORK: "mainnet" }), on);
    assert.equal(main.testCredit, false);
    assert.equal(main.testClock, false);
    const prod = loadCustodyConfig(loadConfig({ NODE_ENV: "production", NETWORK: "devnet" }), on);
    assert.equal(prod.testCredit, true);
    assert.equal(prod.testClock, false);
    const off = loadCustodyConfig(loadConfig({ NODE_ENV: "test", NETWORK: "devnet" }), {});
    assert.equal(off.testCredit, false);
    assert.equal(off.testClock, false);
  });
});

describe("test-only admin hooks: disabled by default", () => {
  let app: App;
  before(async () => {
    app = await makeCustodyApp({ adminToken: ADMIN });
  });
  after(async () => {
    await app.close();
  });
  it("test-credit / test-clock routes do not exist; ledger verify is admin-gated", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const c = await app.inject({ method: "POST", url: "/api/admin/test-credit", headers: H, payload: { wallet, asset: "USDC", amount: 1, reference: "ref-0001" } });
    assert.equal(c.statusCode, 404);
    const k = await app.inject({ method: "POST", url: "/api/admin/test-clock", headers: H, payload: { advanceSec: 60 } });
    assert.equal(k.statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/admin/ledger/verify" })).statusCode, 401);
    const v = await app.inject({ method: "GET", url: "/api/admin/ledger/verify", headers: H });
    assert.equal(v.statusCode, 200, v.body);
    assert.equal(v.json().ok, true);
    assert.equal(v.json().liabilities.SOL, "0");
  });
});

describe("test-only admin hooks: enabled", () => {
  let app: App;
  before(async () => {
    app = await makeCustodyApp({ adminToken: ADMIN, testCredit: true, testClock: true });
  });
  after(async () => {
    await app.close();
  });

  it("test-credit requires the admin token, credits once per reference, shows in /api/account", async () => {
    const { token, wallet } = await signIn(app);
    const body = { wallet, asset: "USDC", amount: 250.5, reference: "e2e-fund-0001" };
    const no = await app.inject({ method: "POST", url: "/api/admin/test-credit", payload: body });
    assert.equal(no.statusCode, 401);
    const r = await app.inject({ method: "POST", url: "/api/admin/test-credit", headers: H, payload: body });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().replayed, false);
    const again = await app.inject({ method: "POST", url: "/api/admin/test-credit", headers: H, payload: body });
    assert.equal(again.json().replayed, true);
    const conflict = await app.inject({ method: "POST", url: "/api/admin/test-credit", headers: H, payload: { ...body, amount: 1 } });
    assert.equal(conflict.statusCode, 409);
    const bad = await app.inject({ method: "POST", url: "/api/admin/test-credit", headers: H, payload: { ...body, wallet: "not-a-wallet" } });
    assert.equal(bad.statusCode, 400);
    const acct = await app.inject({ method: "GET", url: "/api/account", headers: { authorization: `Bearer ${token}` } });
    const usdc = acct.json().balances.find((b: { asset: string }) => b.asset === "USDC");
    assert.equal(usdc.available, 250.5);
    const v = await app.inject({ method: "GET", url: "/api/admin/ledger/verify", headers: H });
    assert.equal(v.json().ok, true);
    assert.equal(v.json().liabilities.USDC, "250500000");
  });

  it("test-clock fast-forwards the engine clock", async () => {
    const engine = app.ctx.offchain!.engine;
    const before = engine.deps.nowMs();
    const r = await app.inject({ method: "POST", url: "/api/admin/test-clock", headers: H, payload: { advanceSec: 3600 } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().offsetSec, 3600);
    assert.ok(engine.deps.nowMs() - before >= 3_600_000);
    const bad = await app.inject({ method: "POST", url: "/api/admin/test-clock", headers: H, payload: { advanceSec: -5 } });
    assert.equal(bad.statusCode, 400);
  });
});
