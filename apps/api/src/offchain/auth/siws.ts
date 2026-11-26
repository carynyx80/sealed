import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { SIWS_STATEMENT, type AuthNonceResponse, type AuthVerifyResponse } from "@sealed/shared";
import type { CustodyRepo } from "../custody/repo.js";

export const NONCE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 3_600_000;

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Sign-In-With-Solana message (CAIP-122 style). The exact string is returned to the client, which signs its
 * UTF-8 bytes with `signMessage`; the server verifies against the stored copy (never a client-supplied one).
 */
export function buildSiwsMessage(p: { domain: string; wallet: string; nonce: string; issuedAt: Date; expiresAt: Date }): string {
  return [
    `${p.domain} wants you to sign in with your Solana account:`,
    p.wallet,
    "",
    SIWS_STATEMENT,
    "",
    `Domain: ${p.domain}`,
    `Wallet: ${p.wallet}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt.toISOString()}`,
    `Expiration Time: ${p.expiresAt.toISOString()}`,
  ].join("\n");
}

export class AuthError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface Session {
  wallet: string;
  expiresAt: Date;
}

export class AuthService {
  constructor(
    private readonly repo: CustodyRepo,
    private readonly domain: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issueNonce(wallet: string): Promise<AuthNonceResponse> {
    assertPubkey(wallet);
    const nonce = bs58.encode(randomBytes(24)); // ~32 chars
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
    const message = buildSiwsMessage({ domain: this.domain, wallet, nonce, issuedAt, expiresAt });
    await this.repo.createNonce({ nonce, wallet, message, expiresAt, usedAt: null });
    if (Math.random() < 0.05) void this.repo.pruneNonces(issuedAt).catch(() => undefined);
    return { nonce, message, expiresTs: Math.floor(expiresAt.getTime() / 1000) };
  }

  /** Single-use: the nonce is consumed on ANY verify attempt (good or bad), so it can never be replayed. */
  async verify(wallet: string, nonce: string, signatureB58: string): Promise<AuthVerifyResponse> {
    const pk = assertPubkey(wallet);
    const now = this.now();
    const rec = await this.repo.consumeNonce(nonce, now);
    if (!rec) throw new AuthError(401, "unknown or already-used nonce");
    if (rec.wallet !== wallet) throw new AuthError(401, "nonce was issued for a different wallet");
    if (rec.expiresAt.getTime() <= now.getTime()) throw new AuthError(401, "nonce expired");
    let sig: Uint8Array;
    try {
      sig = bs58.decode(signatureB58);
    } catch {
      throw new AuthError(400, "signature must be base58");
    }
    if (sig.length !== 64) throw new AuthError(400, "signature must be 64 bytes");
    const ok = nacl.sign.detached.verify(new TextEncoder().encode(rec.message), sig, pk.toBytes());
    if (!ok) throw new AuthError(401, "invalid signature");

    await this.repo.ensureUser(wallet);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.repo.createSession({ tokenHash: sha256Hex(token), wallet, createdAt: now, expiresAt, revokedAt: null });
    return { token, wallet, expiresTs: Math.floor(expiresAt.getTime() / 1000) };
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
    throw new AuthError(400, "invalid wallet");
  }
}
