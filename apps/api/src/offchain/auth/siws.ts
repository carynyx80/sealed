import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { parseSignInMessageText, verifyMessageSignature } from "@solana/wallet-standard-util";
import bs58 from "bs58";
import {
  AUTH_LOGIN_MEMO_PREFIX,
  SIWS_STATEMENT,
  type AuthErrorCode,
  type AuthNonceResponse,
  type AuthSignInInput,
  type AuthVerifyRequest,
  type AuthVerifyResponse,
  type Network,
} from "@sealed/shared";
import type { CustodyRepo } from "../custody/repo.js";

export const NONCE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 3_600_000;
/** Allowed |issuedAt − server time| for wallet-built signIn messages (wallet / device clock skew). */
export const SIGN_IN_CLOCK_SKEW_MS = 10 * 60_000;

export const MEMO_PROGRAM_IDS = new Set(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]);
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Sign-In-With-Solana message (strict SIWS / CAIP-122 layout; identical to
 * `createSignInMessageText(signInInput)` from @solana/wallet-standard-util). The exact string is returned to the
 * client, which signs its UTF-8 bytes with `signMessage`; the server verifies against the stored copy.
 */
export function buildSiwsMessage(p: { domain: string; wallet: string; nonce: string; issuedAt: Date; expiresAt: Date; uri?: string }): string {
  return [
    // Wallets (Phantom, Solflare, Backpack…) parse this and refuse messages with unknown fields
    // ("invalid formatting"). Only spec fields, in spec order.
    `${p.domain} wants you to sign in with your Solana account:`,
    p.wallet,
    "",
    SIWS_STATEMENT,
    "",
    `URI: ${p.uri ?? `https://${p.domain}`}`,
    `Version: 1`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt.toISOString()}`,
    `Expiration Time: ${p.expiresAt.toISOString()}`,
  ].join("\n");
}

export class AuthError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: AuthErrorCode = statusCode === 400 ? "malformed" : "invalid_signature",
  ) {
    super(message);
  }
}

const fail = (status: number, code: AuthErrorCode, message: string): never => {
  throw new AuthError(status, message, code);
};

export interface Session {
  wallet: string;
  expiresAt: Date;
}

export interface AuthServiceOptions {
  /** Configured SIWS domain (host[:port]). */
  domain: string;
  /** SIWS_DOMAIN set explicitly → never derive from the request Origin. */
  domainExplicit?: boolean;
  /** CORS allowlist (AppConfig.corsOrigin). Only an explicit list/string lets the Origin pick the domain. */
  allowedOrigins?: string | string[] | boolean;
  /** Enforced against `Chain ID` when a wallet includes one. */
  network?: Network;
}

// ---------------------------------------------------------------- parsing helpers

export interface ParsedSignIn {
  domain: string;
  address: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

const FIELD_KEYS: Record<string, keyof ParsedSignIn> = {
  uri: "uri",
  version: "version",
  "chain id": "chainId",
  nonce: "nonce",
  "issued at": "issuedAt",
  "expiration time": "expirationTime",
  "not before": "notBefore",
  "request id": "requestId",
};
const FIELD_LINE = /^(URI|Version|Chain ID|Nonce|Issued At|Expiration Time|Not Before|Request ID|Resources)\s*:\s*(.*)$/i;
const HEADER_LINE = /^(.+?)\s+wants you to sign in with your Solana account:?$/i;

/**
 * Parse a SIWS message as wallets actually produce it. First the reference parser from
 * @solana/wallet-standard-util (strict spec order), then a tolerant parser that accepts CRLF, trailing/extra
 * whitespace, blank-line variations and any field order (duplicate fields → rejected). Returns null if the text
 * is not a SIWS message at all.
 */
export function parseSiwsText(raw: string): ParsedSignIn | null {
  const text = raw.replace(/^﻿/, "");
  // The reference regex parser is order-sensitive and its lazy statement group swallows out-of-order fields
  // ("Statement\n\nNonce: …" becomes the statement), so only trust it when the statement has no field lines.
  const clean = (p: ReturnType<typeof parseSignInMessageText>) =>
    p && !(p.statement ?? "").split(/\r?\n/).some((l) => FIELD_LINE.test(l.trim())) ? p : null;
  const strict = clean(parseSignInMessageText(text));
  if (strict) return { ...strict, resources: strict.resources ? [...strict.resources] : undefined };
  const normalized = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).join("\n").replace(/^\n+|\n+$/g, "");
  const strict2 = clean(parseSignInMessageText(normalized));
  if (strict2) return { ...strict2, resources: strict2.resources ? [...strict2.resources] : undefined };

  const lines = normalized.split("\n");
  const header = HEADER_LINE.exec(lines[0] ?? "");
  if (!header) return null;
  let i = 1;
  while (i < lines.length && lines[i] === "") i++;
  const address = lines[i++];
  if (!address) return null;
  const out: ParsedSignIn = { domain: header[1]!.trim(), address };
  // First line at which only field lines / resource items / blanks follow.
  let fieldsStart = lines.length;
  for (let j = lines.length - 1; j >= i; j--) {
    const l = lines[j]!;
    if (l === "" || FIELD_LINE.test(l) || l.startsWith("- ")) {
      if (FIELD_LINE.test(l)) fieldsStart = j;
      continue;
    }
    break;
  }
  const statement = lines.slice(i, fieldsStart).join("\n").trim();
  if (statement) out.statement = statement;
  let inResources = false;
  for (let j = fieldsStart; j < lines.length; j++) {
    const l = lines[j]!;
    if (l === "") continue;
    if (l.startsWith("- ")) {
      if (!inResources) return null;
      out.resources!.push(l.slice(2).trim());
      continue;
    }
    const m = FIELD_LINE.exec(l);
    if (!m) return null;
    const key = m[1]!.toLowerCase();
    if (key === "resources") {
      if (out.resources) return null;
      out.resources = [];
      inResources = true;
      continue;
    }
    inResources = false;
    const f = FIELD_KEYS[key]!;
    const val = m[2]!.trim();
    if (!val || out[f] !== undefined) return null; // empty or duplicate field
    (out as unknown as Record<string, string>)[f] = val;
  }
  return out;
}

const B58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;
const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;
const HEX_RE = /^(?:0x)?([0-9a-fA-F]{2})+$/;

/**
 * All plausible byte decodings of a client-supplied binary value. Adapters return a Uint8Array and front-ends
 * encode it inconsistently (bs58, base64, base64url, hex, or a JSON byte array), and an 86–88 char string can be
 * valid in more than one alphabet — so every candidate of the wanted length is returned and the caller tries each.
 */
export function decodeBinaryCandidates(v: string | number[], wantLen?: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  const add = (b: Uint8Array | null) => {
    if (!b || b.length === 0 || (wantLen !== undefined && b.length !== wantLen)) return;
    if (!out.some((o) => o.length === b.length && Buffer.compare(Buffer.from(o), Buffer.from(b)) === 0)) out.push(b);
  };
  if (Array.isArray(v)) {
    add(Uint8Array.from(v));
    return out;
  }
  const s = v.trim();
  if (HEX_RE.test(s) && (wantLen === undefined || s.replace(/^0x/, "").length === wantLen * 2)) add(Uint8Array.from(Buffer.from(s.replace(/^0x/, ""), "hex")));
  if (B58_RE.test(s)) {
    try {
      add(bs58.decode(s));
    } catch {
      /* not base58 */
    }
  }
  if (B64_RE.test(s)) add(Uint8Array.from(Buffer.from(s, "base64")));
  else if (B64URL_RE.test(s)) add(Uint8Array.from(Buffer.from(s.replace(/=+$/, ""), "base64url")));
  return out;
}

/** Equal-time string compare (via fixed-length digests). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a === b;
}

/** Strict RFC 8032 ed25519 (rejects small-order keys, for which one fixed signature verifies every message). */
export function ed25519Verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    return verifyMessageSignature({ message, signedMessage: message, signature, publicKey });
  } catch {
    return false;
  }
}

const OFFCHAIN_DOMAIN = Buffer.concat([Buffer.from([0xff]), Buffer.from("solana offchain", "ascii")]);
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};

/**
 * Byte layouts a wallet may actually sign for `signMessage(utf8(message))`. Some wallets / hardware paths (Ledger
 * Solana app, Solflare+Ledger, `useOffchainMessage`) wrap the text in a Solana off-chain message envelope
 * (`\xffsolana offchain` …, SRFC-3 legacy / v0 / v1) instead of signing the raw bytes. Only envelopes around the SAME
 * message text and naming this signer are accepted; the 0xff prefix can never be a valid transaction message.
 */
export function signMessageByteVariants(message: string, signer: Uint8Array): Uint8Array[] {
  const msg = Buffer.from(message, "utf8");
  const pk = Buffer.from(signer);
  const variants: Uint8Array[] = [msg];
  for (const format of [0, 1, 2]) {
    variants.push(Buffer.concat([OFFCHAIN_DOMAIN, Buffer.from([0, format]), u16(msg.length), msg])); // legacy Ledger
    variants.push(Buffer.concat([OFFCHAIN_DOMAIN, Buffer.from([0]), Buffer.alloc(32), Buffer.from([format, 1]), pk, u16(msg.length), msg])); // v0
  }
  variants.push(Buffer.concat([OFFCHAIN_DOMAIN, Buffer.from([1, 1]), pk, msg])); // v1
  variants.push(Buffer.concat([OFFCHAIN_DOMAIN, Buffer.from([1, 1]), pk, u16(msg.length), msg]));
  return variants;
}

/**
 * Inner message text bytes of an off-chain message envelope (legacy / v0 / v1) that lists `signer`, or null when
 * `bytes` is not an envelope. Used for signIn outputs produced with `useOffchainMessage`.
 */
export function unwrapOffchainMessage(bytes: Uint8Array, signer: Uint8Array): Uint8Array | null {
  const b = Buffer.from(bytes);
  if (b.length < 20 || !b.subarray(0, 16).equals(OFFCHAIN_DOMAIN)) return null;
  const pk = Buffer.from(signer);
  const withLen = (off: number) => (b.length >= off + 2 && b.readUInt16LE(off) === b.length - off - 2 ? b.subarray(off + 2) : null);
  const signersAt = (off: number, n: number) => {
    for (let i = 0; i < n; i++) if (b.subarray(off + i * 32, off + (i + 1) * 32).equals(pk)) return true;
    return false;
  };
  const version = b[16];
  if (version === 0) {
    const legacy = b[17]! <= 2 ? withLen(18) : null;
    if (legacy) return legacy; // legacy has no signer list; the signature itself binds the signer
    if (b.length < 16 + 1 + 32 + 2) return null;
    const n = b[50]!;
    if (!n || !signersAt(51, n)) return null;
    return withLen(51 + n * 32);
  }
  if (version === 1) {
    const n = b[17]!;
    if (!n || !signersAt(18, n)) return null;
    const off = 18 + n * 32;
    return withLen(off) ?? b.subarray(off);
  }
  return null;
}

function verifyAny(messages: Uint8Array[], sigs: Uint8Array[], pk: Uint8Array): boolean {
  for (const s of sigs) for (const m of messages) if (ed25519Verify(m, s, pk)) return true;
  return false;
}

const lowerHost = (h: string) => h.trim().toLowerCase();

function originOf(uri: string): string | null {
  try {
    const u = new URL(uri);
    return u.origin === "null" ? null : u.origin.toLowerCase();
  } catch {
    return null;
  }
}

function chainMatches(chainId: string, network: Network | undefined): boolean {
  if (!network) return true;
  const c = chainId.trim().toLowerCase().replace(/^solana:/, "");
  if (network === "mainnet") return c === "mainnet" || c === "mainnet-beta";
  return c === network;
}

// ---------------------------------------------------------------- service

export class AuthService {
  private readonly opts: Required<Pick<AuthServiceOptions, "domain">> & AuthServiceOptions;

  constructor(
    private readonly repo: CustodyRepo,
    opts: AuthServiceOptions | string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.opts = typeof opts === "string" ? { domain: opts, domainExplicit: true } : opts;
  }

  /**
   * SIWS domain + uri for a nonce request. SIWS_DOMAIN wins; otherwise the request Origin is used when it is in an
   * explicit CORS allowlist (so www/apex both work out of the box), otherwise the configured default.
   */
  resolveDomain(origin?: string): { domain: string; uri: string } {
    const fallback = { domain: this.opts.domain, uri: `https://${this.opts.domain}` };
    if (this.opts.domainExplicit || !origin) return fallback;
    const o = originOf(origin);
    if (!o) return fallback;
    const allow = this.opts.allowedOrigins;
    const list = typeof allow === "string" ? [allow] : Array.isArray(allow) ? allow : [];
    let ok = list.some((a) => originOf(a) === o);
    // CORS "*" in a non-mainnet dev setup: allow local dev origins only.
    if (!ok && allow === true && this.opts.network !== "mainnet") ok = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
    if (!ok) return fallback;
    const u = new URL(o);
    return { domain: u.host, uri: u.origin };
  }

  async issueNonce(wallet: string, ctx: { origin?: string } = {}): Promise<AuthNonceResponse> {
    assertPubkey(wallet);
    const { domain, uri } = this.resolveDomain(ctx.origin);
    const nonce = bs58.encode(randomBytes(24)); // ~32 chars, alphanumeric (SIWS nonce ≥ 8 alnum chars)
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
    const message = buildSiwsMessage({ domain, wallet, nonce, issuedAt, expiresAt, uri });
    await this.repo.createNonce({ nonce, wallet, message, expiresAt, usedAt: null });
    if (Math.random() < 0.05) void this.repo.pruneNonces(issuedAt).catch(() => undefined);
    const signInInput: AuthSignInInput = {
      domain,
      address: wallet,
      statement: SIWS_STATEMENT,
      uri,
      version: "1",
      nonce,
      issuedAt: issuedAt.toISOString(),
      expirationTime: expiresAt.toISOString(),
    };
    return { nonce, message, expiresTs: Math.floor(expiresAt.getTime() / 1000), signInInput };
  }

  /**
   * Verify one of the three proofs (signMessage signature / Wallet Standard signIn output / Ledger memo tx).
   * Single-use: the nonce is consumed on ANY verify attempt (good or bad), so it can never be replayed, and the
   * atomic consume makes concurrent double-submits resolve to exactly one session.
   *
   * Back-compat: `verify(wallet, nonce, signature)`.
   */
  async verify(walletOrReq: string | AuthVerifyRequest, nonceArg?: string, signatureArg?: string): Promise<AuthVerifyResponse> {
    const req: AuthVerifyRequest =
      typeof walletOrReq === "string" ? { wallet: walletOrReq, nonce: nonceArg!, signature: signatureArg } : walletOrReq;
    const { wallet, nonce } = req;
    const pk = assertPubkey(wallet);
    const now = this.now();
    const rec = await this.repo.consumeNonce(nonce, now);
    if (!rec) return fail(401, "nonce_used", "This sign-in request was already used or is unknown. Please try again.");
    if (rec.wallet !== wallet) {
      return fail(401, "wallet_mismatch", "This sign-in request was created for a different wallet. Reconnect the wallet you want to use and try again.");
    }
    if (rec.expiresAt.getTime() <= now.getTime()) return fail(401, "expired", "Sign-in request expired, try again.");

    if (req.signedTransaction !== undefined) this.checkMemoTx(req.signedTransaction, wallet, nonce, pk);
    else if (req.signedMessage !== undefined) this.checkSignIn(req, rec.message, wallet, nonce, pk, now);
    else this.checkSignMessage(req.signature, rec.message, pk);

    await this.repo.ensureUser(wallet);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.repo.createSession({ tokenHash: sha256Hex(token), wallet, createdAt: now, expiresAt, revokedAt: null });
    return { token, wallet, expiresTs: Math.floor(expiresAt.getTime() / 1000) };
  }

  /** (a) signMessage over the exact stored message (raw bytes, or an off-chain-message envelope of it). */
  private checkSignMessage(signature: AuthVerifyRequest["signature"], message: string, pk: PublicKey): void {
    if (signature === undefined) return fail(400, "malformed", "Missing signature.");
    const sigs = decodeBinaryCandidates(signature, 64);
    if (!sigs.length) return fail(400, "malformed", "Signature could not be read (expected a 64-byte base58 or base64 value).");
    if (!verifyAny(signMessageByteVariants(message, pk.toBytes()), sigs, pk.toBytes())) {
      return fail(401, "invalid_signature", "Signature does not match this wallet.");
    }
  }

  /** (b) Wallet Standard `solana:signIn` output: the wallet may have built the message itself. */
  private checkSignIn(req: AuthVerifyRequest, storedMessage: string, wallet: string, nonce: string, pk: PublicKey, now: Date): void {
    if (req.signature === undefined) return fail(400, "malformed", "Missing signature.");
    if (req.address !== undefined && req.address !== wallet) {
      return fail(401, "wallet_mismatch", "You signed with a different wallet account than the one connected. Switch accounts and try again.");
    }
    const msgs = decodeBinaryCandidates(req.signedMessage!).filter((m) => m.length <= 2048);
    const sigs = decodeBinaryCandidates(req.signature, 64);
    if (!sigs.length) return fail(400, "malformed", "Signature could not be read (expected a 64-byte base58 or base64 value).");
    // Pick the decoding that is a SIWS message (base64 is the contract; others tolerated).
    let signed: Uint8Array | null = null;
    let parsed: ParsedSignIn | null = null;
    for (const m of msgs) {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(unwrapOffchainMessage(m, pk.toBytes()) ?? m);
      } catch {
        continue;
      }
      const p = parseSiwsText(text);
      if (p) {
        signed = m;
        parsed = p;
        break;
      }
    }
    if (!signed || !parsed) return fail(400, "malformed", "Signed message is not a valid Sign-In-With-Solana message.");
    const expected = parseSiwsText(storedMessage);
    if (!expected) return fail(500, "auth_unavailable", "Sign-in is temporarily unavailable.");

    if (lowerHost(parsed.domain) !== lowerHost(expected.domain)) return fail(401, "domain_mismatch", "Signed message is for a different site.");
    if (parsed.uri !== undefined && originOf(parsed.uri) !== originOf(expected.uri ?? `https://${expected.domain}`)) {
      return fail(401, "domain_mismatch", "Signed message is for a different site.");
    }
    if (parsed.chainId !== undefined && !chainMatches(parsed.chainId, this.opts.network)) {
      return fail(401, "domain_mismatch", "Signed message is for a different Solana network.");
    }
    if (parsed.address.trim() !== wallet) {
      return fail(401, "wallet_mismatch", "You signed with a different wallet account than the one connected. Switch accounts and try again.");
    }
    if (parsed.nonce === undefined || !safeEqual(parsed.nonce.trim(), nonce)) {
      return fail(401, "nonce_mismatch", "Signed message does not belong to this sign-in request. Please try again.");
    }
    if (parsed.version !== undefined && parsed.version.trim() !== "1") return fail(400, "malformed", "Unsupported sign-in message version.");
    if (parsed.statement !== undefined && parsed.statement.replace(/\s+/g, " ").trim() !== SIWS_STATEMENT) {
      return fail(401, "domain_mismatch", "Signed message text does not match Sealed's sign-in request.");
    }
    const t = now.getTime();
    const ts = (v: string | undefined, name: string): number | undefined => {
      if (v === undefined) return undefined;
      const n = Date.parse(v.trim());
      return Number.isFinite(n) ? n : fail(400, "malformed", `Signed message has an invalid ${name}.`);
    };
    const issuedAt = ts(parsed.issuedAt, "Issued At");
    const expirationTime = ts(parsed.expirationTime, "Expiration Time");
    const notBefore = ts(parsed.notBefore, "Not Before");
    if (issuedAt !== undefined) {
      if (Math.abs(issuedAt - t) > SIGN_IN_CLOCK_SKEW_MS) return fail(401, "expired", "Sign-in request expired or your device clock is off. Check the clock and try again.");
      if (expirationTime !== undefined && issuedAt > expirationTime) return fail(400, "malformed", "Signed message expires before it was issued.");
    }
    if (expirationTime !== undefined && expirationTime <= t) return fail(401, "expired", "Sign-in request expired, try again.");
    if (notBefore !== undefined && notBefore - SIGN_IN_CLOCK_SKEW_MS > t) return fail(401, "expired", "Sign-in request is not valid yet. Check your device clock and try again.");

    if (!verifyAny([signed], sigs, pk.toBytes())) return fail(401, "invalid_signature", "Signature does not match this wallet.");
  }

  /**
   * (c) Hardware-wallet fallback: a signed (never broadcast) transaction whose fee payer is the wallet and whose
   * only instructions are optional ComputeBudget + exactly one SPL Memo `sealed-login:<nonce>`.
   */
  private checkMemoTx(serialized: string, wallet: string, nonce: string, pk: PublicKey): void {
    const notLogin = () => fail(401, "invalid_transaction", "This transaction is not a Sealed sign-in request.");
    let tx: VersionedTransaction | null = null;
    for (const bytes of decodeBinaryCandidates(serialized)) {
      if (bytes.length > 1232) continue;
      try {
        tx = VersionedTransaction.deserialize(bytes);
        break;
      } catch {
        /* try next decoding */
      }
    }
    if (!tx) return fail(400, "malformed", "Signed transaction could not be read (expected base64).");
    const msg = tx.message;
    const keys = msg.staticAccountKeys;
    if (msg.header.numRequiredSignatures !== 1 || tx.signatures.length !== 1) return notLogin();
    if (!keys.length || keys[0]!.toBase58() !== wallet) {
      return fail(401, "wallet_mismatch", "The transaction was signed by a different wallet than the one connected.");
    }
    if (msg.addressTableLookups.length > 0) return notLogin();
    let memos = 0;
    let budget = 0;
    const memoText = `${AUTH_LOGIN_MEMO_PREFIX}${nonce}`;
    for (const ix of msg.compiledInstructions) {
      const program = keys[ix.programIdIndex]?.toBase58();
      if (!program) return notLogin();
      if (program === COMPUTE_BUDGET_PROGRAM_ID) {
        // SetComputeUnitLimit (2) / SetComputeUnitPrice (3) only; no accounts.
        if (ix.accountKeyIndexes.length || !(ix.data[0] === 2 || ix.data[0] === 3) || ++budget > 2) return notLogin();
      } else if (MEMO_PROGRAM_IDS.has(program)) {
        if (++memos > 1) return notLogin();
        if (ix.accountKeyIndexes.some((k) => k !== 0)) return notLogin();
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(ix.data);
        } catch {
          return notLogin();
        }
        if (!safeEqual(text, memoText)) {
          return text.startsWith(AUTH_LOGIN_MEMO_PREFIX)
            ? fail(401, "nonce_mismatch", "Signed transaction does not belong to this sign-in request. Please try again.")
            : notLogin();
        }
      } else return notLogin();
    }
    if (memos !== 1) return notLogin();
    const sig = tx.signatures[0]!;
    if (sig.length !== 64 || sig.every((b) => b === 0)) return fail(401, "invalid_signature", "The transaction is not signed.");
    if (!ed25519Verify(msg.serialize(), sig, pk.toBytes())) return fail(401, "invalid_signature", "Signature does not match this wallet.");
  }

  async resolve(token: string): Promise<Session | null> {
    if (!token || token.length > 128) return null;
    const s = await this.repo.getSession(sha256Hex(token));
    if (!s || s.revokedAt || s.expiresAt.getTime() <= this.now().getTime()) return null;
    return { wallet: s.wallet, expiresAt: s.expiresAt };
  }

  async logout(token: string): Promise<void> {
    await this.repo.revokeSession(sha256Hex(token), this.now());
  }
}

function assertPubkey(wallet: string): PublicKey {
  try {
    const pk = new PublicKey(wallet);
    if (pk.toBase58() !== wallet) throw new Error("non-canonical");
    return pk;
  } catch {
    throw new AuthError(400, "Invalid wallet address.", "malformed");
  }
}
