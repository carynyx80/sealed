import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { PRIVACY_ROUTES, SPR_DERIVE_MESSAGE } from "@sealed/shared";
import { loadConfig } from "../src/config.js";
import { EXPIRY_MARGIN_BLOCKS } from "../src/offchain/custody/payout.js";
import type { ParsedTransaction } from "../src/offchain/custody/rpc.js";
import { REASONS } from "../src/offchain/privacy/service.js";
import { SPR_SOL_MINT, type InboundNote, type RecipientCheck, type SignedPrivateTx, type SprPort } from "../src/offchain/privacy/port.js";
import { buildServer, type App } from "../src/server.js";
import { MockRpc, signIn } from "./custodyHelpers.js";

const ADMIN = "test-admin-token-0123456789abcdef";
const LAMPORTS = 1_000_000_000n;

/** SDK boundary double: no network, records every call. */
class MockPort implements SprPort {
  calls: string[] = [];
  notes: InboundNote[] = [];
  balances = new Map<string, bigint>();
  probeOk = true;
  reg: "registered" | "unregistered" | "mismatch" = "registered";
  registeredRecipients = new Set<string>();
  built: SignedPrivateTx[] = [];
  resets = 0;
  constructor(readonly owner: string) {}
  async init() {
    this.calls.push("init");
  }
  companyIdentity() {
    return { owner: this.owner, shieldedAddressBytes: bs58.encode(Buffer.alloc(99, 7)) };
  }
  async probe() {
    this.calls.push("probe");
    return this.probeOk ? { ok: true } : { ok: false, reason: "privacy program not found" };
  }
  async registration() {
    this.calls.push("registration");
    return this.reg;
  }
  async buildRegistration(): Promise<SignedPrivateTx | null> {
    this.calls.push("buildRegistration");
    return this.reg === "registered" ? null : signedTx(1000);
  }
  async sync() {
    this.calls.push("sync");
  }
  reset() {
    this.resets++;
  }
  inbound() {
    return this.notes;
  }
  balance(mint: string) {
    return this.balances.get(mint) ?? 0n;
  }
  async checkRecipient(r: string): Promise<RecipientCheck> {
    this.calls.push("checkRecipient");
    return this.registeredRecipients.has(r) ? { ok: true, kind: "owner", normalized: r } : { ok: false, reason: "recipient has no registered private address" };
  }
  async buildPrivatePayout(input: { recipient: string; mint: string; amount: bigint }) {
    this.calls.push(`buildPrivatePayout:${input.recipient}:${input.amount}`);
    const t = signedTx(this.height + 150);
    this.built.push(t);
    return t;
  }
  height = 300_000_000;
}

function signedTx(lastValidBlockHeight: number): SignedPrivateTx {
  return { signature: bs58.encode(randomBytes(64)), rawTx: randomBytes(200).toString("base64"), blockhash: bs58.encode(randomBytes(32)), lastValidBlockHeight };
}

function ringTx(signature: string, signers: string[], slot = 1234): ParsedTransaction {
  return {
    slot,
    blockTime: 1_700_000_000,
    meta: { err: null },
    transaction: { signatures: [signature], message: { accountKeys: signers.map((pubkey) => ({ pubkey, signer: true, writable: true })), instructions: [] } },
  };
}

const note = (signature: string, index: bigint, amount: bigint, memo: string | null = null, mint = SPR_SOL_MINT): InboundNote => ({
  signature, slot: 1234n, index, kind: "privateTransfer", mint, amount, memo,
});

async function makeApp(opts: { enabled: boolean; port: MockPort; rpc: MockRpc; company: Keypair; adminToken?: string | undefined; heliusApiKey?: string; fetch?: typeof fetch }): Promise<App> {
  const config = { ...loadConfig({ NODE_ENV: "test" }), isDemo: false, network: "devnet" as const, ...(opts.heliusApiKey ? { heliusApiKey: opts.heliusApiKey } : {}) };
  const app = await buildServer({
    config, logger: false, workers: false,
    custody: { env: {}, rpc: opts.rpc, config: { workers: false, adminToken: opts.adminToken ?? ADMIN, companyWallet: opts.company.publicKey.toBase58(), companySecretKey: bs58.encode(opts.company.secretKey) } },
    privacy: { env: opts.enabled ? { PRIVACY_RING_ENABLED: "true" } : {}, port: opts.port, ...(opts.fetch ? { fetch: opts.fetch } : {}) },
  });
  await app.ready();
  return app;
}
const bal = async (app: App, wallet: string, asset: string) =>
  (await app.ctx.offchain!.ledger.balances(wallet)).find((b) => b.asset === asset) ?? { available: 0n, locked: 0n };
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("privacy ring: flag off (default)", () => {
  let app: App;
  let port: MockPort;
  before(async () => {
    const company = Keypair.generate();
    port = new MockPort(company.publicKey.toBase58());
    app = await makeApp({ enabled: false, port, rpc: new MockRpc(), company });
  });
  after(async () => {
    await app.close();
  });

  it("status reports enabled:false and every new route answers 503 {enabled:false, reason} without touching the SDK", async () => {
    const st = (await app.inject({ method: "GET", url: PRIVACY_ROUTES.status })).json();
    assert.equal(st.enabled, false);
    assert.equal(st.simulated, false);
    assert.equal(st.reason, REASONS.off);
    const { token, wallet } = await signIn(app);
    for (const [method, url, payload] of [
      ["GET", PRIVACY_ROUTES.depositInfo, undefined],
      ["GET", PRIVACY_ROUTES.deposits, undefined],
      ["POST", PRIVACY_ROUTES.claimDeposit, { signature: bs58.encode(randomBytes(64)) }],
      ["POST", PRIVACY_ROUTES.withdrawals, { asset: "SOL", amount: 0.01, destination: wallet, privateTo: wallet }],
    ] as const) {
      const r = await app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });
      assert.equal(r.statusCode, 503, `${url}: ${r.body}`);
      assert.deepEqual(r.json(), { enabled: false, reason: REASONS.off });
    }
    const reg = await app.inject({ method: "POST", url: PRIVACY_ROUTES.adminRegister, headers: { "x-admin-token": ADMIN } });
    assert.equal(reg.statusCode, 503);
    assert.equal(reg.json().enabled, false);
    assert.deepEqual(port.calls, [], "SDK boundary never called while the flag is off");
    assert.equal(SPR_DERIVE_MESSAGE, "TSPP/derive/v1");
  });
});

describe("privacy ring: mainnet guard + registration", () => {
  it("probe failure → disabled with reason; unregistered → disabled until admin registers", async () => {
    const company = Keypair.generate();
    const port = new MockPort(company.publicKey.toBase58());
    port.probeOk = false;
    const rpc = new MockRpc();
    const app = await makeApp({ enabled: true, port, rpc, company });
    try {
      let st = (await app.inject({ method: "GET", url: PRIVACY_ROUTES.status })).json();
      assert.equal(st.enabled, false);
      assert.equal(st.reason, REASONS.unavailable);
      const { token } = await signIn(app);
      assert.equal((await app.inject({ method: "GET", url: PRIVACY_ROUTES.depositInfo, headers: auth(token) })).statusCode, 503);

      port.probeOk = true;
      port.reg = "unregistered";
      await app.privacy.refresh();
      st = (await app.inject({ method: "GET", url: PRIVACY_ROUTES.status })).json();
      assert.equal(st.enabled, false);
      assert.equal(st.companyRegistered, false);
      assert.equal(st.reason, REASONS.unregistered);
      assert.equal(st.companyShieldedAddress, company.publicKey.toBase58());
      assert.ok(!port.calls.includes("buildRegistration"), "never auto-registers on boot");

      // No SOL in the company wallet → 409, nothing built or sent.
      const r409 = await app.inject({ method: "POST", url: PRIVACY_ROUTES.adminRegister, headers: { "x-admin-token": ADMIN } });
      assert.equal(r409.statusCode, 409, r409.body);
      assert.ok(typeof r409.json().requiredSol === "number");
      assert.ok(!port.calls.includes("buildRegistration"));
      assert.equal(rpc.sent.length, 0);
      assert.equal((await app.inject({ method: "POST", url: PRIVACY_ROUTES.adminRegister })).statusCode, 401);

      rpc.balances.set(company.publicKey.toBase58(), LAMPORTS);
      const ok = await app.inject({ method: "POST", url: PRIVACY_ROUTES.adminRegister, headers: { "x-admin-token": ADMIN } });
      assert.equal(ok.statusCode, 202, ok.body);
      assert.equal(rpc.sent.length, 1);
      port.reg = "registered";
      await app.privacy.refresh();
      assert.equal((await app.inject({ method: "GET", url: PRIVACY_ROUTES.status })).json().enabled, true);
      const again = await app.inject({ method: "POST", url: PRIVACY_ROUTES.adminRegister, headers: { "x-admin-token": ADMIN } });
      assert.equal(again.statusCode, 200);
      assert.equal(again.json().alreadyRegistered, true);
    } finally {
      await app.close();
    }
  });
});

describe("privacy ring: private deposits", () => {
  let app: App;
  let port: MockPort;
  let rpc: MockRpc;
  let company: Keypair;
  before(async () => {
    company = Keypair.generate();
    port = new MockPort(company.publicKey.toBase58());
    rpc = new MockRpc();
    app = await makeApp({ enabled: true, port, rpc, company });
  });
  after(async () => {
    await app.close();
  });

  it("deposit-info: company address, stable per-user reference, assets, min amounts", async () => {
    const { token } = await signIn(app);
    const a = (await app.inject({ method: "GET", url: PRIVACY_ROUTES.depositInfo, headers: auth(token) })).json();
    const b = (await app.inject({ method: "GET", url: PRIVACY_ROUTES.depositInfo, headers: auth(token) })).json();
    const acct = (await app.inject({ method: "GET", url: "/api/account", headers: auth(token) })).json();
    assert.equal(a.enabled, true);
    assert.equal(a.companyShieldedAddress, company.publicKey.toBase58());
    assert.equal(a.reference, b.reference);
    assert.equal(a.reference, acct.depositRef);
    assert.deepEqual(a.assets.sort(), ["SOL", "USDC"]);
    assert.equal(a.minAmount.SOL, 0.001);
    assert.equal(a.network, "devnet");
  });

  it("attributes by sender wallet, waits for finality, credits exactly once", async () => {
    const { token, wallet } = await signIn(app);
    const sig = bs58.encode(randomBytes(64));
    port.notes.push(note(sig, 42n, 500_000_000n));
    // Not finalized yet → detected, nothing credited.
    const c1 = (await app.inject({ method: "POST", url: PRIVACY_ROUTES.claimDeposit, headers: auth(token), payload: { signature: sig } })).json();
    assert.equal(c1.status, "detected");
    assert.equal((await bal(app, wallet, "SOL")).available, 0n);
    rpc.txs.set(sig, ringTx(sig, [wallet]));
    const c2 = (await app.inject({ method: "POST", url: PRIVACY_ROUTES.claimDeposit, headers: auth(token), payload: { signature: sig } })).json();
    assert.equal(c2.status, "credited");
    for (let i = 0; i < 3; i++) await app.privacy.scan();
    assert.equal((await bal(app, wallet, "SOL")).available, 500_000_000n, "credited exactly once");
    const list = (await app.inject({ method: "GET", url: PRIVACY_ROUTES.deposits, headers: auth(token) })).json();
    assert.equal(list.deposits.length, 1);
    assert.equal(list.deposits[0].amount, 0.5);
    assert.equal(list.deposits[0].status, "credited");
    assert.equal(list.deposits[0].id, `spr:${sig}:42`);
    // Another user sees nothing of it.
    const other = await signIn(app);
    assert.equal((await app.inject({ method: "GET", url: PRIVACY_ROUTES.deposits, headers: auth(other.token) })).json().deposits.length, 0);
    const c3 = (await app.inject({ method: "POST", url: PRIVACY_ROUTES.claimDeposit, headers: auth(other.token), payload: { signature: sig } })).json();
    assert.equal(c3.status, "rejected");
  });

  it("two outputs in one transaction are two keys; a memo with the user's reference attributes it", async () => {
    const { wallet } = await signIn(app);
    const user = await app.custody.repo.getUser(wallet);
    const sig = bs58.encode(randomBytes(64));
    const stranger = Keypair.generate().publicKey.toBase58();
    port.notes.push(note(sig, 7n, 2_000_000n, `sealed:${user!.depositRef}`, app.privacy.assets().find((a) => a.symbol === "USDC")!.mint!));
    port.notes.push(note(sig, 8n, 3_000_000n, user!.depositRef, app.privacy.assets().find((a) => a.symbol === "USDC")!.mint!));
    rpc.txs.set(sig, ringTx(sig, [stranger]));
    await app.privacy.scan();
    await app.privacy.scan();
    assert.equal((await bal(app, wallet, "USDC")).available, 5_000_000n);
  });

  it("unattributable / unknown reference / below minimum → rejected, never credited", async () => {
    const stranger = Keypair.generate().publicKey.toBase58();
    const s1 = bs58.encode(randomBytes(64));
    const s2 = bs58.encode(randomBytes(64));
    const s3 = bs58.encode(randomBytes(64));
    const { wallet } = await signIn(app);
    port.notes.push(note(s1, 1n, 900_000_000n));
    port.notes.push(note(s2, 2n, 900_000_000n, "nosuchref99"));
    port.notes.push(note(s3, 3n, 10n)); // below 0.001 SOL
    rpc.txs.set(s1, ringTx(s1, [stranger]));
    rpc.txs.set(s2, ringTx(s2, [stranger]));
    rpc.txs.set(s3, ringTx(s3, [wallet]));
    const liabBefore = await app.ctx.offchain!.ledger.liabilities("SOL");
    await app.privacy.scan();
    await app.privacy.scan();
    for (const [s, i] of [[s1, 1], [s2, 2], [s3, 3]] as const) {
      const d = await app.custody.repo.getDeposit(`spr:${s}:${i}`);
      assert.equal(d?.status, "rejected", `spr:${s}:${i}`);
      assert.ok(d?.reason);
    }
    assert.equal((await app.custody.repo.getDeposit(`spr:${s1}:1`))!.wallet, null);
    assert.equal(await app.ctx.offchain!.ledger.liabilities("SOL"), liabBefore, "nothing credited");
    assert.equal((await bal(app, wallet, "SOL")).available, 0n);
  });

  it("transactions signed by the company wallet (top-ups / change) are internal and ignored", async () => {
    const s = bs58.encode(randomBytes(64));
    port.notes.push(note(s, 9n, 5n * LAMPORTS));
    rpc.txs.set(s, ringTx(s, [company.publicKey.toBase58()]));
    await app.privacy.scan();
    assert.equal(await app.custody.repo.getDeposit(`spr:${s}:9`), null);
  });
});

describe("privacy ring: private payouts", () => {
  let app: App;
  let port: MockPort;
  let rpc: MockRpc;
  let company: Keypair;
  const recipient = Keypair.generate().publicKey.toBase58();
  before(async () => {
    company = Keypair.generate();
    port = new MockPort(company.publicKey.toBase58());
    port.registeredRecipients.add(recipient);
    rpc = new MockRpc();
    rpc.balances.set(company.publicKey.toBase58(), 1_000n * LAMPORTS);
    app = await makeApp({ enabled: true, port, rpc, company });
  });
  after(async () => {
    await app.close();
  });

  async function requestPrivate(amount: number, atoms: bigint, to = recipient) {
    const { token, wallet } = await signIn(app);
    await app.ctx.offchain!.ledger.credit(wallet, "SOL", atoms, `test-fund:${wallet}:${atoms}`);
    const r = await app.inject({ method: "POST", url: PRIVACY_ROUTES.withdrawals, headers: auth(token), payload: { asset: "SOL", amount, destination: wallet, privateTo: to } });
    return { r, wallet, token };
  }

  it("rejects unregistered recipients; accepts registered ones with the same limits (queued, funds locked)", async () => {
    const bad = await requestPrivate(0.1, LAMPORTS, Keypair.generate().publicKey.toBase58());
    assert.equal(bad.r.statusCode, 400);
    const big = await requestPrivate(30, 40n * LAMPORTS);
    assert.equal(big.r.statusCode, 201, big.r.body);
    assert.equal(big.r.json().status, "pending_approval", "above auto-approve limit → manual approval like public payouts");
    const { r, wallet } = await requestPrivate(0.1, LAMPORTS);
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().status, "queued");
    assert.equal(r.json().privateTo, recipient);
    assert.equal(r.json().destination, recipient);
    assert.equal((await bal(app, wallet, "SOL")).locked, 100_000_000n);
    // Reject it so later tests start clean.
    await app.inject({ method: "POST", url: "/api/admin/withdrawals", headers: { "x-admin-token": ADMIN }, payload: { id: r.json().id, action: "reject", reason: "test" } });
    await app.inject({ method: "POST", url: "/api/admin/withdrawals", headers: { "x-admin-token": ADMIN }, payload: { id: big.r.json().id, action: "reject", reason: "test" } });
  });

  it("insufficient shielded balance → held with a user-safe reason, nothing built", async () => {
    const { r } = await requestPrivate(0.2, LAMPORTS);
    const id = r.json().id;
    await app.custody.payouts!.tick();
    const w = (await app.custody.repo.getWithdrawal(id))!;
    assert.equal(w.status, "queued");
    assert.equal(w.reason, REASONS.liquidity);
    assert.ok(!/PRIVACY|HELIUS|SECRET|_KEY/.test(w.reason!), "no env names in user-facing reasons");
    assert.ok(!port.calls.some((c) => c.startsWith("buildPrivatePayout")));
    await app.inject({ method: "POST", url: "/api/admin/withdrawals", headers: { "x-admin-token": ADMIN }, payload: { id, action: "reject", reason: "test" } });
  });

  it("persist-before-broadcast, rebroadcast same bytes, one in flight at a time, settle once on finality", async () => {
    port.balances.set(SPR_SOL_MINT, 10n * LAMPORTS);
    const a = await requestPrivate(0.3, LAMPORTS);
    const b = await requestPrivate(0.4, LAMPORTS);
    rpc.sent = [];
    rpc.sendError = new Error("socket hang up");
    await app.custody.payouts!.tick();
    const wa = (await app.custody.repo.getWithdrawal(a.r.json().id))!;
    const wb = (await app.custody.repo.getWithdrawal(b.r.json().id))!;
    assert.equal(wa.status, "sending");
    assert.equal(wa.signature, port.built[0]!.signature);
    assert.equal(wa.rawTx, port.built[0]!.rawTx);
    assert.equal(wb.status, "queued", "second private payout waits for the first");
    assert.equal(port.built.length, 1);
    rpc.sendError = null;
    await app.custody.payouts!.tick(); // not found + blockhash valid → same bytes again, no rebuild
    assert.equal(port.built.length, 1);
    assert.ok(rpc.sent.length >= 2 && rpc.sent.every((s) => s === wa.rawTx));
    rpc.statuses.set(wa.signature!, { slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" });
    await app.custody.payouts!.tick();
    assert.equal((await app.custody.repo.getWithdrawal(wa.id))!.status, "sent");
    const ba = await bal(app, a.wallet, "SOL");
    assert.equal(ba.locked, 0n);
    assert.equal(ba.available, 700_000_000n);
    assert.equal((await app.custody.repo.getWithdrawal(wb.id))!.status, "sending", "next private payout goes once the first finalized");
    assert.equal(port.built.length, 2);
    // Idempotent settle: another tick does not double-settle.
    await app.custody.payouts!.tick();
    assert.equal((await bal(app, a.wallet, "SOL")).available, 700_000_000n);

    // On-chain failure → failed + unlocked + wallet state reset.
    const resets = port.resets;
    rpc.statuses.set(port.built[1]!.signature, { slot: 1, confirmations: null, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "finalized" });
    await app.custody.payouts!.tick();
    assert.equal((await app.custody.repo.getWithdrawal(wb.id))!.status, "failed");
    const bb = await bal(app, b.wallet, "SOL");
    assert.equal(bb.available, LAMPORTS);
    assert.equal(bb.locked, 0n);
    assert.ok(port.resets > resets);
  });

  it("expired unlanded tx → re-queued and rebuilt with a new signature", async () => {
    const { r } = await requestPrivate(0.1, LAMPORTS);
    const id = r.json().id;
    await app.custody.payouts!.tick();
    const w1 = (await app.custody.repo.getWithdrawal(id))!;
    assert.equal(w1.status, "sending");
    rpc.blockHeight = w1.lastValidBlockHeight! + EXPIRY_MARGIN_BLOCKS + 1;
    port.height = rpc.blockHeight; // fresh blockhash for the rebuild
    const resets = port.resets;
    await app.custody.payouts!.tick(); // reconcile → re-queue (+ wallet reset) → rebuilt in the same tick
    assert.ok(port.resets > resets);
    const w2 = (await app.custody.repo.getWithdrawal(id))!;
    assert.equal(w2.status, "sending");
    assert.equal(w2.attempts, 2);
    assert.notEqual(w2.signature, w1.signature);
  });
});

describe("privacy ring: keyed SPR passthrough (/api/privacy/spr/*)", () => {
  const KEY = "helius-test-key-abcdef123456";
  type Seen = { url: string; method: string; headers: Record<string, string>; body: Buffer | null };
  const seen: Seen[] = [];
  let next: () => Response = () => new Response(JSON.stringify({ jsonrpc: "2.0", result: { ok: true } }), { status: 200, headers: { "content-type": "application/json", "spr-tee": "1" } });
  const upstream = (async (input: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const headers: Record<string, string> = {};
    h.forEach((v, k) => (headers[k] = v));
    seen.push({ url: String(input), method: init?.method ?? "GET", headers, body: init?.body ? Buffer.from(init.body as Uint8Array) : null });
    return next();
  }) as typeof fetch;
  let app: App;
  let off: App;
  before(async () => {
    const company = Keypair.generate();
    app = await makeApp({ enabled: true, port: new MockPort(company.publicKey.toBase58()), rpc: new MockRpc(), company, heliusApiKey: KEY, fetch: upstream });
    off = await makeApp({ enabled: false, port: new MockPort(company.publicKey.toBase58()), rpc: new MockRpc(), company, heliusApiKey: KEY, fetch: upstream });
  });
  after(async () => {
    await app.close();
    await off.close();
  });

  it("503 {enabled:false} when the flag is off (upstream never called)", async () => {
    const r = await off.inject({ method: "POST", url: `${PRIVACY_ROUTES.spr}/getUserRecords`, headers: { "content-type": "application/json" }, payload: "{}" });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().enabled, false);
    assert.equal(seen.length, 0);
  });

  it("maps path + query, injects the key server-side, pipes body and TEE headers unchanged", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getShieldedTransactionsByTags", params: { tags: ["x"] } });
    const r = await app.inject({
      method: "POST",
      url: `${PRIVACY_ROUTES.spr}/getShieldedTransactionsByTags?foo=1&api-key=client-supplied`,
      headers: { "content-type": "application/json", "spr-tee": "1", "spr-tee-enc": "abcd", cookie: "nope=1" },
      payload: body,
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { jsonrpc: "2.0", result: { ok: true } });
    assert.equal(r.headers["spr-tee"], "1");
    assert.match(String(r.headers["access-control-expose-headers"]), /Spr-Tee/);
    const u = new URL(seen.at(-1)!.url);
    assert.equal(u.origin + u.pathname, "https://devnet.helius-rpc.com/v1/spr/getShieldedTransactionsByTags");
    assert.equal(u.searchParams.get("foo"), "1");
    assert.deepEqual(u.searchParams.getAll("api-key"), [KEY]);
    assert.equal(seen.at(-1)!.body!.toString(), body);
    assert.equal(seen.at(-1)!.headers["spr-tee-enc"], "abcd");
    assert.equal(seen.at(-1)!.headers.cookie, undefined);
    assert.ok(!r.body.includes(KEY));

    const bin = randomBytes(1500);
    await app.inject({ method: "POST", url: `${PRIVACY_ROUTES.spr}/prove/transfer-2x2`, headers: { "content-type": "application/octet-stream" }, payload: bin });
    assert.ok(seen.at(-1)!.body!.equals(bin), "binary proof bodies are piped byte-for-byte");
    const g = await app.inject({ method: "GET", url: `${PRIVACY_ROUTES.spr}/prove/transfer-2x2/status?id=7` });
    assert.equal(g.statusCode, 200);
    assert.equal(new URL(seen.at(-1)!.url).pathname, "/v1/spr/prove/transfer-2x2/status");
  });

  it("scrubs the key from upstream errors; rejects traversal", async () => {
    next = () => new Response(`upstream failed for https://devnet.helius-rpc.com/v1/spr/x?api-key=${KEY} (${KEY})`, { status: 500 });
    const r = await app.inject({ method: "POST", url: `${PRIVACY_ROUTES.spr}/getUserRecords`, headers: { "content-type": "application/json" }, payload: "{}" });
    assert.equal(r.statusCode, 500);
    assert.ok(!r.body.includes(KEY), r.body);
    next = () => { throw new Error(`connect ECONNREFUSED https://devnet.helius-rpc.com/?api-key=${KEY}`); };
    const r2 = await app.inject({ method: "POST", url: `${PRIVACY_ROUTES.spr}/getUserRecords`, headers: { "content-type": "application/json" }, payload: "{}" });
    assert.equal(r2.statusCode, 502);
    assert.ok(!r2.body.includes(KEY));
    const t = await app.inject({ method: "GET", url: `${PRIVACY_ROUTES.spr}/a/../../secret` });
    assert.equal(t.statusCode === 400 || t.statusCode === 404, true);
    next = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });

  it("rate limits proofs per IP (10/min)", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await app.inject({ method: "POST", url: `${PRIVACY_ROUTES.spr}/prove/k`, remoteAddress: "10.9.9.9", headers: { "content-type": "application/octet-stream" }, payload: Buffer.alloc(8) });
      codes.push(r.statusCode);
    }
    assert.ok(codes.slice(0, 10).every((c) => c === 200), codes.join(","));
    assert.equal(codes.at(-1), 429);
  });

  it("status and deposit-info expose companyShieldedAddressBytes", async () => {
    const st = app.privacy.statusFields();
    assert.ok(st.companyShieldedAddressBytes && bs58.decode(st.companyShieldedAddressBytes).length === 99);
    const { token } = await signIn(app);
    const info = (await app.inject({ method: "GET", url: PRIVACY_ROUTES.depositInfo, headers: auth(token) })).json();
    assert.equal(info.companyShieldedAddressBytes, st.companyShieldedAddressBytes);
  });
});
