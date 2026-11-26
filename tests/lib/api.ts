/**
 * Tiny HTTP client for the Sealed API (custody routes) shared by tests/e2e/custody.e2e.test.ts and
 * scripts/devnet-smoke.ts. Tokens are kept in memory only and never printed.
 */
import { CUSTODY_ROUTES, type AuthNonceResponse, type AuthVerifyResponse } from "@sealed/shared";
import { b58encode, type TestKeypair } from "./solana.ts";

export interface HttpResult<T> {
  status: number;
  body: T & { error?: string };
  text: string;
}

export class ApiClient {
  token: string | null = null;
  constructor(readonly base: string, readonly headers: Record<string, string> = {}) {}

  private async req<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<HttpResult<T>> {
    const h: Record<string, string> = { ...this.headers, ...extra };
    if (body !== undefined) h["content-type"] = "application/json";
    if (this.token) h.authorization = `Bearer ${this.token}`;
    const res = await fetch(this.base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* non-json */
    }
    return { status: res.status, body: parsed as T & { error?: string }, text };
  }
  get<T>(path: string, extra?: Record<string, string>) {
    return this.req<T>("GET", path, undefined, extra);
  }
  post<T>(path: string, body: unknown = {}, extra?: Record<string, string>) {
    return this.req<T>("POST", path, body, extra);
  }

  /** SIWS: nonce → sign the exact server message → verify → bearer token. */
  async signIn(kp: TestKeypair): Promise<AuthVerifyResponse> {
    const n = await this.post<AuthNonceResponse>(CUSTODY_ROUTES.nonce, { wallet: kp.address });
    if (n.status !== 200) throw new Error(`auth nonce failed: HTTP ${n.status} ${n.body.error ?? ""}`);
    if (!n.body.message.includes(kp.address) || !n.body.message.includes(n.body.nonce)) throw new Error("SIWS message does not bind wallet+nonce");
    const signature = b58encode(kp.sign(new TextEncoder().encode(n.body.message)));
    const v = await this.post<AuthVerifyResponse>(CUSTODY_ROUTES.verify, { wallet: kp.address, nonce: n.body.nonce, signature });
    if (v.status !== 200) throw new Error(`auth verify failed: HTTP ${v.status} ${v.body.error ?? ""}`);
    this.token = v.body.token;
    return v.body;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns a truthy value or the deadline passes. */
export async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, everyMs = 150): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}
