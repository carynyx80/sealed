import type { PrismaClient, Deposit as DepositRow, Withdrawal as WithdrawalRow } from "@prisma/client";
import type { DepositStatus, QuoteAssetSymbol, WithdrawalStatus } from "@sealed/shared";
import { newDepositRef, type CustodyRepo, type DepositRec, type NonceRec, type SessionRec, type UserRec, type WithdrawalRec } from "./repo.js";

/** Postgres custody persistence (models User / AuthNonce / Session / Deposit / Withdrawal in schema.prisma). */
export class PrismaCustodyRepo implements CustodyRepo {
  readonly kind = "postgres" as const;
  private db!: PrismaClient;

  constructor(private readonly url: string) {}

  async init(): Promise<void> {
    type Mod = { PrismaClient: typeof PrismaClient };
    const raw = (await import("@prisma/client")) as unknown as Partial<Mod> & { default?: Mod };
    const mod = (raw.PrismaClient ? raw : raw.default!) as Mod;
    this.db = new mod.PrismaClient({ datasources: { db: { url: this.url } } });
    await this.db.$connect();
    await this.db.user.count(); // fail fast if the schema was not pushed
  }
  async close(): Promise<void> {
    await this.db?.$disconnect();
  }

  async getUser(wallet: string): Promise<UserRec | null> {
    return this.db.user.findUnique({ where: { wallet } });
  }
  async getUserByDepositRef(ref: string): Promise<UserRec | null> {
    return this.db.user.findUnique({ where: { depositRef: ref } });
  }
  async ensureUser(wallet: string): Promise<UserRec> {
    for (let i = 0; i < 5; i++) {
      const u = await this.db.user.findUnique({ where: { wallet } });
      if (u) return u;
      try {
        return await this.db.user.create({ data: { wallet, depositRef: newDepositRef() } });
      } catch (e) {
        if ((e as { code?: string }).code !== "P2002") throw e; // unique race (wallet or ref) → retry
      }
    }
    throw new Error("could not create user");
  }

  async createNonce(rec: NonceRec): Promise<void> {
    await this.db.authNonce.create({ data: rec });
  }
  async consumeNonce(nonce: string, now: Date): Promise<NonceRec | null> {
    const r = await this.db.authNonce.updateMany({ where: { nonce, usedAt: null }, data: { usedAt: now } });
    if (r.count !== 1) return null;
    return this.db.authNonce.findUnique({ where: { nonce } });
  }
  async pruneNonces(now: Date): Promise<void> {
    await this.db.authNonce.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 3_600_000) } } });
  }

  async createSession(rec: SessionRec): Promise<void> {
    await this.db.session.create({ data: rec });
  }
  async getSession(tokenHash: string): Promise<SessionRec | null> {
    return this.db.session.findUnique({ where: { tokenHash } });
  }
  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await this.db.session.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: now } });
  }

  async getDeposit(key: string): Promise<DepositRec | null> {
    const r = await this.db.deposit.findUnique({ where: { key } });
    return r ? dep(r) : null;
  }
  async insertDeposit(rec: DepositRec): Promise<boolean> {
    try {
      await this.db.deposit.create({ data: rec });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return false;
      throw e;
    }
  }
  async updateDeposit(key: string, patch: Partial<Pick<DepositRec, "status" | "reason" | "creditedAt" | "wallet">>): Promise<void> {
    await this.db.deposit.update({ where: { key }, data: patch });
  }
  async listDepositsBySignature(signature: string): Promise<DepositRec[]> {
    return (await this.db.deposit.findMany({ where: { signature } })).map(dep);
  }
  async listDepositsByWallet(wallet: string, limit = 100): Promise<DepositRec[]> {
    return (await this.db.deposit.findMany({ where: { wallet }, orderBy: { createdAt: "desc" }, take: limit })).map(dep);
  }
  async listDepositsByStatus(statuses: DepositStatus[], limit = 100): Promise<DepositRec[]> {
    return (await this.db.deposit.findMany({ where: { status: { in: statuses } }, orderBy: { createdAt: "asc" }, take: limit })).map(dep);
  }

  async insertWithdrawal(rec: WithdrawalRec): Promise<void> {
    await this.db.withdrawal.create({ data: rec });
  }
  async getWithdrawal(id: string): Promise<WithdrawalRec | null> {
    const r = await this.db.withdrawal.findUnique({ where: { id } });
    return r ? wd(r) : null;
  }
  async listWithdrawalsByWallet(wallet: string, limit = 100): Promise<WithdrawalRec[]> {
    return (await this.db.withdrawal.findMany({ where: { wallet }, orderBy: { createdAt: "desc" }, take: limit })).map(wd);
  }
  async listWithdrawalsByStatus(statuses: WithdrawalStatus[], limit = 100): Promise<WithdrawalRec[]> {
    return (await this.db.withdrawal.findMany({ where: { status: { in: statuses } }, orderBy: { createdAt: "asc" }, take: limit })).map(wd);
  }
  async transitionWithdrawal(id: string, from: WithdrawalStatus[], patch: Partial<Omit<WithdrawalRec, "id" | "wallet" | "createdAt">>): Promise<WithdrawalRec | null> {
    // Conditional UPDATE … WHERE status IN (from) — atomic compare-and-set across processes.
    const r = await this.db.withdrawal.updateMany({ where: { id, status: { in: from } }, data: patch });
    if (r.count !== 1) return null;
    return this.getWithdrawal(id);
  }
  async withdrawnUsdSince(wallet: string, since: Date): Promise<number> {
    const r = await this.db.withdrawal.aggregate({
      where: { wallet, createdAt: { gte: since }, status: { notIn: ["rejected", "failed"] } },
      _sum: { usdValue: true },
    });
    return r._sum.usdValue ?? 0;
  }
}

const dep = (r: DepositRow): DepositRec => ({ ...r, asset: r.asset as QuoteAssetSymbol | null, status: r.status as DepositStatus });
const wd = (r: WithdrawalRow): WithdrawalRec => ({ ...r, asset: r.asset as QuoteAssetSymbol, status: r.status as WithdrawalStatus });
