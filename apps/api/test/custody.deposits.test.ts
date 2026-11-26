import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Ledger } from "../src/offchain/ledger.js";
import { MemoryRepo } from "../src/offchain/repo/memory.js";
import { ata, custodyAssets } from "../src/offchain/custody/chain.js";
import { loadCustodyConfig } from "../src/offchain/custody/config.js";
import { parseDepositTransaction, parseMemoRef } from "../src/offchain/custody/depositParser.js";
import { DepositService, DepositWatcher } from "../src/offchain/custody/deposits.js";
import { MemoryCustodyRepo } from "../src/offchain/custody/repo.js";
import { HttpSolanaRpc, redact } from "../src/offchain/custody/rpc.js";
import { loadConfig } from "../src/config.js";
import type { App } from "../src/server.js";
import { MockRpc, fixtureTx, fixtures, makeCustodyApp, signIn, sigOf } from "./custodyHelpers.js";

const COMPANY = fixtures.companyWallet;
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const silent = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {}, child() { return silent; }, level: "silent" } as never;
const assets = custodyAssets("devnet", {});
const REF = "abcdefgh23";

describe("deposit parser (fixtures)", () => {
  it("SOL + memo", () => {
    const r = parseDepositTransaction(fixtureTx("solMemo", REF), COMPANY, assets);
    assert.equal(r.candidates.length, 1);
    const c = r.candidates[0]!;
    assert.equal(c.asset, "SOL");
    assert.equal(c.mint, null);
    assert.equal(c.amountAtoms, 250_000_000n);
    assert.equal(c.depositRef, REF);
    assert.equal(c.reject, null);
    assert.equal(c.key, `${sigOf(fixtureTx("solMemo", REF))}:1`);
  });
  it("USDC transferChecked + memo into the company ATA", () => {
    const tx = fixtureTx("usdcMemo", REF);
    const r = parseDepositTransaction(tx, COMPANY, assets);
    assert.equal(r.candidates.length, 1);
    const c = r.candidates[0]!;
    assert.equal(c.asset, "USDC");
    assert.equal(c.mint, USDC_DEVNET);
    assert.equal(c.amountAtoms, 125_500_000n);
    assert.equal(c.reject, null);
    assert.equal(tx.transaction.message.accountKeys[2]!.pubkey, ata(COMPANY, USDC_DEVNET).toBase58());
  });
  it("wrong mint → rejected candidate", () => {
    const c = parseDepositTransaction(fixtureTx("wrongMint", REF), COMPANY, assets).candidates[0]!;
    assert.equal(c.asset, null);
    assert.match(c.reject!, /unsupported mint/);
  });
  it("missing memo → rejected candidate", () => {
    const c = parseDepositTransaction(fixtureTx("noMemo", REF), COMPANY, assets).candidates[0]!;
    assert.match(c.reject!, /missing/);
  });
  it("failed tx yields nothing; memo ref parsing", () => {
    const tx = fixtureTx("solMemo", REF);
    tx.meta!.err = { InstructionError: [1, "Custom"] };
    assert.equal(parseDepositTransaction(tx, COMPANY, assets).failed, true);
    assert.equal(parseMemoRef("sealed:abcdefgh23"), "abcdefgh23");
    assert.equal(parseMemoRef("sealed:ABC"), null);
    assert.equal(parseMemoRef("hello"), null);
  });
  it("transfers to other wallets are ignored", () => {
    assert.equal(parseDepositTransaction(fixtureTx("solMemo", REF), fixtures.user, assets).candidates.length, 0);
  });
});

describe("DepositService exactly-once crediting", () => {
  let repo: MemoryCustodyRepo;
  let ledger: Ledger;
  let rpc: MockRpc;
  let svc: DepositService;
  let wallet: string;
  let ref: string;

  beforeEach(async () => {
    repo = new MemoryCustodyRepo();
    ledger = new Ledger(new MemoryRepo());
    rpc = new MockRpc();
    const cfg = loadCustodyConfig(loadConfig({ NODE_ENV: "test" }), {});
    svc = new DepositService(cfg, repo, ledger, rpc, assets, silent);
    const u = await repo.ensureUser(fixtures.user);
    wallet = u.wallet;
    ref = u.depositRef;
  });

  const avail = async (asset: string) => (await ledger.balances(wallet)).find((b) => b.asset === asset)?.available ?? 0n;

  it("credits SOL and USDC once, duplicates are no-ops", async () => {
    const sol = fixtureTx("solMemo", ref);
    const usdc = fixtureTx("usdcMemo", ref);
    rpc.addTx(sol);
    rpc.addTx(usdc);
    for (let i = 0; i < 3; i++) {
      await svc.processSignature(sigOf(sol));
      await svc.processSignature(sigOf(usdc));
    }
    assert.equal(await avail("SOL"), 250_000_000n);
    assert.equal(await avail("USDC"), 125_500_000n);
    assert.equal(await ledger.liabilities("SOL"), 250_000_000n);
    const rows = await repo.listDepositsByWallet(wallet);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === "credited"));
  });

  it("crash between record and credit heals via the idempotent ledger key", async () => {
    const sol = fixtureTx("solMemo", ref);
    rpc.addTx(sol);
    await svc.processSignature(sigOf(sol));
    await repo.updateDeposit(`${sigOf(sol)}:1`, { status: "confirmed" }); // simulate crash before marking credited
    await svc.retryPending();
    assert.equal(await avail("SOL"), 250_000_000n);
    assert.equal((await repo.getDeposit(`${sigOf(sol)}:1`))!.status, "credited");
  });

  it("unknown ref / wrong mint / no memo are recorded as rejected, never credited", async () => {
    for (const name of ["wrongMemo", "wrongMint", "noMemo"]) {
      const tx = fixtureTx(name, ref);
      rpc.addTx(tx);
      const out = await svc.processSignature(sigOf(tx));
      assert.equal(out.kind, "processed");
      if (out.kind === "processed") assert.equal(out.records[0]!.status, "rejected", name);
    }
    assert.equal(await avail("SOL"), 0n);
    assert.equal(await ledger.liabilities("SOL"), 0n);
    assert.equal((await repo.listDepositsByStatus(["rejected"])).length, 3);
  });

  it("not yet visible at the required commitment → not_found", async () => {
    assert.equal((await svc.processSignature("5".repeat(88))).kind, "not_found");
  });

  it("confirmation-depth mode waits for N slots", async () => {
    const cfg = loadCustodyConfig(loadConfig({ NODE_ENV: "test" }), { DEPOSIT_CONFIRMATIONS: "40" });
    const s2 = new DepositService(cfg, repo, ledger, rpc, assets, silent);
    const sol = fixtureTx("solMemo", ref);
    rpc.addTx(sol);
    rpc.slot = sol.slot + 10;
    const out = await s2.processSignature(sigOf(sol));
    assert.equal(out.kind === "processed" && out.records[0]!.status, "detected");
    assert.equal(await avail("SOL"), 0n);
    rpc.slot = sol.slot + 40;
    await s2.retryPending();
    assert.equal(await avail("SOL"), 250_000_000n);
  });

  it("DepositWatcher scans wallet + ATAs, survives RPC failure", async () => {
    const sol = fixtureTx("solMemo", ref);
    const usdc = fixtureTx("usdcMemo", ref);
    rpc.addTx(sol, COMPANY);
    rpc.addTx(usdc, ata(COMPANY, USDC_DEVNET).toBase58());
    const addrs = [COMPANY, ata(COMPANY, USDC_DEVNET).toBase58()];
    const w = new DepositWatcher(svc, rpc, addrs, 1000, silent);
    rpc.fail = new Error("boom https://devnet.helius-rpc.com/?api-key=SECRET");
    assert.equal(await w.tick(), false);
    rpc.fail = null;
    assert.equal(await w.tick(), true);
    assert.equal(await w.tick(), true);
    assert.equal(await avail("SOL"), 250_000_000n);
    assert.equal(await avail("USDC"), 125_500_000n);
  });
});

describe("HttpSolanaRpc", () => {
  it("retries transient errors with backoff and never leaks the api key", async () => {
    let n = 0;
    const fetchFn = (async () => {
      n++;
      if (n < 3) return new Response("busy", { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 123 }), { status: 200 });
    }) as typeof fetch;
    const rpc = new HttpSolanaRpc("https://devnet.helius-rpc.com/?api-key=SECRET", { fetchFn, sleep: async () => undefined });
    assert.equal(await rpc.getSlot("finalized"), 123);
    assert.equal(n, 3);

    const down = new HttpSolanaRpc("https://devnet.helius-rpc.com/?api-key=SECRET", {
      fetchFn: (async () => { throw new Error("connect ECONNREFUSED https://devnet.helius-rpc.com/?api-key=SECRET"); }) as typeof fetch,
      sleep: async () => undefined,
      retries: 1,
    });
    await assert.rejects(down.getSlot("finalized"), (e: Error) => !e.message.includes("SECRET"));
    assert.ok(!redact("x api-key=SECRET y").includes("SECRET"));
  });
});

describe("deposit routes", () => {
  let app: App;
  let rpc: MockRpc;
  before(async () => {
    rpc = new MockRpc();
    app = await makeCustodyApp({}, rpc);
  });
  after(async () => {
    await app.close();
  });

  it("instructions + claim credits the signed-in user once", async () => {
    const { token, wallet } = await signIn(app);
    const h = { authorization: `Bearer ${token}` };
    const ins = (await app.inject({ method: "GET", url: "/api/account/deposit/USDC", headers: h })).json();
    assert.equal(ins.mint, USDC_DEVNET);
    assert.equal(ins.companyWallet, COMPANY);
    const ref = ins.memo.slice("sealed:".length);
    assert.equal((await app.inject({ method: "GET", url: "/api/account/deposit/NVDAx", headers: h })).statusCode, 400);

    const tx = fixtureTx("usdcMemo", ref);
    rpc.addTx(tx);
    for (let i = 0; i < 2; i++) {
      const r = await app.inject({ method: "POST", url: "/api/account/deposits", headers: h, payload: { signature: sigOf(tx) } });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().status, "credited");
      assert.equal(r.json().amount, 125.5);
    }
    const list = (await app.inject({ method: "GET", url: "/api/account/deposits", headers: h })).json();
    assert.equal(list.deposits.length, 1);
    const acct = (await app.inject({ method: "GET", url: "/api/account", headers: h })).json();
    assert.equal(acct.wallet, wallet);
    const usdc = acct.balances.find((b: { asset: string }) => b.asset === "USDC");
    assert.equal(usdc.available, 125.5);

    // Another user cannot claim it.
    const other = await signIn(app);
    const r2 = await app.inject({ method: "POST", url: "/api/account/deposits", headers: { authorization: `Bearer ${other.token}` }, payload: { signature: sigOf(tx) } });
    assert.equal(r2.statusCode, 404);
  });
});
