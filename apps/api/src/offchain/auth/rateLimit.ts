/** Fixed-window in-memory limiter (per process). Keys are e.g. `${route}:${ip}` / `${route}:${wallet}`. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private readonly limit: number, private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}

  /** Returns true if the call is allowed (and counts it). */
  hit(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || h.reset <= t) {
      this.hits.set(key, { n: 1, reset: t + this.windowMs });
      if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }
}
