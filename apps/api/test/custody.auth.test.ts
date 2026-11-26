import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { SIWS_STATEMENT } from "@sealed/shared";
import { AuthService, NONCE_TTL_MS, SESSION_TTL_MS, sha256Hex } from "../src/offchain/auth/siws.js";
import { MemoryCustodyRepo } from "../src/offchain/custody/repo.js";
import type { App } from "../src/server.js";
import { makeCustodyApp, signIn } from "./custodyHelpers.js";

const sign = (msg: string, kp: Keypair) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey));

describe("SIWS AuthService", () => {
  it("happy path: message contents, session token stored only as hash, 7d expiry", async () => {
    const repo = new MemoryCustodyRepo();
    const t0 = new Date("2026-11-26T12:00:00Z");
    const auth = new AuthService(repo, "sealed.test", () => t0);
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const n = await auth.issueNonce(wallet);
    for (const part of [SIWS_STATEMENT, "sealed.test", wallet, n.nonce, t0.toISOString(), new Date(t0.getTime() + NONCE_TTL_MS).toISOString()]) {
      assert.ok(n.message.includes(part), `message contains ${part}`);
    }
    const out = await auth.verify(wallet, n.nonce, sign(n.message, kp));
    assert.equal(out.wallet, wallet);
    assert.equal(out.expiresTs, Math.floor((t0.getTime() + SESSION_TTL_MS) / 1000));
    assert.equal(bs58.decode(bs58.encode(Buffer.from(out.token, "base64url"))).length, 32);
    assert.equal(await repo.getSession(out.token), null, "raw token is not a key");
    assert.ok(await repo.getSession(sha256Hex(out.token)));
    assert.equal((await auth.resolve(out.token))?.wallet, wallet);
    assert.ok((await repo.getUser(wallet))?.depositRef);
  });

  it("expired nonce is refused", async () => {
    let now = new Date("2026-11-26T12:00:00Z");
    const auth = new AuthService(new MemoryCustodyRepo(), "sealed.test", () => now);
    const kp = Keypair.generate();
    const n = await auth.issueNonce(kp.publicKey.toBase58());
    now = new Date(now.getTime() + NONCE_TTL_MS + 1);
    await assert.rejects(auth.verify(kp.publicKey.toBase58(), n.nonce, sign(n.message, kp)), /expired/);
  });

  it("session expires after 7 days", async () => {
    let now = new Date("2026-11-26T12:00:00Z");
    const auth = new AuthService(new MemoryCustodyRepo(), "sealed.test", () => now);
    const kp = Keypair.generate();
    const n = await auth.issueNonce(kp.publicKey.toBase58());
    const { token } = await auth.verify(kp.publicKey.toBase58(), n.nonce, sign(n.message, kp));
    now = new Date(now.getTime() + SESSION_TTL_MS + 1);
    assert.equal(await auth.resolve(token), null);
  });

  it("nonce bound to wallet", async () => {
    const auth = new AuthService(new MemoryCustodyRepo(), "sealed.test");
    const a = Keypair.generate();
    const b = Keypair.generate();
    const n = await auth.issueNonce(a.publicKey.toBase58());
    await assert.rejects(auth.verify(b.publicKey.toBase58(), n.nonce, sign(n.message, b)), /different wallet/);
  });
});

describe("auth routes + requireAuth", () => {
  let app: App;
  before(async () => {
    app = await makeCustodyApp();
  });
  after(async () => {
    await app.close();
  });

  it("sign in → GET /api/account", async () => {
    const { token, wallet } = await signIn(app);
    const res = await app.inject({ method: "GET", url: "/api/account", headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.wallet, wallet);
    assert.match(body.depositRef, /^[a-z2-9]{10}$/);
    assert.equal(body.companyWallet, "DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j");
    assert.ok(Array.isArray(body.balances));
  });

  it("replayed nonce is refused", async () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const { nonce, message } = (await app.inject({ method: "POST", url: "/api/auth/nonce", payload: { wallet } })).json();
    const payload = { wallet, nonce, signature: sign(message, kp) };
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/verify", payload })).statusCode, 200);
    const again = await app.inject({ method: "POST", url: "/api/auth/verify", payload });
    assert.equal(again.statusCode, 401);
    assert.equal(again.json().code, "nonce_used");
  });

  it("bad signature is refused and burns the nonce", async () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const { nonce, message } = (await app.inject({ method: "POST", url: "/api/auth/nonce", payload: { wallet } })).json();
    const bad = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { wallet, nonce, signature: sign(message + "x", kp) } });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.json().code, "invalid_signature");
    const good = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { wallet, nonce, signature: sign(message, kp) } });
    assert.equal(good.statusCode, 401, "nonce is single-use even after a failed attempt");
  });

  it("requireAuth: missing / garbage / revoked tokens → 401", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/api/account" })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/account", headers: { authorization: "Bearer " + "A".repeat(43) } })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/account", headers: { authorization: "Basic abc" } })).statusCode, 401);
    const { token } = await signIn(app);
    const h = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/session", headers: h })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers: h, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/account", headers: h })).statusCode, 401);
  });

  it("rejects malformed wallet and oversized bodies", async () => {
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/nonce", payload: { wallet: "nope" } })).statusCode, 400);
    const big = await app.inject({ method: "POST", url: "/api/auth/nonce", payload: { wallet: "x".repeat(10_000) } });
    assert.equal(big.statusCode, 413);
  });
});
