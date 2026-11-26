import { randomBytes } from "node:crypto";
import type { DepositStatus, QuoteAssetSymbol, WithdrawalStatus } from "@sealed/shared";

/**
 * Persistence port for the custody layer (users, SIWS nonces, sessions, deposits, withdrawals).
 * MemoryCustodyRepo backs tests / demo; PrismaCustodyRepo (prismaRepo.ts) backs Postgres.
 * All money is BigInt atoms. Never store raw session tokens — only their SHA-256 hash.
 */

export interface UserRec {
  wallet: string;
  depositRef: string;
  createdAt: Date;
}
export interface NonceRec {
  nonce: string;
  wallet: string;
  message: string;
  expiresAt: Date;
  usedAt: Date | null;
}
export interface SessionRec {
  tokenHash: string; // sha256(token) hex
  wallet: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}
export interface DepositRec {
  /** `${signature}:${instructionIndex}` — the exactly-once credit key. */
  key: string;
  signature: string;
  ixIndex: string; // "3" top-level, "3.1" inner
  wallet: string | null; // resolved from depositRef, null if unknown
  depositRef: string | null;
  asset: QuoteAssetSymbol | null;
  mint: string | null; // null for native SOL
  amountAtoms: bigint;
  sender: string | null;
  status: DepositStatus;
  reason: string | null;
  slot: number;
  blockTime: number | null;
  createdAt: Date;
  creditedAt: Date | null;
}
export interface WithdrawalRec {
  id: string;
  wallet: string;
  asset: QuoteAssetSymbol;
  mint: string | null;
  amountAtoms: bigint;
  destination: string;
  usdValue: number;
  status: WithdrawalStatus;
  reason: string | null;
  /** Payout idempotency: the signed tx is persisted BEFORE broadcast. */
  signature: string | null;
  rawTx: string | null; // base64 serialized signed tx
  blockhash: string | null;
  lastValidBlockHeight: number | null;
  attempts: number;
  approvedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
}

/**
 * Privacy Ring link: a separate "private Sealed wallet" (burner Ed25519 key, derived in the browser from a plain-text
 * signature of the user's main wallet) that owns the user's ring identity. At most ONE active link per account and per
 * burner; replaced / revoked links are kept as history (active=false, revokedAt set) and stop attributing deposits.
 */
export interface PrivacyLinkRec {
  id: string;
  /** The Sealed account (sign-in wallet). */
  wallet: string;
  burner: string;
  active: boolean;
  createdAt: Date;
  revokedAt: Date | null;
}
export type SetPrivacyLinkResult = { ok: true; rec: PrivacyLinkRec; changed: boolean } | { ok: false; code: "burner_taken" };

export interface CustodyRepo {
  readonly kind: "memory" | "postgres";
  // users
  getUser(wallet: string): Promise<UserRec | null>;
  getUserByDepositRef(ref: string): Promise<UserRec | null>;
  /** Create on first sign-in (with a fresh stable depositRef), else return existing. */
  ensureUser(wallet: string): Promise<UserRec>;
  // nonces
  createNonce(rec: NonceRec): Promise<void>;
  /** Atomically mark a nonce used. Returns the record only if it existed and was unused. */
  consumeNonce(nonce: string, now: Date): Promise<NonceRec | null>;
  pruneNonces(now: Date): Promise<void>;
  // sessions
  createSession(rec: SessionRec): Promise<void>;
  getSession(tokenHash: string): Promise<SessionRec | null>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
  // deposits
  getDeposit(key: string): Promise<DepositRec | null>;
  /** Insert-if-absent on `key`. Returns false when a row already exists (no overwrite). */
  insertDeposit(rec: DepositRec): Promise<boolean>;
  updateDeposit(key: string, patch: Partial<Pick<DepositRec, "status" | "reason" | "creditedAt" | "wallet">>): Promise<void>;
  listDepositsBySignature(signature: string): Promise<DepositRec[]>;
  listDepositsByWallet(wallet: string, limit?: number): Promise<DepositRec[]>;
  listDepositsByStatus(statuses: DepositStatus[], limit?: number): Promise<DepositRec[]>;
  // withdrawals
  insertWithdrawal(rec: WithdrawalRec): Promise<void>;
  getWithdrawal(id: string): Promise<WithdrawalRec | null>;
  listWithdrawalsByWallet(wallet: string, limit?: number): Promise<WithdrawalRec[]>;
  listWithdrawalsByStatus(statuses: WithdrawalStatus[], limit?: number): Promise<WithdrawalRec[]>;
  /** Compare-and-set: applies `patch` only if current status ∈ `from`. Returns the updated row or null. */
  transitionWithdrawal(id: string, from: WithdrawalStatus[], patch: Partial<Omit<WithdrawalRec, "id" | "wallet" | "createdAt">>): Promise<WithdrawalRec | null>;
  /** USD value of this wallet's withdrawals since `since` that are not rejected/failed (daily cap). */
  withdrawnUsdSince(wallet: string, since: Date): Promise<number>;
  // privacy links (burner → account)
  getActivePrivacyLink(wallet: string): Promise<PrivacyLinkRec | null>;
  getActivePrivacyLinkByBurner(burner: string): Promise<PrivacyLinkRec | null>;
  /**
   * Atomically make `burner` the account's only active link: same burner → idempotent (changed=false); another
   * burner → the old link is revoked (history kept). Burner active for a different account → burner_taken.
   */
  setPrivacyLink(wallet: string, burner: string, now: Date): Promise<SetPrivacyLinkResult>;
  /** Revoke the account's active link (if any). Returns true when one was revoked. */
  revokePrivacyLink(wallet: string, now: Date): Promise<boolean>;
  close?(): Promise<void>;
}

const REF_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/1/l — easy to type into a memo
export function newDepositRef(len = 10): string {
  const b = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += REF_ALPHABET[b[i]! % REF_ALPHABET.length];
  return s;
}
export const DEPOSIT_REF_RE = /^[a-z2-9]{6,32}$/;

export class MemoryCustodyRepo implements CustodyRepo {
  readonly kind = "memory" as const;
  private users = new Map<string, UserRec>();
  private refs = new Map<string, string>();
  private nonces = new Map<string, NonceRec>();
  private sessions = new Map<string, SessionRec>();
  private deposits = new Map<string, DepositRec>();
  private withdrawals = new Map<string, WithdrawalRec>();
  private links: PrivacyLinkRec[] = [];

  async getUser(wallet: string) {
    return this.users.get(wallet) ?? null;
  }
  async getUserByDepositRef(ref: string) {
    const w = this.refs.get(ref);
    return w ? this.users.get(w) ?? null : null;
  }
  async ensureUser(wallet: string) {
    const u = this.users.get(wallet);
    if (u) return u;
    let ref = newDepositRef();
    while (this.refs.has(ref)) ref = newDepositRef();
    const rec: UserRec = { wallet, depositRef: ref, createdAt: new Date() };
    this.users.set(wallet, rec);
    this.refs.set(ref, wallet);
    return rec;
  }
  async createNonce(rec: NonceRec) {
    this.nonces.set(rec.nonce, { ...rec });
  }
  async consumeNonce(nonce: string, now: Date) {
    const n = this.nonces.get(nonce);
    if (!n || n.usedAt) return null;
    n.usedAt = now;
    return { ...n };
  }
  async pruneNonces(now: Date) {
    for (const [k, v] of this.nonces) if (v.expiresAt.getTime() < now.getTime() - 3_600_000) this.nonces.delete(k);
  }
  async createSession(rec: SessionRec) {
    this.sessions.set(rec.tokenHash, { ...rec });
  }
  async getSession(h: string) {
    const s = this.sessions.get(h);
    return s ? { ...s } : null;
  }
  async revokeSession(h: string, now: Date) {
    const s = this.sessions.get(h);
    if (s) s.revokedAt = now;
  }
  async getDeposit(key: string) {
    const d = this.deposits.get(key);
    return d ? { ...d } : null;
  }
  async insertDeposit(rec: DepositRec) {
    if (this.deposits.has(rec.key)) return false;
    this.deposits.set(rec.key, { ...rec });
    return true;
  }
  async updateDeposit(key: string, patch: Partial<DepositRec>) {
    const d = this.deposits.get(key);
    if (d) Object.assign(d, patch);
  }
  async listDepositsBySignature(sig: string) {
    return [...this.deposits.values()].filter((d) => d.signature === sig).map((d) => ({ ...d }));
  }
  async listDepositsByWallet(wallet: string, limit = 100) {
    return [...this.deposits.values()]
      .filter((d) => d.wallet === wallet)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((d) => ({ ...d }));
  }
  async listDepositsByStatus(statuses: DepositStatus[], limit = 100) {
    return [...this.deposits.values()].filter((d) => statuses.includes(d.status)).slice(0, limit).map((d) => ({ ...d }));
  }
  async insertWithdrawal(rec: WithdrawalRec) {
    if (this.withdrawals.has(rec.id)) throw new Error("duplicate withdrawal id");
    this.withdrawals.set(rec.id, { ...rec });
  }
  async getWithdrawal(id: string) {
    const w = this.withdrawals.get(id);
    return w ? { ...w } : null;
  }
  async listWithdrawalsByWallet(wallet: string, limit = 100) {
    return [...this.withdrawals.values()]
      .filter((w) => w.wallet === wallet)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((w) => ({ ...w }));
  }
  async listWithdrawalsByStatus(statuses: WithdrawalStatus[], limit = 100) {
    return [...this.withdrawals.values()]
      .filter((w) => statuses.includes(w.status))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((w) => ({ ...w }));
  }
  async transitionWithdrawal(id: string, from: WithdrawalStatus[], patch: Partial<WithdrawalRec>) {
    const w = this.withdrawals.get(id);
    if (!w || !from.includes(w.status)) return null;
    Object.assign(w, patch, { updatedAt: new Date() });
    return { ...w };
  }
  async withdrawnUsdSince(wallet: string, since: Date) {
    let sum = 0;
    for (const w of this.withdrawals.values()) {
      if (w.wallet === wallet && w.createdAt >= since && w.status !== "rejected" && w.status !== "failed") sum += w.usdValue;
    }
    return sum;
  }
  async getActivePrivacyLink(wallet: string) {
    const l = this.links.find((x) => x.active && x.wallet === wallet);
    return l ? { ...l } : null;
  }
  async getActivePrivacyLinkByBurner(burner: string) {
    const l = this.links.find((x) => x.active && x.burner === burner);
    return l ? { ...l } : null;
  }
  async setPrivacyLink(wallet: string, burner: string, now: Date): Promise<SetPrivacyLinkResult> {
    const taken = this.links.find((x) => x.active && x.burner === burner);
    if (taken && taken.wallet !== wallet) return { ok: false, code: "burner_taken" };
    if (taken) return { ok: true, rec: { ...taken }, changed: false };
    for (const l of this.links) if (l.active && l.wallet === wallet) Object.assign(l, { active: false, revokedAt: now });
    const rec: PrivacyLinkRec = { id: randomBytes(12).toString("hex"), wallet, burner, active: true, createdAt: now, revokedAt: null };
    this.links.push(rec);
    return { ok: true, rec: { ...rec }, changed: true };
  }
  async revokePrivacyLink(wallet: string, now: Date) {
    let n = 0;
    for (const l of this.links) if (l.active && l.wallet === wallet) {
      Object.assign(l, { active: false, revokedAt: now });
      n++;
    }
    return n > 0;
  }
}
