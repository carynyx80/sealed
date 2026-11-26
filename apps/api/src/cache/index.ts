import type { FastifyBaseLogger } from "fastify";

/** Small cache + job-queue abstraction. Redis when REDIS_URL is set, otherwise in-process. */
export interface Cache {
  readonly kind: "redis" | "memory";
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Bump a namespace generation so every key built with `nsKey` for it is invalidated. */
  bump(ns: string): Promise<void>;
  nsKey(ns: string, key: string): Promise<string>;
  enqueue(queue: string, job: unknown): Promise<void>;
  dequeue<T>(queue: string): Promise<T | null>;
  close(): Promise<void>;
}

export class MemoryCache implements Cache {
  readonly kind = "memory" as const;
  private map = new Map<string, { v: unknown; exp: number }>();
  private queues = new Map<string, unknown[]>();
  private gens = new Map<string, number>();

  async get<T>(key: string): Promise<T | null> {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.exp < Date.now()) {
      this.map.delete(key);
      return null;
    }
    return e.v as T;
  }
  async set(key: string, value: unknown, ttlSec: number) {
    this.map.set(key, { v: value, exp: Date.now() + ttlSec * 1000 });
    if (this.map.size > 5000) for (const [k, e] of this.map) if (e.exp < Date.now()) this.map.delete(k);
  }
  async del(key: string) {
    this.map.delete(key);
  }
  async bump(ns: string) {
    this.gens.set(ns, (this.gens.get(ns) ?? 0) + 1);
  }
  async nsKey(ns: string, key: string) {
    return `${ns}:${this.gens.get(ns) ?? 0}:${key}`;
  }
  async enqueue(queue: string, job: unknown) {
    const q = this.queues.get(queue) ?? [];
    q.push(job);
    this.queues.set(queue, q);
  }
  async dequeue<T>(queue: string): Promise<T | null> {
    return (this.queues.get(queue)?.shift() as T | undefined) ?? null;
  }
  async close() {
    this.map.clear();
  }
}

type RedisLike = {
  get(k: string): Promise<string | null>;
  set(k: string, v: string, mode: "EX", ttl: number): Promise<unknown>;
  del(k: string): Promise<unknown>;
  incr(k: string): Promise<number>;
  rpush(k: string, v: string): Promise<unknown>;
  lpop(k: string): Promise<string | null>;
  quit(): Promise<unknown>;
  connect(): Promise<void>;
  on(ev: string, fn: (...a: unknown[]) => void): unknown;
};

export class RedisCache implements Cache {
  readonly kind = "redis" as const;
  constructor(private r: RedisLike, private prefix = "sealed:") {}
  async get<T>(key: string): Promise<T | null> {
    const v = await this.r.get(this.prefix + key);
    return v ? (JSON.parse(v) as T) : null;
  }
  async set(key: string, value: unknown, ttlSec: number) {
    await this.r.set(this.prefix + key, JSON.stringify(value), "EX", Math.max(1, Math.ceil(ttlSec)));
  }
  async del(key: string) {
    await this.r.del(this.prefix + key);
  }
  async bump(ns: string) {
    await this.r.incr(`${this.prefix}gen:${ns}`);
  }
  async nsKey(ns: string, key: string) {
    const g = (await this.r.get(`${this.prefix}gen:${ns}`)) ?? "0";
    return `${ns}:${g}:${key}`;
  }
  async enqueue(queue: string, job: unknown) {
    await this.r.rpush(`${this.prefix}q:${queue}`, JSON.stringify(job));
  }
  async dequeue<T>(queue: string): Promise<T | null> {
    const v = await this.r.lpop(`${this.prefix}q:${queue}`);
    return v ? (JSON.parse(v) as T) : null;
  }
  async close() {
    await this.r.quit().catch(() => undefined);
  }
}

export async function createCache(redisUrl: string | undefined, log: FastifyBaseLogger): Promise<Cache> {
  if (!redisUrl) return new MemoryCache();
  try {
    const { Redis } = (await import("ioredis")) as unknown as { Redis: new (url: string, opts: object) => RedisLike };
    const r = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false, connectTimeout: 5000 });
    r.on("error", (err) => log.warn({ err }, "redis error"));
    await Promise.race([r.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error("redis connect timeout")), 6000))]);
    log.info("cache: redis");
    return new RedisCache(r);
  } catch (err) {
    log.error({ err }, "cache: redis unavailable, falling back to memory");
    return new MemoryCache();
  }
}

/** Read-through helper; cache failures never break a request. */
export async function cached<T>(cache: Cache, key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  try {
    const hit = await cache.get<T>(key);
    if (hit !== null) return hit;
  } catch {
    /* ignore */
  }
  const v = await fn();
  cache.set(key, v, ttlSec).catch(() => undefined);
  return v;
}
