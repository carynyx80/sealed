import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { PRIVACY_ROUTES, privacyLinkMessage } from "@sealed/shared";
import { loadConfig } from "../src/config.js";
import type { ParsedTransaction } from "../src/offchain/custody/rpc.js";
import { SPR_SOL_MINT, type InboundNote, type RecipientCheck, type SignedPrivateTx, type SprPort } from "../src/offchain/privacy/port.js";
import { buildServer, type App } from "../src/server.js";
import { MockRpc, signIn } from "./custodyHelpers.js";

const ADMIN = "test-admin-token-0123456789abcdef";
const LAMPORTS = 1_000_000_000n;

/** SDK boundary double (no network). */
class MockPort implements SprPort {
  notes: InboundNote[] = [];
  registeredRecipients = new Set<string>();
  constructor(readonly owner: string) {}
  async init() {}
  companyIdentity() {
    return { owner: this.owner, shieldedAddressBytes: bs58.encode(Buffer.alloc(99, 7)) };
  }
  async probe() {
    return { ok: true };
  }
  async registration() {
    return "registered" as const;
  }
  async buildRegistration(): Promise<SignedPrivateTx | null> {
    return null;
  }
  async sync() {}
  reset() {}
  inbound() {
    return this.notes;
  }
  balance() {
    return 0n;
  }
  async checkRecipient(r: string): Promise<RecipientCheck> {
    return this.registeredRecipients.has(r) ? { ok: true, kind: "owner", normalized: r } : { ok: false, reason: "recipient has no registered private address" };
  }
  async buildPrivatePayout(): Promise<SignedPrivateTx> {
    throw new Error("not used");
  }
}

const ringTx = (signature: string, signers: string[]): ParsedTransaction => ({
  slot: 1234,
  blockTime: 1_700_000_000,
  meta: { err: null },
  transaction: { signatures: [signature], message: { accountKeys: signers.map((pubkey) => ({ pubkey, signer: true, writable: true })), instructions: [] } },
});
const note = (signature: string, index: bigint, amount: bigint): InboundNote => ({ signature, slot: 1234n, index, kind: "privateTransfer", mint: SPR_SOL_MINT, amount, memo: null });
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const sigOf = () => bs58.encode(randomBytes(64));
/** Burner signs the domain-bound link message (raw ed25519 over UTF-8). */
const linkSig = (burner: Keypair, wallet: string, signedBurner = burner.publicKey.toBase58()) =>
  bs58.encode(nacl.sign.detached(new TextEncoder().encode(privacyLinkMessage(wallet, signedBurner)), burner.secretKey));

describe("privacy link: private Sealed wallet (burner)", () => {
  let app: App;
  let port: MockPort;
  let rpc: MockRpc;
  let company: Keypair;
  before(async () => {
    company = Keypair.generate();
    port = new MockPort(company.publicKey.toBase58());
    rpc = new MockRpc();
    const config = { ...loadConfig({ NODE_ENV: "test" }), isDemo: false, network: "devnet" as const };
    app = await buildServer({
      config, logger: false, workers: false,
      custody: { env: {}, rpc, config: { workers: false, adminToken: ADMIN, companyWallet: company.publicKey.toBase58(), companySecretKey: bs58.encode(company.secretKey) } },
      privacy: { env: { PRIVACY_RING_ENABLED: "true" }, port },
    });
    await app.ready();
  });
  after(async () => {
    await app.close();
  });

  const link = (token: string, payload: unknown) => app.inject({ method: "POST", url: PRIVACY_ROUTES.link, headers: auth(token), payload: payload as Record<string, unknown> });
  const status = async (token: string) => (await app.inject({ method: "GET", url: PRIVACY_ROUTES.link, headers: auth(token) })).json();
  const bal = async (wallet: string) => (await app.ctx.offchain!.ledger.balances(wallet)).find((b) => b.asset === "SOL")?.available ?? 0n;

  it("happy path: link, GET status, deposit-info exposes linkedBurner + linkMessage; requires auth", async () => {
    const { token, wallet } = await signIn(app);
    const burner = Keypair.generate();
    assert.equal((await app.inject({ method: "POST", url: PRIVACY_ROUTES.link, payload: {} })).statusCode, 401);
    assert.deepEqual(await status(token), { burner: null });
    let info = (await app.inject({ method: "GET", url: PRIVACY_ROUTES.depositInfo, headers: auth(token) })).json();
    assert.equal(info.linkedBurner, null);
    assert.equal(info.linkMessage, `sealed-privacy-link:v1:${wallet}:{burner}`);
    const r = await link(token, { burner: burner.publicKey.toBase58(), signature: linkSig(burner, wallet) });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { linked: true, burner: burner.publicKey.toBase58() });
    const st = await status(token);
    assert.equal(st.burner, burner.publicKey.toBase58());
    assert.equal(typeof st.linkedAt, "number");
    info = (await app.inject({ method: "GET", url: PRIVACY_ROUTES.depositInfo, headers: auth(token) })).json();
    assert.equal(info.linkedBurner, burner.publicKey.toBase58());
  });

  it("bad signature / wrong message / session wallet / company wallet → 400 with code", async () => {
    const { token, wallet, kp } = await signIn(app);
    const burner = Keypair.generate();
    const other = Keypair.generate();
    const b58 = burner.publicKey.toBase58();
    // Signed by someone else.
    let r = await link(token, { burner: b58, signature: linkSig(other, wallet, b58) });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().code, "invalid_signature");
    // Burner signature bound to another session wallet (replay across accounts).
    r = await link(token, { burner: b58, signature: linkSig(burner, Keypair.generate().publicKey.toBase58()) });
    assert.equal(r.json().code, "invalid_signature");
    // Garbage.
    r = await link(token, { burner: b58, signature: "x" });
    assert.equal(r.statusCode, 400);
    r = await link(token, { burner: wallet, signature: linkSig(kp, wallet) });
    assert.equal(r.json().code, "burner_is_session_wallet");
    r = await link(token, { burner: company.publicKey.toBase58(), signature: linkSig(company, wallet) });
    assert.equal(r.json().code, "burner_is_company");
    assert.deepEqual(await status(token), { burner: null });
  });

  it("burner_taken: a burner active on another account (or a Sealed sign-in wallet) cannot be linked", async () => {
    const a = await signIn(app);
    const b = await signIn(app);
    const burner = Keypair.generate();
    assert.equal((await link(a.token, { burner: burner.publicKey.toBase58(), signature: linkSig(burner, a.wallet) })).statusCode, 200);
    const r = await link(b.token, { burner: burner.publicKey.toBase58(), signature: linkSig(burner, b.wallet) });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, "burner_taken");
    // Another account's sign-in wallet as burner.
    const c = await signIn(app);
    const r2 = await link(b.token, { burner: c.wallet, signature: linkSig(c.kp, b.wallet) });
    assert.equal(r2.statusCode, 409);
    assert.equal(r2.json().code, "burner_taken");
    assert.equal((await status(b.token)).burner, null);
  });

  it("idempotent re-link; replace keeps history and frees the old burner; delete unlinks", async () => {
    const { token, wallet } = await signIn(app);
    const b1 = Keypair.generate();
    const b2 = Keypair.generate();
    const p1 = { burner: b1.publicKey.toBase58(), signature: linkSig(b1, wallet) };
    assert.equal((await link(token, p1)).statusCode, 200);
    const first = await status(token);
    const again = await link(token, p1);
    assert.equal(again.statusCode, 200);
    assert.deepEqual(again.json(), { linked: true, burner: b1.publicKey.toBase58() });
    assert.deepEqual(await status(token), first, "same link row (linkedAt unchanged)");

    assert.equal((await link(token, { burner: b2.publicKey.toBase58(), signature: linkSig(b2, wallet) })).statusCode, 200);
    assert.equal((await status(token)).burner, b2.publicKey.toBase58());
    assert.equal(await app.custody.repo.getActivePrivacyLinkByBurner(b1.publicKey.toBase58()), null, "old burner inactive");
    // The freed old burner can be linked by another account.
    const other = await signIn(app);
    assert.equal((await link(other.token, { burner: b1.publicKey.toBase58(), signature: linkSig(b1, other.wallet) })).statusCode, 200);

    const d = await app.inject({ method: "DELETE", url: PRIVACY_ROUTES.link, headers: auth(token) });
    assert.equal(d.statusCode, 200);
    assert.deepEqual(d.json(), { linked: false });
    assert.deepEqual(await status(token), { burner: null });
    assert.equal(await app.custody.repo.getActivePrivacyLinkByBurner(b2.publicKey.toBase58()), null);
    // Deleting again is harmless.
    assert.deepEqual((await app.inject({ method: "DELETE", url: PRIVACY_ROUTES.link, headers: auth(token) })).json(), { linked: false });
  });

  it("deposit signed by a linked burner is credited to that account exactly once; conflicts are rejected", async () => {
    const { token, wallet } = await signIn(app);
    const burner = Keypair.generate();
    assert.equal((await link(token, { burner: burner.publicKey.toBase58(), signature: linkSig(burner, wallet) })).statusCode, 200);
    const sig = sigOf();
    port.notes.push(note(sig, 3n, 250_000_000n));
    // Not finalized → nothing credited.
    await app.privacy.scan();
    assert.equal(await bal(wallet), 0n);
    rpc.txs.set(sig, ringTx(sig, [burner.publicKey.toBase58()]));
    const c = (await app.inject({ method: "POST", url: PRIVACY_ROUTES.claimDeposit, headers: auth(token), payload: { signature: sig } })).json();
    assert.equal(c.status, "credited");
    for (let i = 0; i < 3; i++) await app.privacy.scan();
    assert.equal(await bal(wallet), 250_000_000n, "credited exactly once");
    const row = await app.custody.repo.getDeposit(`spr:${sig}:3`);
    assert.equal(row!.wallet, wallet);
    assert.equal(row!.status, "credited");

    // Burner + another account's sign-in wallet both sign → two accounts → rejected, nobody credited.
    const other = await signIn(app);
    const s2 = sigOf();
    port.notes.push(note(s2, 1n, 100_000_000n));
    rpc.txs.set(s2, ringTx(s2, [burner.publicKey.toBase58(), other.wallet]));
    await app.privacy.scan();
    const r2 = await app.custody.repo.getDeposit(`spr:${s2}:1`);
    assert.equal(r2!.status, "rejected");
    assert.equal(await bal(wallet), 250_000_000n);
    assert.equal(await bal(other.wallet), 0n);
  });

  it("after replace, the old burner no longer attributes; the new one does", async () => {
    const { token, wallet } = await signIn(app);
    const oldB = Keypair.generate();
    const newB = Keypair.generate();
    await link(token, { burner: oldB.publicKey.toBase58(), signature: linkSig(oldB, wallet) });
    await link(token, { burner: newB.publicKey.toBase58(), signature: linkSig(newB, wallet) });
    const sOld = sigOf();
    const sNew = sigOf();
    port.notes.push(note(sOld, 1n, 10_000_000n), note(sNew, 1n, 20_000_000n));
    rpc.txs.set(sOld, ringTx(sOld, [oldB.publicKey.toBase58()]));
    rpc.txs.set(sNew, ringTx(sNew, [newB.publicKey.toBase58()]));
    await app.privacy.scan();
    const rOld = await app.custody.repo.getDeposit(`spr:${sOld}:1`);
    assert.equal(rOld!.status, "rejected");
    assert.equal(rOld!.wallet, null);
    assert.equal((await app.custody.repo.getDeposit(`spr:${sNew}:1`))!.status, "credited");
    assert.equal(await bal(wallet), 20_000_000n);
  });

  it('privateTo "linked" resolves to the registered linked burner; 400 no_linked_burner otherwise', async () => {
    const { token, wallet } = await signIn(app);
    await app.ctx.offchain!.ledger.credit(wallet, "SOL", LAMPORTS, `test-fund:${wallet}`);
    const withdraw = () => app.inject({ method: "POST", url: PRIVACY_ROUTES.withdrawals, headers: auth(token), payload: { asset: "SOL", amount: 0.1, destination: wallet, privateTo: "linked" } });
    let r = await withdraw();
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().code, "no_linked_burner");
    const burner = Keypair.generate();
    await link(token, { burner: burner.publicKey.toBase58(), signature: linkSig(burner, wallet) });
    r = await withdraw();
    assert.equal(r.statusCode, 400, "linked but not registered on the ring");
    assert.equal(r.json().code, "no_linked_burner");
    port.registeredRecipients.add(burner.publicKey.toBase58());
    r = await withdraw();
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().privateTo, burner.publicKey.toBase58());
    assert.equal(r.json().destination, burner.publicKey.toBase58());
    await app.inject({ method: "POST", url: "/api/admin/withdrawals", headers: { "x-admin-token": ADMIN }, payload: { id: r.json().id, action: "reject", reason: "test" } });
  });

  it("rate limits link requests per account", async () => {
    const { token, wallet } = await signIn(app);
    const burner = Keypair.generate();
    const p = { burner: burner.publicKey.toBase58(), signature: linkSig(burner, wallet) };
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await link(token, p)).statusCode);
    assert.ok(codes.includes(429));
    assert.equal(codes[0], 200);
  });
});

describe("privacy link: flag off", () => {
  it("link routes answer 503 {enabled:false}", async () => {
    const company = Keypair.generate();
    const config = { ...loadConfig({ NODE_ENV: "test" }), isDemo: false, network: "devnet" as const };
    const app = await buildServer({
      config, logger: false, workers: false,
      custody: { env: {}, rpc: new MockRpc(), config: { workers: false, adminToken: ADMIN, companyWallet: company.publicKey.toBase58(), companySecretKey: bs58.encode(company.secretKey) } },
      privacy: { env: {}, port: new MockPort(company.publicKey.toBase58()) },
    });
    await app.ready();
    try {
      const { token } = await signIn(app);
      for (const method of ["GET", "POST", "DELETE"] as const) {
        const r = await app.inject({ method, url: PRIVACY_ROUTES.link, headers: auth(token), ...(method === "POST" ? { payload: {} } : {}) });
        assert.equal(r.statusCode, 503);
        assert.equal(r.json().enabled, false);
      }
    } finally {
      await app.close();
    }
  });
});
