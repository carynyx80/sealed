/**
 * Universal wallet sign-in: (a) signMessage over the exact message (base58 / base64 / byte array / off-chain
 * envelopes), (b) Wallet Standard `solana:signIn` output (wallet-built message, tolerant parsing, strict field
 * checks), (c) Ledger memo-transaction fallback. Real ed25519 keys throughout.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createSignInMessage, createSignInMessageText } from "@solana/wallet-standard-util";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { AUTH_LOGIN_MEMO_PREFIX, SIWS_STATEMENT, type AuthNonceResponse } from "@sealed/shared";
import { AuthError, AuthService, NONCE_TTL_MS, parseSiwsText, decodeBinaryCandidates } from "../src/offchain/auth/siws.js";
import { DEFAULT_SIWS_DOMAIN, loadCustodyConfig, normalizeSiwsDomain } from "../src/offchain/custody/config.js";
import { MemoryCustodyRepo } from "../src/offchain/custody/repo.js";
import { loadConfig } from "../src/config.js";
import type { App } from "../src/server.js";
import { makeCustodyApp } from "./custodyHelpers.js";

const enc = (s: string) => new TextEncoder().encode(s);
const signBytes = (b: Uint8Array, kp: Keypair) => nacl.sign.detached(b, kp.secretKey);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const MEMO_V1 = new PublicKey("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo");
const BLOCKHASH = bs58.encode(Buffer.alloc(32, 7));

let ipN = 0;
const ip = () => `10.1.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`; // fresh IP per call: rate limits are not under test

async function rejectsCode(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof AuthError, String(e));
    assert.equal(e.code, code, e.message);
    if (status) assert.equal(e.statusCode, status);
    return true;
  });
}

function setup(opts: { domain?: string; network?: "mainnet" | "devnet" } = {}) {
  let now = new Date("2026-11-26T12:00:00Z");
  const repo = new MemoryCustodyRepo();
  const auth = new AuthService(repo, { domain: opts.domain ?? "www.sealedsol.xyz", domainExplicit: true, network: opts.network ?? "mainnet" }, () => now);
  return {
    auth,
    repo,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    now: () => now,
  };
}

function memoTx(p: {
  payer: Keypair;
  memo: string;
  version?: "legacy" | 0;
  extra?: TransactionInstruction[];
  budget?: boolean;
  memoProgram?: PublicKey;
  signer?: Keypair;
}): VersionedTransaction {
  const ixs: TransactionInstruction[] = [];
  if (p.budget) ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }));
  ixs.push(new TransactionInstruction({ programId: p.memoProgram ?? MEMO, keys: [], data: Buffer.from(p.memo, "utf8") }));
  ixs.push(...(p.extra ?? []));
  const m = new TransactionMessage({ payerKey: p.payer.publicKey, recentBlockhash: BLOCKHASH, instructions: ixs });
  const tx = new VersionedTransaction(p.version === "legacy" ? m.compileToLegacyMessage() : m.compileToV0Message());
  tx.sign([p.signer ?? p.payer]);
  return tx;
}
const txB64 = (tx: VersionedTransaction) => b64(tx.serialize());

// ------------------------------------------------------------------ contract

describe("nonce contract", () => {
  it("signInInput reproduces message field-for-field (wallet-standard-util createSignInMessageText)", async () => {
    const { auth } = setup();
    const kp = Keypair.generate();
    const n = await auth.issueNonce(kp.publicKey.toBase58());
    assert.equal(createSignInMessageText(n.signInInput), n.message);
    assert.deepEqual(Object.keys(n.signInInput).sort(), ["address", "domain", "expirationTime", "issuedAt", "nonce", "statement", "uri", "version"]);
    assert.equal(n.signInInput.version, "1");
    assert.equal(n.signInInput.uri, "https://www.sealedsol.xyz");
    assert.equal(n.signInInput.statement, SIWS_STATEMENT);
    assert.equal(Date.parse(n.signInInput.expirationTime) - Date.parse(n.signInInput.issuedAt), NONCE_TTL_MS);
    assert.equal(n.expiresTs, Math.floor(Date.parse(n.signInInput.expirationTime) / 1000));
    assert.match(n.nonce, /^[A-Za-z0-9]{8,}$/, "SIWS nonce is alphanumeric");
  });

  it("multiple outstanding nonces per wallet are all independently usable", async () => {
    const { auth } = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const a = await auth.issueNonce(w);
    const b = await auth.issueNonce(w);
    assert.notEqual(a.nonce, b.nonce);
    await auth.verify({ wallet: w, nonce: b.nonce, signature: bs58.encode(signBytes(enc(b.message), kp)) });
    await auth.verify({ wallet: w, nonce: a.nonce, signature: bs58.encode(signBytes(enc(a.message), kp)) });
  });
});

describe("SIWS domain resolution", () => {
  it("config: default is the production host; SIWS_DOMAIN normalised", () => {
    const cfg = loadConfig({ NODE_ENV: "test" });
    const d = loadCustodyConfig(cfg, {});
    assert.equal(d.siwsDomain, DEFAULT_SIWS_DOMAIN);
    assert.equal(DEFAULT_SIWS_DOMAIN, "www.sealedsol.xyz");
    assert.equal(d.siwsDomainExplicit, false);
    const e = loadCustodyConfig(cfg, { SIWS_DOMAIN: " https://WWW.SealedSol.xyz/ " });
    assert.equal(e.siwsDomain, "www.sealedsol.xyz");
    assert.equal(e.siwsDomainExplicit, true);
    assert.equal(normalizeSiwsDomain("sealedsol.xyz"), "sealedsol.xyz");
    assert.equal(normalizeSiwsDomain("localhost:3000"), "localhost:3000");
  });

  it("explicit SIWS_DOMAIN always wins over Origin", () => {
    const auth = new AuthService(new MemoryCustodyRepo(), { domain: "www.sealedsol.xyz", domainExplicit: true, allowedOrigins: ["https://sealedsol.xyz"] });
    assert.deepEqual(auth.resolveDomain("https://sealedsol.xyz"), { domain: "www.sealedsol.xyz", uri: "https://www.sealedsol.xyz" });
  });

  it("unset SIWS_DOMAIN: Origin in the CORS allowlist picks the domain (www and apex), others fall back", () => {
    const auth = new AuthService(new MemoryCustodyRepo(), {
      domain: DEFAULT_SIWS_DOMAIN,
      domainExplicit: false,
      allowedOrigins: ["https://www.sealedsol.xyz", "https://sealedsol.xyz"],
      network: "mainnet",
    });
    assert.equal(auth.resolveDomain("https://sealedsol.xyz").domain, "sealedsol.xyz");
    assert.equal(auth.resolveDomain("https://WWW.sealedsol.xyz").domain, "www.sealedsol.xyz");
    assert.equal(auth.resolveDomain("https://evil.example").domain, DEFAULT_SIWS_DOMAIN);
    assert.equal(auth.resolveDomain("null").domain, DEFAULT_SIWS_DOMAIN);
    assert.equal(auth.resolveDomain(undefined).domain, DEFAULT_SIWS_DOMAIN);
    // CORS "*" on mainnet: never derive from Origin.
    const star = new AuthService(new MemoryCustodyRepo(), { domain: DEFAULT_SIWS_DOMAIN, allowedOrigins: true, network: "mainnet" });
    assert.equal(star.resolveDomain("https://evil.example").domain, DEFAULT_SIWS_DOMAIN);
    assert.equal(star.resolveDomain("http://localhost:3000").domain, DEFAULT_SIWS_DOMAIN);
    // CORS "*" on devnet: local dev origins only.
    const dev = new AuthService(new MemoryCustodyRepo(), { domain: DEFAULT_SIWS_DOMAIN, allowedOrigins: true, network: "devnet" });
    assert.deepEqual(dev.resolveDomain("http://localhost:3000"), { domain: "localhost:3000", uri: "http://localhost:3000" });
    assert.equal(dev.resolveDomain("https://evil.example").domain, DEFAULT_SIWS_DOMAIN);
  });

  it("derived domain is enforced at verify (apex message cannot be replayed as www and vice versa)", async () => {
    let now = new Date("2026-11-26T12:00:00Z");
    const auth = new AuthService(
      new MemoryCustodyRepo(),
      { domain: DEFAULT_SIWS_DOMAIN, allowedOrigins: ["https://www.sealedsol.xyz", "https://sealedsol.xyz"], network: "mainnet" },
      () => now,
    );
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const n = await auth.issueNonce(w, { origin: "https://sealedsol.xyz" });
    assert.equal(n.signInInput.domain, "sealedsol.xyz");
    const wrong = createSignInMessage({ ...n.signInInput, domain: "www.sealedsol.xyz", uri: "https://www.sealedsol.xyz" });
    await rejectsCode(auth.verify({ wallet: w, nonce: n.nonce, signedMessage: b64(wrong), signature: b64(signBytes(wrong, kp)) }), "domain_mismatch", 401);
    const n2 = await auth.issueNonce(w, { origin: "https://sealedsol.xyz" });
    const ok = createSignInMessage(n2.signInInput);
    now = new Date(now.getTime() + 1000);
    await auth.verify({ wallet: w, nonce: n2.nonce, signedMessage: b64(ok), signature: b64(signBytes(ok, kp)) });
  });
});

// ------------------------------------------------------------------ (a) signMessage

describe("(a) signMessage over the exact message", () => {
  const encodings: Record<string, (sig: Uint8Array) => string | number[]> = {
    base58: (s) => bs58.encode(s),
    base64: (s) => b64(s),
    "base64 unpadded": (s) => b64(s).replace(/=+$/, ""),
    base64url: (s) => Buffer.from(s).toString("base64url"),
    hex: (s) => Buffer.from(s).toString("hex"),
    "byte array": (s) => Array.from(s),
  };
  for (const [name, fn] of Object.entries(encodings)) {
    it(`accepts ${name} signature`, async () => {
      const { auth } = setup();
      const kp = Keypair.generate();
      const w = kp.publicKey.toBase58();
      const n = await auth.issueNonce(w);
      const out = await auth.verify({ wallet: w, nonce: n.nonce, signature: fn(signBytes(enc(n.message), kp)) as string });
      assert.equal(out.wallet, w);
    });
  }

  it("signature encodings are tried across alphabets (many random keys, no false negatives)", async () => {
    const { auth } = setup();
    for (let i = 0; i < 40; i++) {
      const kp = Keypair.generate();
      const w = kp.publicKey.toBase58();
      const n = await auth.issueNonce(w);
      const sig = signBytes(enc(n.message), kp);
      await auth.verify({ wallet: w, nonce: n.nonce, signature: i % 2 ? bs58.encode(sig) : b64(sig) });
    }
  });

  it("accepts Solana off-chain message envelopes of the same text (Ledger-style signMessage)", async () => {
    const { auth } = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const n = await auth.issueNonce(w);
    const msg = Buffer.from(n.message, "utf8");
    const len = Buffer.alloc(2);
    len.writeUInt16LE(msg.length);
    const env = Buffer.concat([Buffer.from([0xff]), Buffer.from("solana offchain"), Buffer.from([0, 1]), len, msg]);
    await auth.verify({ wallet: w, nonce: n.nonce, signature: bs58.encode(signBytes(env, kp)) });
  });

  it("wrong key / other message → invalid_signature; garbage → malformed", async () => {
    const { auth } = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    let n = await auth.issueNonce(w);
    await rejectsCode(auth.verify({ wallet: w, nonce: n.nonce, signature: bs58.encode(signBytes(enc(n.message), Keypair.generate())) }), "invalid_signature", 401);
    n = await auth.issueNonce(w);
    await rejectsCode(auth.verify({ wallet: w, nonce: n.nonce, signature: bs58.encode(signBytes(enc(n.message + " "), kp)) }), "invalid_signature", 401);
    n = await auth.issueNonce(w);
    await rejectsCode(auth.verify({ wallet: w, nonce: n.nonce, signature: "!".repeat(88) }), "malformed", 400);
  });

  it("parser helper decodes ambiguous strings into every candidate", () => {
    const sig = new Uint8Array(64).fill(9);
    assert.equal(decodeBinaryCandidates(bs58.encode(sig), 64).length >= 1, true);
    assert.equal(decodeBinaryCandidates(b64(sig), 64).length >= 1, true);
    assert.equal(decodeBinaryCandidates("abc", 64).length, 0);
  });
});

// ------------------------------------------------------------------ (b) signIn

/** Hand-built variants of what real wallets emit for the same input. */
function walletVariants(n: AuthNonceResponse): Record<string, string> {
  const i = n.signInInput;
  const head = `${i.domain} wants you to sign in with your Solana account:\n${i.address}`;
  return {
    exact: createSignInMessageText(i),
    reordered: `${head}\n\n${i.statement}\n\nNonce: ${i.nonce}\nURI: ${i.uri}\nIssued At: ${i.issuedAt}\nVersion: 1\nExpiration Time: ${i.expirationTime}`,
    crlf: createSignInMessageText(i).replace(/\n/g, "\r\n"),
    "trailing whitespace + newline": createSignInMessageText(i).split("\n").map((l) => l + "  ").join("\n") + "\n\n",
    "extra blank lines": `${head}\n\n\n${i.statement}\n\n\nURI: ${i.uri}\nVersion: 1\nNonce: ${i.nonce}\nIssued At: ${i.issuedAt}\nExpiration Time: ${i.expirationTime}\n`,
    "no statement": createSignInMessageText({ ...i, statement: undefined }),
    "minimal (no uri/version/times)": createSignInMessageText({ domain: i.domain, address: i.address, nonce: i.nonce }),
    "with chain id": createSignInMessageText({ ...i, chainId: "solana:mainnet" }),
    "with chain id mainnet": createSignInMessageText({ ...i, chainId: "mainnet" }),
    "with resources + request id": createSignInMessageText({ ...i, requestId: "r1", resources: ["https://www.sealedsol.xyz/terms"] }),
    "lowercase keys": `${head}\n\n${i.statement}\n\nuri: ${i.uri}\nversion: 1\nnonce: ${i.nonce}\nissued at: ${i.issuedAt}\nexpiration time: ${i.expirationTime}`,
  };
}

describe("(b) Wallet Standard signIn output", () => {
  it("variants: every wallet-style rendering verifies", async () => {
    const { auth } = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const probe = await auth.issueNonce(w);
    for (const name of Object.keys(walletVariants(probe))) {
      const n = await auth.issueNonce(w);
      const bytes = enc(walletVariants(n)[name]!);
      assert.ok(parseSiwsText(new TextDecoder().decode(bytes)), `parses: ${name}`);
      const out = await auth.verify({ wallet: w, nonce: n.nonce, signedMessage: b64(bytes), signature: b64(signBytes(bytes, kp)), signatureType: "ed25519", address: w });
      assert.equal(out.wallet, w, name);
    }
  });

  it("base58 signature + byte-array signedMessage also accepted", async () => {
    const { auth } = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const n = await auth.issueNonce(w);
    const m = createSignInMessage(n.signInInput);
    await auth.verify({ wallet: w, nonce: n.nonce, signedMessage: Array.from(m), signature: bs58.encode(signBytes(m, kp)) });
  });

  it("useOffchainMessage (v1 envelope around the SIWS text) verifies", async () => {
    const { auth } = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const n = await auth.issueNonce(w);
    const m = createSignInMessage(n.signInInput);
    const env = Buffer.concat([Buffer.from([0xff]), Buffer.from("solana offchain"), Buffer.from([1, 1]), kp.publicKey.toBuffer(), Buffer.from(m)]);
    await auth.verify({ wallet: w, nonce: n.nonce, signedMessage: b64(env), signature: b64(signBytes(env, kp)) });
    // Envelope listing a different signer is not accepted as this wallet's message.
    const n2 = await auth.issueNonce(w);
    const m2 = createSignInMessage(n2.signInInput);
    const env2 = Buffer.concat([Buffer.from([0xff]), Buffer.from("solana offchain"), Buffer.from([1, 1]), Keypair.generate().publicKey.toBuffer(), Buffer.from(m2)]);
    await rejectsCode(auth.verify({ wallet: w, nonce: n2.nonce, signedMessage: b64(env2), signature: b64(signBytes(env2, kp)) }), "malformed", 400);
  });

  async function refuse(mutate: (i: AuthNonceResponse["signInInput"]) => Record<string, unknown>, code: string, status = 401, extra: Record<string, unknown> = {}) {
    const ctx = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const n = await ctx.auth.issueNonce(w);
    const m = createSignInMessage(mutate(n.signInInput) as Parameters<typeof createSignInMessage>[0]);
    await rejectsCode(ctx.auth.verify({ wallet: w, nonce: n.nonce, signedMessage: b64(m), signature: b64(signBytes(m, kp)), ...extra }), code, status);
  }

  it("wrong domain → domain_mismatch", () => refuse((i) => ({ ...i, domain: "evil.example" }), "domain_mismatch"));
  it("apex vs www → domain_mismatch", () => refuse((i) => ({ ...i, domain: "sealedsol.xyz" }), "domain_mismatch"));
  it("wrong uri → domain_mismatch", () => refuse((i) => ({ ...i, uri: "https://evil.example/login" }), "domain_mismatch"));
  it("wrong chain → domain_mismatch", () => refuse((i) => ({ ...i, chainId: "solana:devnet" }), "domain_mismatch"));
  it("different statement → domain_mismatch", () => refuse((i) => ({ ...i, statement: "Approve unlimited spending" }), "domain_mismatch"));
  it("wrong nonce → nonce_mismatch", () => refuse((i) => ({ ...i, nonce: "A".repeat(32) }), "nonce_mismatch"));
  it("missing nonce → nonce_mismatch", () => refuse((i) => ({ ...i, nonce: undefined }), "nonce_mismatch"));
  it("expired expirationTime → expired", () => refuse((i) => ({ ...i, expirationTime: new Date(Date.parse(i.issuedAt) - 1000).toISOString(), issuedAt: new Date(Date.parse(i.issuedAt) - 2000).toISOString() }), "expired"));
  it("issuedAt > expirationTime → malformed", () => refuse((i) => ({ ...i, issuedAt: new Date(Date.parse(i.expirationTime) + 60_000).toISOString() }), "malformed", 400));
  it("future issuedAt beyond 10 min skew → expired", () => refuse((i) => ({ ...i, issuedAt: new Date(Date.parse(i.issuedAt) + 11 * 60_000).toISOString(), expirationTime: new Date(Date.parse(i.issuedAt) + 20 * 60_000).toISOString() }), "expired"));
  it("past issuedAt beyond skew → expired", () => refuse((i) => ({ ...i, issuedAt: new Date(Date.parse(i.issuedAt) - 11 * 60_000).toISOString() }), "expired"));
  it("garbage issuedAt → malformed", () => refuse((i) => ({ ...i, issuedAt: "yesterday" }), "malformed", 400));
  it("wrong address in message → wallet_mismatch", () => refuse((i) => ({ ...i, address: Keypair.generate().publicKey.toBase58() }), "wallet_mismatch"));
  it("output address ≠ wallet (account switched inside wallet) → wallet_mismatch", () =>
    refuse((i) => i, "wallet_mismatch", 401, { address: Keypair.generate().publicKey.toBase58() }));

  it("issuedAt slightly in the future (device clock ahead, within skew) is accepted", async () => {
    const { auth } = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const n = await auth.issueNonce(w);
    const i = n.signInInput;
    const m = createSignInMessage({ ...i, issuedAt: new Date(Date.parse(i.issuedAt) + 3 * 60_000).toISOString() });
    await auth.verify({ wallet: w, nonce: n.nonce, signedMessage: b64(m), signature: b64(signBytes(m, kp)) });
  });

  it("tampered message (signature over different bytes) → invalid_signature", async () => {
    const { auth } = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const n = await auth.issueNonce(w);
    const m = createSignInMessage(n.signInInput);
    const sig = signBytes(m, kp);
    const tampered = enc(createSignInMessageText(n.signInInput) + "\n");
    await rejectsCode(auth.verify({ wallet: w, nonce: n.nonce, signedMessage: b64(tampered), signature: b64(sig) }), "invalid_signature");
  });

  it("signed by another key → invalid_signature", async () => {
    const { auth } = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const n = await auth.issueNonce(w);
    const m = createSignInMessage(n.signInInput);
    await rejectsCode(auth.verify({ wallet: w, nonce: n.nonce, signedMessage: b64(m), signature: b64(signBytes(m, Keypair.generate())) }), "invalid_signature");
  });

  it("not a SIWS message → malformed", async () => {
    const { auth } = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const n = await auth.issueNonce(w);
    const m = enc("hello");
    await rejectsCode(auth.verify({ wallet: w, nonce: n.nonce, signedMessage: b64(m), signature: b64(signBytes(m, kp)) }), "malformed", 400);
  });

  it("duplicate fields are refused (no parser ambiguity)", () => {
    const t = "www.sealedsol.xyz wants you to sign in with your Solana account:\nX\n\nNonce: a\nURI: https://www.sealedsol.xyz\nNonce: b";
    assert.equal(parseSiwsText(t), null);
  });
});

// ------------------------------------------------------------------ (c) memo tx

describe("(c) Ledger memo-transaction fallback", () => {
  async function go(build: (kp: Keypair, nonce: string) => VersionedTransaction | string) {
    const { auth } = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const n = await auth.issueNonce(w);
    const tx = build(kp, n.nonce);
    return auth.verify({ wallet: w, nonce: n.nonce, signedTransaction: typeof tx === "string" ? tx : txB64(tx) });
  }
  const memo = (nonce: string) => `${AUTH_LOGIN_MEMO_PREFIX}${nonce}`;

  it("legacy tx with memo verifies", async () => {
    assert.ok((await go((kp, n) => memoTx({ payer: kp, memo: memo(n), version: "legacy" }))).token);
  });
  it("v0 tx with memo + compute budget verifies", async () => {
    assert.ok((await go((kp, n) => memoTx({ payer: kp, memo: memo(n), version: 0, budget: true }))).token);
  });
  it("Memo v1 program verifies", async () => {
    assert.ok((await go((kp, n) => memoTx({ payer: kp, memo: memo(n), memoProgram: MEMO_V1 }))).token);
  });
  it("base58-serialized tx also accepted", async () => {
    assert.ok((await go((kp, n) => bs58.encode(memoTx({ payer: kp, memo: memo(n) }).serialize()))).token);
  });
  it("wrong memo text → invalid_transaction", () => rejectsCode(go((kp) => memoTx({ payer: kp, memo: "hello" })), "invalid_transaction"));
  it("memo for another nonce → nonce_mismatch", () => rejectsCode(go((kp) => memoTx({ payer: kp, memo: memo("B".repeat(32)) })), "nonce_mismatch"));
  it("extra instruction (SOL transfer) → invalid_transaction", () =>
    rejectsCode(
      go((kp, n) => memoTx({ payer: kp, memo: memo(n), extra: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] })),
      "invalid_transaction",
    ));
  it("two memos → invalid_transaction", () =>
    rejectsCode(go((kp, n) => memoTx({ payer: kp, memo: memo(n), extra: [new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(memo(n)) })] })), "invalid_transaction"));
  it("wrong fee payer → wallet_mismatch", () =>
    rejectsCode(
      go((_kp, n) => memoTx({ payer: Keypair.generate(), memo: memo(n) })),
      "wallet_mismatch",
    ));
  it("bad signature → invalid_signature", () =>
    rejectsCode(
      go((kp, n) => {
        const tx = memoTx({ payer: kp, memo: memo(n) });
        tx.signatures[0] = signBytes(enc("other"), kp);
        return tx;
      }),
      "invalid_signature",
    ));
  it("unsigned → invalid_signature", () =>
    rejectsCode(
      go((kp, n) => {
        const tx = memoTx({ payer: kp, memo: memo(n) });
        tx.signatures[0] = new Uint8Array(64);
        return tx;
      }),
      "invalid_signature",
    ));
  it("garbage → malformed", () => rejectsCode(go(() => "AAAA"), "malformed", 400));
});

// ------------------------------------------------------------------ nonce lifecycle

describe("nonce lifecycle", () => {
  it("replay of a successful proof → nonce_used", async () => {
    const { auth } = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const n = await auth.issueNonce(w);
    const req = { wallet: w, nonce: n.nonce, signature: bs58.encode(signBytes(enc(n.message), kp)) };
    await auth.verify(req);
    await rejectsCode(auth.verify(req), "nonce_used");
  });

  it("concurrent double-submit → exactly one session", async () => {
    const { auth } = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const n = await auth.issueNonce(w);
    const req = { wallet: w, nonce: n.nonce, signature: bs58.encode(signBytes(enc(n.message), kp)) };
    const r = await Promise.allSettled([auth.verify(req), auth.verify(req), auth.verify(req)]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  });

  it("account switch between nonce and verify → wallet_mismatch, nonce burned", async () => {
    const { auth } = setup();
    const a = Keypair.generate();
    const b = Keypair.generate();
    const n = await auth.issueNonce(a.publicKey.toBase58());
    const bMsg = createSignInMessage({ ...n.signInInput, address: b.publicKey.toBase58() });
    await rejectsCode(
      auth.verify({ wallet: b.publicKey.toBase58(), nonce: n.nonce, signedMessage: b64(bMsg), signature: b64(signBytes(bMsg, b)) }),
      "wallet_mismatch",
    );
    await rejectsCode(auth.verify({ wallet: a.publicKey.toBase58(), nonce: n.nonce, signature: bs58.encode(signBytes(enc(n.message), a)) }), "nonce_used");
  });

  it("expired nonce → expired", async () => {
    const ctx = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const n = await ctx.auth.issueNonce(w);
    ctx.advance(NONCE_TTL_MS + 1);
    await rejectsCode(ctx.auth.verify({ wallet: w, nonce: n.nonce, signature: bs58.encode(signBytes(enc(n.message), kp)) }), "expired");
  });

  it("logout revokes only that token; reuse after logout fails", async () => {
    const { auth } = setup();
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const s1 = await auth.verify(await (async () => { const n = await auth.issueNonce(w); return { wallet: w, nonce: n.nonce, signature: bs58.encode(signBytes(enc(n.message), kp)) }; })());
    const s2 = await auth.verify(await (async () => { const n = await auth.issueNonce(w); return { wallet: w, nonce: n.nonce, signature: bs58.encode(signBytes(enc(n.message), kp)) }; })());
    await auth.logout(s1.token);
    assert.equal(await auth.resolve(s1.token), null);
    assert.equal((await auth.resolve(s2.token))?.wallet, w);
    await auth.logout(s1.token); // idempotent
    assert.equal(await auth.resolve(s1.token), null);
  });
});

// ------------------------------------------------------------------ HTTP

describe("HTTP contract", () => {
  let app: App;
  before(async () => {
    app = await makeCustodyApp();
  });
  after(async () => {
    await app.close();
  });
  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, payload: payload as Record<string, unknown>, headers, remoteAddress: ip() });

  it("nonce returns signInInput; all three proofs sign in over HTTP", async () => {
    for (const kind of ["signMessage", "signIn", "memoTx"] as const) {
      const kp = Keypair.generate();
      const wallet = kp.publicKey.toBase58();
      const nr = await post("/api/auth/nonce", { wallet });
      assert.equal(nr.statusCode, 200, nr.body);
      const n = nr.json<AuthNonceResponse>();
      assert.equal(n.signInInput.domain, DEFAULT_SIWS_DOMAIN);
      assert.equal(createSignInMessageText(n.signInInput), n.message);
      const m = createSignInMessage(n.signInInput);
      const body =
        kind === "signMessage"
          ? { wallet, nonce: n.nonce, signature: b64(signBytes(enc(n.message), kp)) }
          : kind === "signIn"
            ? { wallet, nonce: n.nonce, signedMessage: b64(m), signature: b64(signBytes(m, kp)), signatureType: "ed25519", address: wallet }
            : { wallet, nonce: n.nonce, signedTransaction: txB64(memoTx({ payer: kp, memo: `${AUTH_LOGIN_MEMO_PREFIX}${n.nonce}`, budget: true })) };
      const v = await post("/api/auth/verify", body);
      assert.equal(v.statusCode, 200, `${kind}: ${v.body}`);
      const token = v.json<{ token: string }>().token;
      const s = await app.inject({ method: "GET", url: "/api/auth/session", headers: { authorization: `Bearer ${token}` } });
      assert.equal(s.json().wallet, wallet);
    }
  });

  it("errors carry a stable code", async () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const bad = await post("/api/auth/verify", { wallet, nonce: "x".repeat(32) });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().code, "malformed");
    const unknown = await post("/api/auth/verify", { wallet, nonce: "x".repeat(32), signature: bs58.encode(new Uint8Array(64)) });
    assert.equal(unknown.statusCode, 401);
    assert.equal(unknown.json().code, "nonce_used");
    const n = (await post("/api/auth/nonce", { wallet })).json<AuthNonceResponse>();
    const wrong = createSignInMessage({ ...n.signInInput, domain: "evil.example" });
    const dm = await post("/api/auth/verify", { wallet, nonce: n.nonce, signedMessage: b64(wrong), signature: b64(signBytes(wrong, kp)) });
    assert.equal(dm.statusCode, 401);
    assert.deepEqual(dm.json(), { error: "Signed message is for a different site.", code: "domain_mismatch" });
    const nw = await post("/api/auth/nonce", { wallet: "nope" });
    assert.equal(nw.json().code, "malformed");
    const unauth = await app.inject({ method: "GET", url: "/api/auth/session" });
    assert.equal(unauth.json().code, "unauthorized");
  });

  it("logout → token reuse refused", async () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const n = (await post("/api/auth/nonce", { wallet })).json<AuthNonceResponse>();
    const { token } = (await post("/api/auth/verify", { wallet, nonce: n.nonce, signature: bs58.encode(signBytes(enc(n.message), kp)) })).json();
    const h = { authorization: `Bearer ${token}` };
    assert.equal((await post("/api/auth/logout", {}, h)).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/session", headers: h })).statusCode, 401);
    assert.equal((await post("/api/auth/logout", {}, h)).statusCode, 401);
  });
});
