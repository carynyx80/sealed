import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { COMPANY_WALLET, QUOTE_ASSETS } from "@sealed/shared";
import { ata } from "../src/offchain/custody/chain.js";

const USDC_DEVNET = QUOTE_ASSETS.USDC.mints.devnet!;
import { loadCompanySigner, MAX_PAYOUT_ATTEMPTS, EXPIRY_MARGIN_BLOCKS } from "../src/offchain/custody/payout.js";
import type { App } from "../src/server.js";
import { MockRpc, makeCustodyApp, signIn } from "./custodyHelpers.js";

const ADMIN = "test-admin-token-0123456789abcdef";

async function fund(app: App, wallet: string, asset: string, atoms: bigint) {
  await app.ctx.offchain!.ledger.credit(wallet, asset, atoms, `test-fund:${wallet}:${asset}:${atoms}`);
}
const bal = async (app: App, wallet: string, asset: string) =>
  (await app.ctx.offchain!.ledger.balances(wallet)).find((b) => b.asset === asset) ?? { available: 0n, locked: 0n };

describe("company signer", () => {
  it("missing key → payouts disabled; mismatched key → refused without leaking it", () => {
    assert.equal(loadCompanySigner(undefined, COMPANY_WALLET).payoutsEnabled, false);
    const kp = Keypair.generate();
    const secret = bs58.encode(kp.secretKey);
    const logs: string[] = [];
    const log = { error: (...a: unknown[]) => logs.push(JSON.stringify(a)), warn() {}, info() {} } as never;
    const r = loadCompanySigner(secret, COMPANY_WALLET, log);
    assert.equal(r.payoutsEnabled, false);
    assert.match(r.reason!, /does not match/);
    assert.ok(!logs.join("").includes(secret));
    assert.equal(loadCompanySigner(JSON.stringify([...kp.secretKey]), kp.publicKey.toBase58()).payoutsEnabled, true);
    assert.equal(loadCompanySigner("garbage", COMPANY_WALLET).payoutsEnabled, false);
  });
});

describe("withdrawals without COMPANY_WALLET_SECRET_KEY", () => {
  let app: App;
  before(async () => {
    app = await makeCustodyApp({ adminToken: ADMIN });
  });
  after(async () => {
    await app.close();
  });

  it("custody info reports payouts disabled + proof of reserves", async () => {
    const info = (await app.inject({ method: "GET", url: "/api/custody/info" })).json();
    assert.equal(info.payoutsEnabled, false);
    assert.equal(info.companyWallet, COMPANY_WALLET);
    assert.equal(info.mode, "offchain");
    assert.ok(info.proofOfReserves.some((r: { asset: string }) => r.asset === "SOL"));
  });

  it("small withdrawal is queued and stays queued; funds locked", async () => {
    const { token, wallet } = await signIn(app);
    await fund(app, wallet, "USDC", 1_000_000_000n);
    const h = { authorization: `Bearer ${token}` };
    const r = await app.inject({ method: "POST", url: "/api/account/withdrawals", headers: h, payload: { asset: "USDC", amount: 100, destination: wallet } });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().status, "queued");
    const b = await bal(app, wallet, "USDC");
    assert.equal(b.available, 900_000_000n);
    assert.equal(b.locked, 100_000_000n);
    assert.equal(app.custody.payouts, null);
    const list = (await app.inject({ method: "GET", url: "/api/account/withdrawals", headers: h })).json();
    assert.equal(list.withdrawals[0].status, "queued");
  });

  it("limits: above auto-approve or daily cap → pending_approval", async () => {
    const { token, wallet } = await signIn(app);
    await fund(app, wallet, "USDC", 40_000_000_000n);
    const h = { authorization: `Bearer ${token}` };
    const big = await app.inject({ method: "POST", url: "/api/account/withdrawals", headers: h, payload: { asset: "USDC", amount: 3000, destination: wallet } });
    assert.equal(big.json().status, "pending_approval");
    const statuses: string[] = [];
    for (let i = 0; i < 9; i++) {
      const r = await app.inject({ method: "POST", url: "/api/account/withdrawals", headers: h, payload: { asset: "USDC", amount: 2500, destination: wallet } });
      statuses.push(r.json().status);
    }
    // 3000 + 8×2500 = 23,000 ≤ 25k; the 9th pushes over the daily cap (10 requests = per-wallet rate limit).
    assert.deepEqual(statuses.slice(0, 8), Array(8).fill("queued"));
    assert.equal(statuses[8], "pending_approval");
  });

  it("validation: insufficient funds, bad destination, unsupported asset", async () => {
    const { token, wallet } = await signIn(app);
    const h = { authorization: `Bearer ${token}` };
    const post = (payload: object) => app.inject({ method: "POST", url: "/api/account/withdrawals", headers: h, payload });
    assert.equal((await post({ asset: "SOL", amount: 1, destination: wallet })).statusCode, 400);
    assert.equal((await post({ asset: "SOL", amount: 1, destination: "11111111111111111111111111111111" })).statusCode, 400);
    assert.equal((await post({ asset: "SOL", amount: 1, destination: COMPANY_WALLET })).statusCode, 400);
    assert.equal((await post({ asset: "NVDAx", amount: 1, destination: wallet })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/account/withdrawals", payload: { asset: "SOL", amount: 1, destination: wallet } })).statusCode, 401);
  });

  it("admin auth + approve / reject unlocks funds", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/api/admin/withdrawals" })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/admin/withdrawals", headers: { "x-admin-token": "wrong" } })).statusCode, 401);
    const { token, wallet } = await signIn(app);
    await fund(app, wallet, "USDC", 10_000_000_000n);
    const h = { authorization: `Bearer ${token}` };
    const a = (await app.inject({ method: "POST", url: "/api/account/withdrawals", headers: h, payload: { asset: "USDC", amount: 5000, destination: wallet } })).json();
    const b = (await app.inject({ method: "POST", url: "/api/account/withdrawals", headers: h, payload: { asset: "USDC", amount: 4000, destination: wallet } })).json();
    const ah = { "x-admin-token": ADMIN };
    const list = (await app.inject({ method: "GET", url: "/api/admin/withdrawals?status=pending_approval", headers: ah })).json();
    assert.ok(list.withdrawals.some((w: { id: string }) => w.id === a.id));
    const ap = await app.inject({ method: "POST", url: "/api/admin/withdrawals", headers: ah, payload: { id: a.id, action: "approve" } });
    assert.equal(ap.json().status, "queued");
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/withdrawals", headers: ah, payload: { id: a.id, action: "approve" } })).statusCode, 409);
    const rj = await app.inject({ method: "POST", url: "/api/admin/withdrawals", headers: ah, payload: { id: b.id, action: "reject", reason: "kyc" } });
    assert.equal(rj.json().status, "rejected");
    const after = await bal(app, wallet, "USDC");
    assert.equal(after.available, 5_000_000_000n);
    assert.equal(after.locked, 5_000_000_000n);
  });

  it("credit-pool seed is admin-only and idempotent on reference", async () => {
    const body = { asset: "USDC", amount: 1000, reference: "ops-ticket-42" };
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/credit-pool/seed", payload: body })).statusCode, 401);
    const before = await app.ctx.offchain!.ledger.liabilities("USDC");
    const r1 = await app.inject({ method: "POST", url: "/api/admin/credit-pool/seed", headers: { "x-admin-token": ADMIN }, payload: body });
    assert.equal(r1.statusCode, 200, r1.body);
    const r2 = await app.inject({ method: "POST", url: "/api/admin/credit-pool/seed", headers: { "x-admin-token": ADMIN }, payload: body });
    assert.equal(r2.json().replayed, true);
    assert.equal(await app.ctx.offchain!.ledger.liabilities("USDC"), before + 1_000_000_000n);
    assert.equal(await app.ctx.offchain!.ledger.balanceOf("system", "USDC", "credit_pool"), 1_000_000_000n);
  });
});

describe("admin disabled without ADMIN_TOKEN", () => {
  it("503", async () => {
    const app = await makeCustodyApp({ adminToken: undefined });
    assert.equal((await app.inject({ method: "GET", url: "/api/admin/withdrawals", headers: { "x-admin-token": "x" } })).statusCode, 503);
    await app.close();
  });
});

describe("PayoutWorker (idempotent sends)", () => {
  const company = Keypair.generate();
  let app: App;
  let rpc: MockRpc;
  before(async () => {
    rpc = new MockRpc();
    // Company wallet funded: 1000 SOL (fees come from the surplus over SOL liabilities) + USDC in its ATA.
    rpc.balances.set(company.publicKey.toBase58(), 1_000_000_000_000n);
    rpc.balances.set(ata(company.publicKey, USDC_DEVNET).toBase58(), 1_000_000_000_000n);
    app = await makeCustodyApp({ adminToken: ADMIN, companyWallet: company.publicKey.toBase58(), companySecretKey: bs58.encode(company.secretKey) }, rpc);
  });
  after(async () => {
    await app.close();
  });

  async function request(asset: "SOL" | "USDC", amount: number, atoms: bigint) {
    const { token, wallet } = await signIn(app);
    await fund(app, wallet, asset, atoms);
    const r = await app.inject({ method: "POST", url: "/api/account/withdrawals", headers: { authorization: `Bearer ${token}` }, payload: { asset, amount, destination: wallet } });
    assert.equal(r.statusCode, 201, r.body);
    return { id: r.json().id as string, wallet };
  }

  it("payouts enabled when key matches", async () => {
    assert.ok(app.custody.payouts);
    assert.equal((await app.inject({ method: "GET", url: "/api/custody/info" })).json().payoutsEnabled, true);
  });

  it("send error → reconcile by signature, rebroadcast same bytes, settle once on finality", async () => {
    const { id, wallet } = await request("SOL", 0.5, 1_000_000_000n);
    rpc.sendError = new Error("socket hang up");
    await app.custody.payouts!.tick();
    let w = (await app.custody.repo.getWithdrawal(id))!;
    assert.equal(w.status, "sending");
    const sig = w.signature!;
    const raw = w.rawTx!;
    rpc.sendError = null;
    await app.custody.payouts!.tick(); // not found, blockhash valid → rebroadcast identical tx
    w = (await app.custody.repo.getWithdrawal(id))!;
    assert.equal(w.signature, sig);
    assert.ok(rpc.sent.length >= 2 && rpc.sent.every((s) => s === raw), "only the same signed bytes were ever sent");
    rpc.statuses.set(sig, { slot: 1, confirmations: 3, err: null, confirmationStatus: "confirmed" });
    await app.custody.payouts!.tick();
    assert.equal((await app.custody.repo.getWithdrawal(id))!.status, "sending", "waits for finality");
    rpc.statuses.set(sig, { slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" });
    await app.custody.payouts!.tick();
    await app.custody.payouts!.tick();
    w = (await app.custody.repo.getWithdrawal(id))!;
    assert.equal(w.status, "sent");
    const b = await bal(app, wallet, "SOL");
    assert.equal(b.available, 500_000_000n);
    assert.equal(b.locked, 0n);
    const dto = (await app.inject({ method: "GET", url: "/api/admin/withdrawals?status=sent", headers: { "x-admin-token": ADMIN } })).json();
    assert.equal(dto.withdrawals.find((x: { id: string }) => x.id === id).signature, sig);
  });

  it("expired blockhash → re-queued with a new tx; after max attempts → failed + unlocked", async () => {
    rpc.sent = [];
    const { id, wallet } = await request("USDC", 10, 10_000_000n);
    const seen = new Set<string>();
    for (let attempt = 1; attempt <= MAX_PAYOUT_ATTEMPTS; attempt++) {
      await app.custody.payouts!.tick(); // send
      const w = (await app.custody.repo.getWithdrawal(id))!;
      assert.equal(w.status, "sending");
      assert.equal(w.attempts, attempt);
      assert.ok(!seen.has(w.signature!), "new signature per attempt (old blockhash expired)");
      seen.add(w.signature!);
      rpc.blockHeight = w.lastValidBlockHeight! + EXPIRY_MARGIN_BLOCKS + 1; // can never land now
      await app.custody.payouts!.tick(); // reconcile → requeue or fail
    }
    const w = (await app.custody.repo.getWithdrawal(id))!;
    assert.equal(w.status, "failed");
    const b = await bal(app, wallet, "USDC");
    assert.equal(b.available, 10_000_000n);
    assert.equal(b.locked, 0n);
  });

  it("on-chain error → failed + unlocked", async () => {
    const { id, wallet } = await request("SOL", 0.1, 100_000_000n);
    await app.custody.payouts!.tick();
    const w = (await app.custody.repo.getWithdrawal(id))!;
    rpc.statuses.set(w.signature!, { slot: 1, confirmations: null, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "finalized" });
    await app.custody.payouts!.tick();
    assert.equal((await app.custody.repo.getWithdrawal(id))!.status, "failed");
    assert.equal((await bal(app, wallet, "SOL")).available, 100_000_000n);
  });

  it("pending_approval is never sent until approved", async () => {
    const { id } = await request("USDC", 3000, 3_000_000_000n);
    await app.custody.payouts!.tick();
    assert.equal((await app.custody.repo.getWithdrawal(id))!.status, "pending_approval");
    await app.inject({ method: "POST", url: "/api/admin/withdrawals", headers: { "x-admin-token": ADMIN }, payload: { id, action: "approve" } });
    await app.custody.payouts!.tick();
    assert.equal((await app.custody.repo.getWithdrawal(id))!.status, "sending");
  });
});
