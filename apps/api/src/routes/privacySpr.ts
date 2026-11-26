import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.js";
import type { PrivacyRuntime } from "../offchain/privacy/service.js";

/**
 * ALL /api/privacy/spr/* → https://{network}.helius-rpc.com/v1/spr/* (keyed passthrough for the browser SDK).
 *
 * The SDK resolves BOTH its indexer and its prover to the Helius RPC root's `/v1/spr` namespace (SDK
 * `resolveClientEndpoints` / `SPR_GATEWAY_PATH`; README "A unified Helius /v1/spr base URL can be used for both
 * indexerUrl and proverUrl"; https://www.helius.dev/docs/privacy/endpoints.md) and appends service paths below it
 * (indexer JSON-RPC `/{method}`, prover `/attestation`, `/prove/<key>`, `/prove/<key>/status`, `/prove/<key>/indexed`)
 * with the key as the `api-key` query parameter. The browser configures `indexerUrl = proverUrl = ${API}/api/privacy/spr`
 * and this route injects HELIUS_API_KEY server-side. Prover traffic is HPKE-encrypted to the attested TEE
 * (`Spr-Tee*` headers), so bytes are piped unchanged. Gated by PRIVACY_RING_ENABLED (503 when off).
 */
export const SPR_PROXY_PREFIX = "/api/privacy/spr";
export const SPR_PROXY_LIMITS = { maxBodyBytes: 2 * 1024 * 1024, perIpPerMin: 60, provePerIpPerMin: 10, timeoutMs: 90_000 } as const;

const FORWARD_REQ_HEADERS = ["content-type", "accept", "spr-tee", "spr-tee-enc", "spr-tee-ciphertext", "x-sync", "x-async"];
const FORWARD_RES_HEADERS = ["content-type", "spr-tee", "spr-tee-enc", "retry-after"];
const SAFE_PATH = /^[A-Za-z0-9_\-./]{1,256}$/;

function windowLimiter(perMinute: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + 60_000 });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return true;
    }
    h.n++;
    return h.n <= perMinute;
  };
}

export async function sprProxyRoutes(app: FastifyInstance, ctx: AppContext, privacy: PrivacyRuntime, fetchFn: typeof fetch = fetch) {
  const allow = windowLimiter(SPR_PROXY_LIMITS.perIpPerMin);
  const allowProve = windowLimiter(SPR_PROXY_LIMITS.provePerIpPerMin);
  const key = ctx.cfg.heliusApiKey;
  const network = ctx.cfg.network;
  const scrub = (s: string) => {
    let out = s.replace(/api-key=[^&\s"']+/gi, "api-key=***").replace(/https?:\/\/[^\s"']*helius-rpc\.com[^\s"']*/gi, "<helius>");
    if (key) out = out.split(key).join("***");
    return out;
  };

  await app.register(async (scope) => {
    // Raw bytes in, raw bytes out: no JSON parsing (prover bodies are encrypted).
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: SPR_PROXY_LIMITS.maxBodyBytes }, (_req, body, done) => done(null, body));

    const handler = async (req: FastifyRequest, reply: import("fastify").FastifyReply) => {
      reply.header("cache-control", "no-store");
      reply.header("access-control-expose-headers", "Spr-Tee, Spr-Tee-Enc, Retry-After");
      if (!privacy.config.enabled) return reply.code(503).send({ enabled: false, reason: privacy.reason ?? "unavailable" });
      if (!key || (network !== "mainnet" && network !== "devnet") || ctx.cfg.isDemo) {
        return reply.code(503).send({ enabled: false, reason: privacy.reason ?? "Privacy Rings are not available on this network." });
      }
      const rest = (req.params as { "*": string })["*"] ?? "";
      if (!SAFE_PATH.test(rest) || rest.split("/").some((seg) => seg === ".." || seg === ".")) return reply.code(400).send({ error: "invalid path" });
      if (!allow(req.ip)) return reply.code(429).send({ error: "privacy proxy rate limit exceeded" });
      if (/(^|\/)prove(\/|$)/.test(rest) && req.method === "POST" && !allowProve(req.ip)) return reply.code(429).send({ error: "proof rate limit exceeded" });

      const url = new URL(`https://${network}.helius-rpc.com/v1/spr/${rest.replace(/^\/+/, "")}`);
      const q = req.url.indexOf("?");
      if (q >= 0) for (const [k, v] of new URLSearchParams(req.url.slice(q + 1))) if (k.toLowerCase() !== "api-key") url.searchParams.append(k, v);
      url.searchParams.set("api-key", key);

      const headers: Record<string, string> = {};
      for (const h of FORWARD_REQ_HEADERS) {
        const v = req.headers[h];
        if (typeof v === "string" && v.length <= 4 * 1024 * 1024) headers[h] = v;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), SPR_PROXY_LIMITS.timeoutMs);
      const onClose = () => {
        if (!reply.raw.writableEnded) ctrl.abort(); // client went away before the upstream answered
      };
      reply.raw.once("close", onClose);
      try {
        const body = req.method === "POST" ? (Buffer.isBuffer(req.body) ? req.body : req.body == null ? undefined : Buffer.from(String(req.body))) : undefined;
        const res = await fetchFn(url, { method: req.method, headers, body: body ? new Uint8Array(body) : undefined, signal: ctrl.signal });
        reply.code(res.status);
        for (const h of FORWARD_RES_HEADERS) {
          const v = res.headers.get(h);
          if (v) reply.header(h, v);
        }
        if (!res.ok || !res.body) {
          // Errors are buffered and scrubbed (an upstream error may quote the request URL with the key).
          const text = scrub(await res.text().catch(() => ""));
          return reply.send(text);
        }
        return reply.send(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>));
      } catch (e) {
        const aborted = (e as Error)?.name === "AbortError";
        return reply.code(aborted ? 504 : 502).send({ error: aborted ? "privacy upstream timed out" : scrub(`privacy upstream unreachable: ${(e as Error)?.message ?? ""}`).slice(0, 200) });
      } finally {
        clearTimeout(timer);
        reply.raw.off("close", onClose);
      }
    };
    scope.route({ method: ["GET", "POST"], url: `${SPR_PROXY_PREFIX}/*`, bodyLimit: SPR_PROXY_LIMITS.maxBodyBytes, handler });
  });
}
