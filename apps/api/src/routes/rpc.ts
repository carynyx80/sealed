import type { FastifyInstance, FastifyReply } from "fastify";
import { RPC_PROXY_LIMITS, RPC_PROXY_METHODS } from "@sealed/shared";
import type { AppContext } from "../context.js";
import { RateLimiter } from "../offchain/auth/rateLimit.js";
import { custodyRpcUrl } from "../offchain/custody/config.js";
import { redact, type FetchFn } from "../offchain/custody/rpc.js";

export interface RpcProxyOptions {
  /** Upstream JSON-RPC url (contains the Helius key; never returned or logged). Default: Helius for cfg.network. */
  upstreamUrl?: string | null;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  now?: () => number;
}

const ALLOWED = new Set<string>(RPC_PROXY_METHODS);
const UPSTREAM_TIMEOUT_MS = 15_000;

interface RpcReq {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown[] | Record<string, unknown>;
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function validate(x: unknown): { ok: true; req: RpcReq } | { ok: false; status: number; code: number; message: string; id: unknown } {
  if (!x || typeof x !== "object" || Array.isArray(x)) return { ok: false, status: 400, code: -32600, message: "invalid request", id: null };
  const o = x as Record<string, unknown>;
  const id = o.id;
  if (o.jsonrpc !== "2.0") return { ok: false, status: 400, code: -32600, message: "jsonrpc must be \"2.0\"", id };
  if (!(typeof id === "string" || typeof id === "number" || id === null || id === undefined)) return { ok: false, status: 400, code: -32600, message: "invalid id", id: null };
  if (typeof id === "string" && id.length > 128) return { ok: false, status: 400, code: -32600, message: "invalid id", id: null };
  if (typeof o.method !== "string") return { ok: false, status: 400, code: -32600, message: "method must be a string", id };
  if (!ALLOWED.has(o.method)) return { ok: false, status: 403, code: -32601, message: `method not allowed by proxy: ${o.method.slice(0, 64)}`, id };
  if (o.params !== undefined && (typeof o.params !== "object" || o.params === null)) return { ok: false, status: 400, code: -32602, message: "params must be an array or object", id };
  const extra = Object.keys(o).filter((k) => !["jsonrpc", "id", "method", "params"].includes(k));
  if (extra.length) return { ok: false, status: 400, code: -32600, message: "unexpected fields", id };
  return { ok: true, req: { jsonrpc: "2.0", id: (id ?? null) as RpcReq["id"], method: o.method, ...(o.params !== undefined ? { params: o.params as RpcReq["params"] } : {}) } };
}

/**
 * POST /api/rpc — JSON-RPC proxy for the web app / wallet so the Helius API key stays server-side.
 *  - network = cfg.network (Helius mainnet/devnet when HELIUS_API_KEY is set, else SOLANA_RPC_URL)
 *  - method allowlist (RPC_PROXY_METHODS), batches of ≤ 10, body ≤ 64 KB, HTTP only (no WebSocket subscriptions)
 *  - per-IP rate limits: 120 calls/min overall, 20 sendTransaction/min (each batch item counts)
 *  - CORS: the API's global CORS policy; the upstream URL / key is never echoed (responses + errors redacted)
 */
export async function rpcProxyRoutes(app: FastifyInstance, ctx: AppContext, opts: RpcProxyOptions = {}) {
  const upstream = opts.upstreamUrl !== undefined ? opts.upstreamUrl : custodyRpcUrl(ctx.cfg.network, ctx.cfg.heliusApiKey, ctx.cfg.rpcUrl) ?? null;
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const allLimit = new RateLimiter(RPC_PROXY_LIMITS.perIpPerMin, 60_000, opts.now);
  const sendLimit = new RateLimiter(RPC_PROXY_LIMITS.sendTxPerIpPerMin, 60_000, opts.now);
  if (!upstream) app.log.warn("rpc proxy: no upstream (HELIUS_API_KEY / SOLANA_RPC_URL) — POST /api/rpc answers 503");

  const fail = (reply: FastifyReply, status: number, body: unknown) => reply.code(status).header("cache-control", "no-store").send(body);

  app.post("/api/rpc", { bodyLimit: RPC_PROXY_LIMITS.maxBodyBytes }, async (req, reply) => {
    const body = req.body as unknown;
    const isBatch = Array.isArray(body);
    const items = isBatch ? (body as unknown[]) : [body];
    if (isBatch && (items.length === 0 || items.length > RPC_PROXY_LIMITS.maxBatch)) {
      return fail(reply, 400, rpcError(null, -32600, `batch must contain 1..${RPC_PROXY_LIMITS.maxBatch} requests`));
    }
    const reqs: RpcReq[] = [];
    for (const it of items) {
      const v = validate(it);
      if (!v.ok) return fail(reply, v.status, rpcError(v.id, v.code, v.message));
      reqs.push(v.req);
    }
    // Rate limits: count every item; sendTransaction has its own tighter bucket.
    for (const r of reqs) {
      if (!allLimit.hit(req.ip)) return fail(reply, 429, rpcError(r.id, -32029, "rate limit exceeded (rpc proxy)"));
      if (r.method === "sendTransaction" && !sendLimit.hit(req.ip)) return fail(reply, 429, rpcError(r.id, -32029, "rate limit exceeded (sendTransaction)"));
    }
    if (!upstream) return fail(reply, 503, rpcError(reqs[0]?.id, -32000, "rpc proxy unavailable (no upstream configured)"));

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await fetchFn(upstream, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(isBatch ? reqs : reqs[0]),
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError";
      req.log.warn({ err: redact((err as Error)?.message ?? String(err)) }, "rpc proxy: upstream error");
      return fail(reply, aborted ? 504 : 502, rpcError(reqs[0]?.id, -32000, aborted ? "upstream timeout" : "upstream unavailable"));
    } finally {
      clearTimeout(t);
    }
    if (res.status === 429) return fail(reply, 503, rpcError(reqs[0]?.id, -32000, "upstream busy, retry shortly"));
    if (res.status >= 500) return fail(reply, 502, rpcError(reqs[0]?.id, -32000, `upstream error (HTTP ${res.status})`));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail(reply, 502, rpcError(reqs[0]?.id, -32000, "upstream returned non-JSON"));
    }
    // Defence in depth: never let anything that looks like the upstream url/key reach the browser.
    const out = /api-key=|helius-rpc\.com/i.test(text) ? JSON.parse(redact(JSON.stringify(parsed))) : parsed;
    return reply.code(res.ok ? 200 : res.status).header("cache-control", "no-store").type("application/json").send(out);
  });
}
