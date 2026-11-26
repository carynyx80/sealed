import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";

/** A processed token image (always 512×512 WebP). */
export interface TokenImageRec {
  id: string;
  owner: string;
  mime: string;
  bytes: Buffer;
  width: number;
  height: number;
  sha256: string;
  createdAt: Date;
}

export interface ImageStore {
  readonly kind: "postgres" | "memory";
  get(id: string): Promise<TokenImageRec | null>;
  /** Insert, or return the owner's existing image with the same sha256 (dedupe). */
  put(rec: TokenImageRec): Promise<{ rec: TokenImageRec; deduped: boolean }>;
  close(): Promise<void>;
}

/** In-memory LRU bounded by total encoded bytes (tests / local dev without DATABASE_URL). */
export class MemoryImageStore implements ImageStore {
  readonly kind = "memory" as const;
  private byId = new Map<string, TokenImageRec>();
  private byOwnerSha = new Map<string, string>();
  private total = 0;

  constructor(private readonly capBytes = 50 * 1024 * 1024) {}

  async get(id: string): Promise<TokenImageRec | null> {
    const rec = this.byId.get(id);
    if (!rec) return null;
    this.byId.delete(id); // LRU touch
    this.byId.set(id, rec);
    return rec;
  }

  async put(rec: TokenImageRec): Promise<{ rec: TokenImageRec; deduped: boolean }> {
    const key = `${rec.owner}:${rec.sha256}`;
    const existingId = this.byOwnerSha.get(key);
    const existing = existingId ? await this.get(existingId) : null;
    if (existing) return { rec: existing, deduped: true };
    this.byId.set(rec.id, rec);
    this.byOwnerSha.set(key, rec.id);
    this.total += rec.bytes.length;
    while (this.total > this.capBytes && this.byId.size > 1) {
      const [oldId, old] = this.byId.entries().next().value as [string, TokenImageRec];
      this.byId.delete(oldId);
      this.byOwnerSha.delete(`${old.owner}:${old.sha256}`);
      this.total -= old.bytes.length;
    }
    return { rec, deduped: false };
  }

  async close(): Promise<void> {}
}

/** Postgres persistence (model TokenImage in schema.prisma). */
export class PrismaImageStore implements ImageStore {
  readonly kind = "postgres" as const;
  private db!: PrismaClient;

  constructor(private readonly url: string) {}

  async init(): Promise<void> {
    type Mod = { PrismaClient: typeof PrismaClient };
    const raw = (await import("@prisma/client")) as unknown as Partial<Mod> & { default?: Mod };
    const mod = (raw.PrismaClient ? raw : raw.default!) as Mod;
    this.db = new mod.PrismaClient({ datasources: { db: { url: this.url } } });
    await this.db.$connect();
    await this.db.tokenImage.count(); // fail fast if the schema was not pushed
  }

  async close(): Promise<void> {
    await this.db?.$disconnect();
  }

  async get(id: string): Promise<TokenImageRec | null> {
    const r = await this.db.tokenImage.findUnique({ where: { id } });
    return r ? { ...r, bytes: Buffer.from(r.bytes) } : null;
  }

  async put(rec: TokenImageRec): Promise<{ rec: TokenImageRec; deduped: boolean }> {
    const find = () => this.db.tokenImage.findUnique({ where: { owner_sha256: { owner: rec.owner, sha256: rec.sha256 } } });
    const existing = await find();
    if (existing) return { rec: { ...existing, bytes: Buffer.from(existing.bytes) }, deduped: true };
    try {
      const r = await this.db.tokenImage.create({ data: rec });
      return { rec: { ...r, bytes: Buffer.from(r.bytes) }, deduped: false };
    } catch (err) {
      // Concurrent identical upload by the same owner → unique violation; return the winner.
      if ((err as { code?: string }).code === "P2002") {
        const again = await find();
        if (again) return { rec: { ...again, bytes: Buffer.from(again.bytes) }, deduped: true };
      }
      throw err;
    }
  }
}

/** Postgres when DATABASE_URL is set (falls back to memory if unavailable), otherwise the in-memory LRU. */
export async function createImageStore(databaseUrl: string | undefined, log: FastifyBaseLogger): Promise<ImageStore> {
  if (databaseUrl) {
    try {
      const s = new PrismaImageStore(databaseUrl);
      await s.init();
      log.info("images: postgres");
      return s;
    } catch (err) {
      log.error({ err }, "images: postgres unavailable, falling back to in-memory store (uploads will not survive restarts)");
    }
  }
  return new MemoryImageStore();
}
