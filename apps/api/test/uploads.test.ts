import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import sharp from "sharp";
import { loadConfig } from "../src/config.js";
import { MemoryRepo } from "../src/offchain/repo/memory.js";
import { buildServer, type App } from "../src/server.js";
import { MemoryImageStore } from "../src/uploads/imageStore.js";
import { sniffImageType } from "../src/uploads/process.js";
import { makeApp, validLaunch } from "./helpers.js";
import { bearer, installDevAuth } from "./offchain.helpers.js";

const wallet = () => Keypair.generate().publicKey.toBase58();

function multipart(file: Buffer, opts: { filename?: string; contentType?: string; field?: string } = {}) {
  const boundary = `----sealedtest${randomBytes(8).toString("hex")}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${opts.field ?? "file"}"; filename="${opts.filename ?? "token.png"}"\r\n` +
      `Content-Type: ${opts.contentType ?? "image/png"}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, file, tail]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

const solid = (w: number, h: number, rgb = { r: 200, g: 40, b: 90 }) => sharp({ create: { width: w, height: h, channels: 3, background: rgb } });
const png = (w = 300, h = 200) => solid(w, h).png().toBuffer();
const jpg = (w = 640, h = 480) => solid(w, h, { r: 10, g: 120, b: 250 }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
const webp = (w = 256, h = 256) => solid(w, h, { r: 5, g: 200, b: 5 }).webp().toBuffer();
async function gif(w = 128, h = 96): Promise<Buffer> {
  const a = await solid(w, h, { r: 255, g: 0, b: 0 }).png().toBuffer();
  const b = await solid(w, h, { r: 0, g: 0, b: 255 }).png().toBuffer();
  return sharp([a, b], { join: { animated: true } }).gif({ delay: [100, 100] }).toBuffer();
}

async function upload(app: App, who: string | null, file: Buffer, opts?: Parameters<typeof multipart>[1]) {
  const mp = multipart(file, opts);
  return app.inject({ method: "POST", url: "/api/uploads/token-image", headers: { ...mp.headers, ...(who ? bearer(who) : {}) }, payload: mp.payload });
}

describe("token image uploads", () => {
  let app: App;
  before(async () => {
    app = await makeApp({ DEMO_MODE: "true" });
    installDevAuth(app);
  });
  after(async () => {
    await app.close();
  });

  for (const [name, make, ct] of [
    ["png", () => png(), "image/png"],
    ["jpg", () => jpg(), "image/jpeg"],
    ["webp", () => webp(), "image/webp"],
    ["gif (animated → first frame)", () => gif(), "image/gif"],
  ] as const) {
    it(`${name} → 201, 512×512 webp without metadata`, async () => {
      const w = wallet();
      const src = await make();
      const r = await upload(app, w, src, { contentType: ct, filename: `x.${name.slice(0, 3)}` });
      assert.equal(r.statusCode, 201, r.body);
      const body = r.json();
      assert.match(body.id, /^[0-9a-f]{32}$/);
      assert.equal(body.url, `http://localhost/api/images/${body.id}.webp`);
      assert.equal(body.width, 512);
      assert.equal(body.height, 512);
      assert.equal(body.mime, "image/webp");
      const g = await app.inject({ method: "GET", url: `/api/images/${body.id}.webp` });
      assert.equal(g.statusCode, 200);
      assert.equal(g.headers["content-type"], "image/webp");
      assert.equal(g.rawPayload.length, body.bytes);
      const meta = await sharp(g.rawPayload).metadata();
      assert.equal(meta.format, "webp");
      assert.equal(meta.width, 512);
      assert.equal(meta.height, 512);
      assert.equal(meta.pages ?? 1, 1);
      assert.equal(meta.exif, undefined);
      assert.equal(meta.icc, undefined);
      assert.equal(meta.xmp, undefined);
      if (name.startsWith("gif")) {
        const { data } = await sharp(g.rawPayload).raw().toBuffer({ resolveWithObject: true });
        assert.ok(data[0]! > 200 && data[2]! < 50, "first (red) frame kept");
      }
    });
  }

  it("magic-byte spoof (text named .png) → 400", async () => {
    const r = await upload(app, wallet(), Buffer.from("hello, definitely an image\n".repeat(20)), { filename: "evil.png", contentType: "image/png" });
    assert.equal(r.statusCode, 400);
    assert.deepEqual(r.json(), { error: "Unsupported image type. Use PNG, JPG, WEBP or GIF." });
  });

  it("svg → 400", async () => {
    const svg = Buffer.from(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><script>alert(1)</script><rect width="512" height="512" fill="red"/></svg>`);
    const r = await upload(app, wallet(), svg, { filename: "x.svg", contentType: "image/svg+xml" });
    assert.equal(r.statusCode, 400);
    assert.deepEqual(r.json(), { error: "Unsupported image type. Use PNG, JPG, WEBP or GIF." });
  });

  it("valid magic but corrupt body → 400", async () => {
    const bad = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2000)]);
    const r = await upload(app, wallet(), bad);
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "Could not decode image");
  });

  it("> 5 MB → 413", async () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(5 * 1024 * 1024 + 10)]);
    const r = await upload(app, wallet(), big);
    assert.equal(r.statusCode, 413);
    assert.deepEqual(r.json(), { error: "Image too large (max 5 MB)" });
  });

  it("smaller than 64×64 → 400", async () => {
    const r = await upload(app, wallet(), await png(63, 200));
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /too small/);
  });

  it("unauthenticated → 401; wrong field / not multipart → 400", async () => {
    assert.equal((await upload(app, null, await png())).statusCode, 401);
    assert.equal((await upload(app, wallet(), await png(), { field: "image" })).statusCode, 400);
    const j = await app.inject({ method: "POST", url: "/api/uploads/token-image", headers: bearer(wallet()), payload: { file: "x" } });
    assert.equal(j.statusCode, 400);
  });

  it("dedupes identical uploads per owner, not across owners", async () => {
    const w = wallet();
    const src = await png(400, 400);
    const a = (await upload(app, w, src)).json();
    const b = (await upload(app, w, src)).json();
    assert.equal(a.id, b.id);
    const c = (await upload(app, wallet(), src)).json();
    assert.notEqual(c.id, a.id);
  });

  it("GET: caching headers, ETag + If-None-Match → 304, 404s", async () => {
    const r = (await upload(app, wallet(), await png(128, 128))).json();
    const g = await app.inject({ method: "GET", url: `/api/images/${r.id}` });
    assert.equal(g.statusCode, 200);
    assert.equal(g.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(g.headers["cross-origin-resource-policy"], "cross-origin");
    assert.equal(g.headers["x-content-type-options"], "nosniff");
    assert.equal(g.headers.etag, `"${createHash("sha256").update(g.rawPayload).digest("hex")}"`);
    const nm = await app.inject({ method: "GET", url: `/api/images/${r.id}.webp`, headers: { "if-none-match": String(g.headers.etag) } });
    assert.equal(nm.statusCode, 304);
    assert.equal(nm.rawPayload.length, 0);
    const miss = await app.inject({ method: "GET", url: `/api/images/${"0".repeat(32)}.webp` });
    assert.equal(miss.statusCode, 404);
    assert.deepEqual(miss.json(), { error: "Not found" });
    assert.equal((await app.inject({ method: "GET", url: "/api/images/../../etc/passwd" })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/images/nothex.webp" })).statusCode, 404);
  });

  it("CORS preflight allows multipart POST with Authorization", async () => {
    const r = await app.inject({
      method: "OPTIONS",
      url: "/api/uploads/token-image",
      headers: { origin: "https://www.sealedsol.xyz", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    });
    assert.equal(r.statusCode, 204);
    assert.ok(["*", "https://www.sealedsol.xyz"].includes(String(r.headers["access-control-allow-origin"])));
    assert.match(String(r.headers["access-control-allow-methods"]), /POST/);
    assert.match(String(r.headers["access-control-allow-headers"]).toLowerCase(), /authorization/);
  });

  it("devnet launch: http imageUri rejected, https and own uploads accepted", async () => {
    const w = wallet();
    const bad = await app.inject({ method: "POST", url: "/api/launches", headers: bearer(w), payload: { ...validLaunch, imageUri: "http://example.com/a.png" } });
    assert.equal(bad.statusCode, 400);
    const ext = await app.inject({ method: "POST", url: "/api/launches", headers: bearer(w), payload: { ...validLaunch, imageUri: "https://example.com/a.png" } });
    assert.equal(ext.statusCode, 200, ext.body);
    const up = (await upload(app, w, await png())).json();
    const own = await app.inject({ method: "POST", url: "/api/launches", headers: bearer(w), payload: { ...validLaunch, imageUri: up.url } });
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(own.json().imageUri, up.url);
  });

  it("url derived from x-forwarded-proto/host without PUBLIC_API_URL", async () => {
    const mp = multipart(await png());
    const r = await app.inject({
      method: "POST", url: "/api/uploads/token-image", payload: mp.payload,
      headers: { ...mp.headers, ...bearer(wallet()), "x-forwarded-proto": "https", "x-forwarded-host": "api.example.test" },
    });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().url, `https://api.example.test/api/images/${r.json().id}.webp`);
  });

  it("sniffImageType", () => {
    assert.equal(sniffImageType(Buffer.from("GIF89a....")), "gif");
    assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
    assert.equal(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "webp");
    assert.equal(sniffImageType(Buffer.from("<svg")), null);
  });
});

describe("token image uploads: rate limit", () => {
  it("per-wallet hourly limit → 429", async () => {
    const app = await makeApp({ DEMO_MODE: "true", UPLOAD_RATE_LIMIT_PER_HOUR: "3" });
    installDevAuth(app);
    try {
      const w = wallet();
      const src = await png(100, 100);
      for (let i = 0; i < 3; i++) assert.equal((await upload(app, w, src)).statusCode, 201);
      const r = await upload(app, w, src);
      assert.equal(r.statusCode, 429);
      assert.equal((await upload(app, wallet(), src)).statusCode, 201, "other wallets unaffected");
    } finally {
      await app.close();
    }
  });
});

describe("memory image store LRU", () => {
  it("evicts oldest beyond the byte cap", async () => {
    const s = new MemoryImageStore(25);
    const rec = (id: string) => ({ id, owner: "o", mime: "image/webp", bytes: Buffer.alloc(10), width: 512, height: 512, sha256: id, createdAt: new Date() });
    await s.put(rec("a"));
    await s.put(rec("b"));
    await s.get("a"); // touch → b is oldest
    await s.put(rec("c"));
    assert.ok(await s.get("a"));
    assert.equal(await s.get("b"), null);
    assert.ok(await s.get("c"));
  });
});

describe("mainnet launch imageUri", () => {
  let app: App;
  before(async () => {
    const config = loadConfig({ NODE_ENV: "test", NETWORK: "mainnet", PUBLIC_API_URL: "https://api.sealed.test/" });
    app = await buildServer({
      config, logger: false, workers: false, offchainRepo: new MemoryRepo(),
      custody: { env: {}, rpc: null, config: { workers: false } }, rpcProxy: { upstreamUrl: null },
    });
    await app.ready();
    installDevAuth(app);
  });
  after(async () => {
    await app.close();
  });
  const launch = (w: string, imageUri: string) =>
    app.inject({ method: "POST", url: "/api/launches", headers: bearer(w), payload: { ...validLaunch, commitDurationSec: 900, imageUri } });

  it("upload URL uses PUBLIC_API_URL", async () => {
    const r = (await upload(app, wallet(), await png())).json();
    assert.equal(r.url, `https://api.sealed.test/api/images/${r.id}.webp`);
  });

  it("foreign imageUri → 400; empty ok; own upload ok; other wallet's upload → 400", async () => {
    const w = wallet();
    const foreign = await launch(w, "https://example.com/token.png");
    assert.equal(foreign.statusCode, 400);
    assert.deepEqual(foreign.json(), { error: "Upload the token image with Sealed's uploader" });
    const lookalike = await launch(w, `https://evil.test/api/images/${"a".repeat(32)}.webp`);
    assert.deepEqual(lookalike.json(), { error: "Upload the token image with Sealed's uploader" });
    assert.equal((await launch(w, "")).statusCode, 200);

    const mine = (await upload(app, w, await png())).json();
    const ok = await launch(w, mine.url);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().imageUri, mine.url);

    const theirs = (await upload(app, wallet(), await jpg())).json();
    const stolen = await launch(w, theirs.url);
    assert.equal(stolen.statusCode, 400);
    assert.match(stolen.json().error, /different wallet/);

    const missing = await launch(w, `https://api.sealed.test/api/images/${"b".repeat(32)}.webp`);
    assert.equal(missing.statusCode, 400);
    const query = await launch(w, `${mine.url}?x=1`);
    assert.equal(query.statusCode, 400);
  });
});
