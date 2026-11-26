/**
 * Black-box e2e for the built API (apps/api/dist/server.js) in zero-config demo mode.
 * Starts it on PORT=4200 (override with E2E_API_PORT) with no other env → memory store + demo world.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { QUOTE_ASSETS, type AuctionResponse, type HealthResponse, type LaunchListResponse, type LaunchSummary, type ProtocolStats, type RevenueResponse, type VaultResponse, type WsEnvelope } from "@sealed/shared";
import { ROOT, start, waitFor, portFree, type Proc } from "../lib/proc.ts";

const PORT = Number(process.env.E2E_API_PORT ?? 4200);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(ROOT, "apps/api/dist/server.js");
const built = existsSync(SERVER);
const skip = built ? false : `apps/api/dist/server.js not built yet — run \`pnpm --filter @sealed/api build\` (e2e PENDING, not failed)`;
if (!built) console.log(`# SKIP api e2e: ${skip}`);

let proc: Proc | undefined;

async function get<T>(p: string): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(BASE + p);
  const text = await res.text();
  let body: unknown = text;
  if ((res.headers.get("content-type") ?? "").includes("json")) body = JSON.parse(text);
  return { status: res.status, body: body as T, headers: res.headers };
}
async function post<T>(p: string, data: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body: body as T };
}

/** Recursively collect object keys. */
function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), allKeys(x, out));
  return out;
}
const PER_BID_KEYS = ["bids", "bid", "maxPrice", "max_price", "bidAmount", "bid_amount", "salt", "commitments", "deposits", "bidder", "bidders", "reveals", "preimage", "ciphertext"];

const newLaunch = (over: Record<string, unknown> = {}) => ({
  name: "E2E Sealed",
  ticker: `E2E${Math.floor(Math.random() * 9000 + 1000)}`,
  description: "created by tests/e2e",
  quoteAsset: "SOL",
  creditTier: "plus",
  creatorAllocationBps: 150,
  commitDurationSec: 600,
  floorPrice: 0.0001,
  tickSize: 0.000005,
  targetRaise: 500,
  clearingCap: 750,
  ...over,
});

describe("API e2e (demo mode, zero env)", { skip }, () => {
  before(async () => {
    assert.ok(await portFree(PORT), `port ${PORT} is busy — stop whatever is listening or set E2E_API_PORT`);
    proc = start(process.execPath, [SERVER], { cwd: path.join(ROOT, "apps/api"), env: { PORT: String(PORT) } });
    await waitFor(`${BASE}/api/health`, proc, 30_000);
  });
  after(async () => {
    await proc?.stop();
  });

  test("GET /api/health → ok, demo, memory store", async () => {
    const { status, body } = await get<HealthResponse>("/api/health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.isDemo, true);
    assert.equal(body.db, "memory");
    assert.equal(body.cache, "memory");
    assert.equal(typeof body.programId, "string");
  });

  test("GET /api/stats → ProtocolStats with counts", async () => {
    const { status, body } = await get<ProtocolStats>("/api/stats");
    assert.equal(status, 200);
    for (const k of ["totalVolumeUsd", "totalFeesUsd", "activeBuybackCreditUsd", "totalCreditDeployedUsd", "totalCreditRepaidUsd", "solvencyRatio", "liveAuctions", "activeVaults", "graduatedFlywheels"] as const) {
      assert.equal(typeof body[k], "number", `stats.${k}`);
      assert.ok(Number.isFinite(body[k]));
    }
    assert.ok(body.liveAuctions > 0 && body.activeVaults > 0 && body.graduatedFlywheels > 0);
    assert.equal(body.isDemo, true);
  });

  test("GET /api/launches + tab & quote filters", async () => {
    const all = await get<LaunchListResponse>("/api/launches?limit=200");
    assert.equal(all.status, 200);
    assert.ok(Array.isArray(all.body.launches) && all.body.launches.length >= 12, `expected ≥12 demo launches, got ${all.body.launches?.length}`);
    assert.equal(typeof all.body.total, "number");

    const cases: [string, (l: LaunchSummary) => boolean][] = [
      ["status=auctions", (l) => ["commit", "reveal", "clearing"].includes(l.status)],
      ["status=vaults", (l) => l.status === "live"],
      ["status=graduated", (l) => l.status === "flywheel"],
      ["status=commit", (l) => l.status === "commit"],
      ["quote=SOL", (l) => l.quoteAsset === "SOL"],
      ["quote=USDC", (l) => l.quoteAsset === "USDC"],
      ["quote=stocks", (l) => QUOTE_ASSETS[l.quoteAsset].kind === "stock"],
      ["status=vaults&quote=stocks", (l) => l.status === "live" && QUOTE_ASSETS[l.quoteAsset].kind === "stock"],
    ];
    for (const [q, pred] of cases) {
      const r = await get<LaunchListResponse>(`/api/launches?${q}&limit=200`);
      assert.equal(r.status, 200, q);
      assert.ok(r.body.launches.length > 0, `${q} returned nothing`);
      for (const l of r.body.launches) assert.ok(pred(l), `${q} leaked ${l.ticker} (${l.status}/${l.quoteAsset})`);
    }
    const all2 = await get<LaunchListResponse>("/api/launches?quote=all&limit=200");
    assert.ok(all2.body.launches.length >= all.body.launches.length - 1);
    const lim = await get<LaunchListResponse>("/api/launches?limit=3");
    assert.ok(lim.body.launches.length <= 3);
    const bad = await get("/api/launches?status=nope");
    assert.equal(bad.status, 400, "invalid status filter should 400");
  });

  test("GET /api/launches/:idOrMint by id and mint; unknown → 404", async () => {
    const { body } = await get<LaunchListResponse>("/api/launches?limit=1");
    const L = body.launches[0]!;
    assert.equal((await get<LaunchSummary>(`/api/launches/${L.id}`)).body.id, L.id);
    assert.equal((await get<LaunchSummary>(`/api/launches/${L.mint}`)).body.id, L.id);
    assert.equal((await get(`/api/launches/11111111111111111111111111111111`)).status, 404);
  });

  test("GET /api/auctions/:id never exposes per-bid data", async () => {
    const { body } = await get<LaunchListResponse>("/api/launches?status=auctions&limit=200");
    for (const L of body.launches) {
      const r = await get<AuctionResponse>(`/api/auctions/${L.id}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.launch.id, L.id);
      assert.equal(typeof r.body.serverTimeTs, "number");
      assert.equal(typeof r.body.launch.auction.bidCount, "number");
      assert.equal(typeof r.body.launch.auction.totalEscrowed, "number");
      const keys = allKeys(r.body);
      for (const k of PER_BID_KEYS) assert.ok(!keys.has(k), `auction ${L.ticker} response leaks per-bid field "${k}"`);
      if (L.status === "commit" || L.status === "reveal") assert.equal(r.body.launch.auction.clearingPrice, null, "no clearing price before clear");
    }
  });

  test("GET /api/vaults/:mint → vault, credit, recent buybacks", async () => {
    const { body } = await get<LaunchListResponse>("/api/launches?status=vaults&limit=200");
    const L = body.launches[0]!;
    const r = await get<VaultResponse>(`/api/vaults/${L.mint}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.launch.mint, L.mint);
    assert.ok(r.body.launch.vault && r.body.launch.credit);
    assert.ok(r.body.launch.vault.balance >= 0);
    assert.ok(r.body.launch.credit.repaidPct >= 0 && r.body.launch.credit.repaidPct <= 100);
    assert.ok(Array.isArray(r.body.recentBuybacks));
    for (const b of r.body.recentBuybacks) assert.equal(b.launchId, L.id);
    assert.equal((await get(`/api/vaults/11111111111111111111111111111111`)).status, 404);
  });

  test("GET /api/revenue → stats, buybacks, ledger, daily series", async () => {
    const r = await get<RevenueResponse>("/api/revenue");
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.stats.totalFeesUsd, "number");
    assert.ok(r.body.recentBuybacks.length > 0);
    assert.ok(r.body.ledger.length > 0);
    assert.ok(Array.isArray(r.body.daily) && r.body.daily.length > 0);
    for (const d of r.body.daily) assert.match(d.date, /^\d{4}-\d{2}-\d{2}/);
  });

  test("GET /llms.txt → text/plain agent guide listing the endpoints", async () => {
    const r = await get<string>("/llms.txt");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/plain/);
    for (const s of ["/api/launches", "/api/auctions", "/api/vaults", "/api/stats", "/ws"]) assert.ok(r.body.includes(s), `llms.txt missing ${s}`);
  });

  test("POST /api/launches: valid → 200 and listed; 250 bps creator cap → 400", async () => {
    const input = newLaunch();
    const ok = await post<LaunchSummary>("/api/launches", input);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.ticker, input.ticker);
    assert.equal(ok.body.status, "commit");
    assert.equal(ok.body.creatorAllocationBps, 150);
    const list = await get<LaunchListResponse>("/api/launches?limit=200");
    assert.ok(list.body.launches.some((l) => l.id === ok.body.id), "created launch not in list");
    const auctions = await get<LaunchListResponse>("/api/launches?status=auctions&limit=200");
    assert.ok(auctions.body.launches.some((l) => l.id === ok.body.id), "created launch not in auctions tab");

    const bad = await post<{ error: string }>("/api/launches", newLaunch({ creatorAllocationBps: 250 }));
    assert.equal(bad.status, 400);
    assert.equal(typeof bad.body.error, "string");
    const bad2 = await post("/api/launches", { name: "x" });
    assert.equal(bad2.status, 400);
  });

  test("POST /api/auctions/:id/demo-bid increments bidCount and still hides bid", async () => {
    const created = await post<LaunchSummary>("/api/launches", newLaunch());
    assert.equal(created.status, 200);
    const id = created.body.id;
    const before = (await get<AuctionResponse>(`/api/auctions/${id}`)).body.launch.auction;
    const r = await post<AuctionResponse>(`/api/auctions/${id}/demo-bid`, { commitment: "ab".repeat(32), deposit: 12.5 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.launch.auction.bidCount >= before.bidCount + 1, `bidCount ${before.bidCount} → ${r.body.launch.auction.bidCount}`);
    assert.ok(r.body.launch.auction.totalEscrowed >= before.totalEscrowed + 12.5 - 1e-9, "deposit added to totalEscrowed");
    const keys = allKeys(r.body);
    for (const k of PER_BID_KEYS) assert.ok(!keys.has(k), `demo-bid response leaks "${k}"`);
    const badBid = await post(`/api/auctions/${id}/demo-bid`, { commitment: "zz", deposit: 1 });
    assert.equal(badBid.status, 400);
  });

  test("WS /ws: subscribe to global receives an event", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let trigger: NodeJS.Timeout | undefined;
    let triggered: Promise<unknown> = Promise.resolve();
    const got = await new Promise<WsEnvelope>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no WS event on global within 20s")), 20_000);
      ws.on("error", (e) => (clearTimeout(t), reject(e)));
      ws.on("open", () => {
        ws.send(JSON.stringify({ op: "subscribe", channels: ["global"] }));
        // Also trigger a deterministic global event (launch.created) in case the demo ticker is quiet.
        trigger = setTimeout(() => { triggered = post("/api/launches", newLaunch()).catch(() => undefined); }, 300);
      });
      ws.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg && typeof msg.type === "string" && msg.type !== "pong" && msg.channel) {
          clearTimeout(t);
          resolve(msg as WsEnvelope);
        }
      });
    });
    assert.equal(got.channel, "global");
    assert.equal(typeof got.ts, "number");
    // ping/pong
    const pong = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 5000);
      ws.on("message", (raw) => {
        try {
          if (JSON.parse(raw.toString()).type === "pong") (clearTimeout(t), resolve(true));
        } catch {}
      });
      ws.send(JSON.stringify({ op: "ping" }));
    });
    assert.ok(pong, "ping → pong");
    clearTimeout(trigger);
    await triggered;
    ws.close();
  });
});
