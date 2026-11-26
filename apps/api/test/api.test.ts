import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import {
  STOCK_QUOTE_ASSETS,
  computeCommitment,
  randomSalt,
  revealSignMessage,
  sealReveal,
  toHex,
  type AuctionResponse,
  type HealthResponse,
  type LaunchListResponse,
  type LaunchSummary,
  type ProtocolStats,
  type RelayerPubkeyResponse,
  type RevenueResponse,
  type VaultResponse,
} from "@sealed/shared";
import type { App } from "../src/server.js";
import { makeApp, validLaunch } from "./helpers.js";

let app: App;
before(async () => {
  app = await makeApp();
});
after(async () => {
  await app.close();
});

async function list(query = ""): Promise<LaunchListResponse> {
  const res = await app.inject({ method: "GET", url: `/api/launches${query}` });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

describe("health + stats", () => {
  it("GET /api/health", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(res.statusCode, 200);
    const body = res.json<HealthResponse>();
    assert.equal(body.ok, true);
    assert.equal(body.isDemo, true);
    assert.equal(body.db, "memory");
    assert.equal(body.cache, "memory");
    assert.equal(body.rpc, null);
    assert.equal(typeof body.programId, "string");
    assert.equal(typeof body.uptimeSec, "number");
  });

  it("GET /api/stats", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stats" });
    assert.equal(res.statusCode, 200);
    const s = res.json<ProtocolStats>();
    assert.equal(s.isDemo, true);
    assert.ok(s.liveAuctions > 0);
    assert.ok(s.activeVaults > 0);
    assert.ok(s.graduatedFlywheels > 0);
    assert.ok(s.totalVolumeUsd > 0);
    assert.ok(s.solvencyRatio >= 1);
  });
});

describe("launches", () => {
  it("lists all launches", async () => {
    const body = await list();
    assert.ok(body.launches.length >= 12);
    assert.equal(body.total, body.launches.length);
  });

  it("filters status=auctions", async () => {
    const body = await list("?status=auctions");
    assert.ok(body.launches.length > 0);
    for (const l of body.launches) assert.ok(["commit", "reveal", "clearing"].includes(l.status));
  });

  it("filters status=vaults", async () => {
    const body = await list("?status=vaults");
    assert.ok(body.launches.length > 0);
    for (const l of body.launches) {
      assert.equal(l.status, "live");
      assert.ok(l.vault && l.credit && l.market);
    }
  });

  it("filters status=graduated", async () => {
    const body = await list("?status=graduated");
    assert.ok(body.launches.length > 0);
    for (const l of body.launches) assert.equal(l.status, "flywheel");
  });

  it("filters quote=stocks", async () => {
    const stocks = new Set(STOCK_QUOTE_ASSETS.map((s) => s.symbol as string));
    const body = await list("?quote=stocks");
    assert.ok(body.launches.length > 0);
    for (const l of body.launches) assert.ok(stocks.has(l.quoteAsset), l.quoteAsset);
  });

  it("respects limit and rejects bad query", async () => {
    const body = await list("?limit=3");
    assert.equal(body.launches.length, 3);
    assert.ok(body.total > 3);
    const bad = await app.inject({ method: "GET", url: "/api/launches?status=nope" });
    assert.equal(bad.statusCode, 400);
    assert.ok(bad.json().error);
  });

  it("GET /api/launches/:id by id and mint, 404 otherwise", async () => {
    const [first] = (await list()).launches;
    const byId = await app.inject({ method: "GET", url: `/api/launches/${first!.id}` });
    assert.equal(byId.statusCode, 200);
    assert.equal(byId.json<LaunchSummary>().id, first!.id);
    const byMint = await app.inject({ method: "GET", url: `/api/launches/${first!.mint}` });
    assert.equal(byMint.json<LaunchSummary>().id, first!.id);
    const missing = await app.inject({ method: "GET", url: "/api/launches/doesnotexist" });
    assert.equal(missing.statusCode, 404);
    assert.ok(missing.json().error);
  });

  it("trades + chart for a live launch", async () => {
    const [live] = (await list("?status=vaults")).launches;
    const t = await app.inject({ method: "GET", url: `/api/launches/${live!.id}/trades?limit=5` });
    assert.equal(t.statusCode, 200);
    assert.ok(t.json().trades.length > 0 && t.json().trades.length <= 5);
    const c = await app.inject({ method: "GET", url: `/api/launches/${live!.id}/chart?interval=1h` });
    assert.equal(c.statusCode, 200);
    assert.ok(c.json().points.length > 0);
  });

  it("POST /api/launches creates a commit-phase demo launch", async () => {
    const res = await app.inject({ method: "POST", url: "/api/launches", payload: validLaunch });
    assert.equal(res.statusCode, 200, res.body);
    const l = res.json<LaunchSummary>();
    assert.equal(l.status, "commit");
    assert.equal(l.ticker, "TEST");
    assert.equal(l.isDemo, true);
    assert.equal(l.auction.bidCount, 0);
    assert.equal(l.auction.tokensForSale, 400_000_000);
    const fetched = await app.inject({ method: "GET", url: `/api/launches/${l.mint}` });
    assert.equal(fetched.statusCode, 200);
    const listed = await list("?status=auctions&limit=200");
    assert.ok(listed.launches.some((x) => x.id === l.id));
  });

  it("POST /api/launches rejects creatorAllocationBps 250 (> 2% cap)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/launches", payload: { ...validLaunch, creatorAllocationBps: 250 } });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.error);
    assert.ok(JSON.stringify(body.details).includes("creatorAllocationBps"));
  });
});

describe("auctions privacy", () => {
  it("GET /api/auctions/:id never leaks individual bids", async () => {
    const [auction] = (await list("?status=commit")).launches;
    const commitment = toHex(nacl.randomBytes(32));
    const deposit = 123.456789;
    const wallet = Keypair.generate().publicKey.toBase58();
    const bid = await app.inject({ method: "POST", url: `/api/auctions/${auction!.id}/demo-bid`, payload: { commitment, deposit, wallet } });
    assert.equal(bid.statusCode, 200, bid.body);
    const after = bid.json<AuctionResponse>();
    assert.ok(after.launch.auction.bidCount > auction!.auction.bidCount);

    const res = await app.inject({ method: "GET", url: `/api/auctions/${auction!.id}` });
    assert.equal(res.statusCode, 200);
    const raw = res.body;
    const body = res.json<AuctionResponse>();
    assert.equal(typeof body.serverTimeTs, "number");
    assert.equal(body.launch.auction.clearingPrice, null);
    assert.equal(body.launch.auction.totalRaised, null);
    for (const s of [commitment, wallet, String(deposit)]) assert.ok(!raw.includes(s), `leaked ${s}`);
    for (const k of ["bids", "maxPrice", "bidAmount", "commitment", "deposit", "salt"]) assert.ok(!raw.includes(`"${k}"`), `leaked key ${k}`);
    for (const k of ["maxPrice", "bidAmount", "commitment", "deposit"]) assert.ok(!bid.body.includes(`"${k}"`));
    assert.ok(!bid.body.includes(commitment));
  });

  it("demo-bid validates input", async () => {
    const [auction] = (await list("?status=commit")).launches;
    const res = await app.inject({ method: "POST", url: `/api/auctions/${auction!.id}/demo-bid`, payload: { commitment: "zz", deposit: -1 } });
    assert.equal(res.statusCode, 400);
  });
});

describe("vaults, rewards, revenue", () => {
  it("GET /api/vaults/:mint", async () => {
    const [live] = (await list("?status=vaults")).launches;
    const res = await app.inject({ method: "GET", url: `/api/vaults/${live!.mint}` });
    assert.equal(res.statusCode, 200);
    const v = res.json<VaultResponse>();
    assert.equal(v.launch.id, live!.id);
    assert.ok(v.launch.vault);
    assert.ok(Array.isArray(v.recentBuybacks));
    for (const b of v.recentBuybacks) assert.equal(b.launchId, live!.id);
    const missing = await app.inject({ method: "GET", url: `/api/vaults/nope` });
    assert.equal(missing.statusCode, 404);
  });

  it("GET /api/rewards/:mint/:wallet", async () => {
    const [fly] = (await list("?status=graduated")).launches;
    const wallet = Keypair.generate().publicKey.toBase58();
    const res = await app.inject({ method: "GET", url: `/api/rewards/${fly!.mint}/${wallet}` });
    assert.equal(res.statusCode, 200);
    const r = res.json();
    assert.equal(r.wallet, wallet);
    assert.equal(r.quoteAsset, fly!.quoteAsset);
    assert.equal(typeof r.eligible, "boolean");
    const bad = await app.inject({ method: "GET", url: `/api/rewards/${fly!.mint}/not-a-wallet` });
    assert.equal(bad.statusCode, 400);
  });

  it("GET /api/revenue", async () => {
    const res = await app.inject({ method: "GET", url: "/api/revenue" });
    assert.equal(res.statusCode, 200);
    const r = res.json<RevenueResponse>();
    assert.ok(r.stats.totalFeesUsd > 0);
    assert.ok(r.recentBuybacks.length > 0);
    assert.ok(r.ledger.length > 0);
    assert.equal(r.daily.length, 14);
    assert.match(r.daily[0]!.date, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("llms.txt", () => {
  it("serves a text/plain agent guide", async () => {
    const res = await app.inject({ method: "GET", url: "/llms.txt" });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /^text\/plain/);
    for (const s of ["/api/launches", "/api/auctions/", "/api/vaults/", "/api/stats", "/api/relayer/reveals", "subscribe", "commitment"]) assert.ok(res.body.includes(s), s);
  });
});

describe("relayer", () => {
  async function setup() {
    const pk = (await app.inject({ method: "GET", url: "/api/relayer/pubkey" })).json<RelayerPubkeyResponse>();
    const [auction] = (await list("?status=commit")).launches;
    const bidder = nacl.sign.keyPair();
    const bidderB58 = new Keypair({ publicKey: bidder.publicKey, secretKey: bidder.secretKey }).publicKey.toBase58();
    const plaintext = { maxPrice: "1000", bidAmount: "500000", salt: toHex(randomSalt()) };
    const commitmentHex = toHex(computeCommitment({ bidder: bidderB58, maxPrice: 1000n, bidAmount: 500000n, salt: Uint8Array.from(Buffer.from(plaintext.salt, "hex")) }));
    return { pk, auction: auction!, bidder, bidderB58, plaintext, commitmentHex };
  }

  it("GET /api/relayer/pubkey", async () => {
    const res = await app.inject({ method: "GET", url: "/api/relayer/pubkey" });
    assert.equal(res.statusCode, 200);
    const body = res.json<RelayerPubkeyResponse>();
    assert.equal(Buffer.from(body.pubkey, "base64").length, 32);
    assert.ok(body.relayerAddress.length >= 32);
  });

  it("rejects a bad signature", async () => {
    const { pk, auction, bidderB58, plaintext, commitmentHex } = await setup();
    const wrongSigner = nacl.sign.keyPair();
    const signature = nacl.sign.detached(revealSignMessage(auction.id, commitmentHex), wrongSigner.secretKey);
    const env = sealReveal({ launchId: auction.id, bidder: bidderB58, commitmentHex, relayerPubkeyB64: pk.pubkey, plaintext, signature });
    const res = await app.inject({ method: "POST", url: "/api/relayer/reveals", payload: env });
    assert.equal(res.statusCode, 401, res.body);
    assert.match(res.json().error, /signature/);
  });

  it("rejects a malformed envelope", async () => {
    const res = await app.inject({ method: "POST", url: "/api/relayer/reveals", payload: { version: 1, launchId: "x" } });
    assert.equal(res.statusCode, 400);
  });

  it("rejects a payload that does not match the commitment", async () => {
    const { pk, auction, bidder, bidderB58, plaintext, commitmentHex } = await setup();
    const signature = nacl.sign.detached(revealSignMessage(auction.id, commitmentHex), bidder.secretKey);
    const env = sealReveal({ launchId: auction.id, bidder: bidderB58, commitmentHex, relayerPubkeyB64: pk.pubkey, plaintext: { ...plaintext, bidAmount: "1" }, signature });
    const res = await app.inject({ method: "POST", url: "/api/relayer/reveals", payload: env });
    assert.equal(res.statusCode, 400);
  });

  it("accepts a valid sealed reveal", async () => {
    const { pk, auction, bidder, bidderB58, plaintext, commitmentHex } = await setup();
    const signature = nacl.sign.detached(revealSignMessage(auction.id, commitmentHex), bidder.secretKey);
    const env = sealReveal({ launchId: auction.id, bidder: bidderB58, commitmentHex, relayerPubkeyB64: pk.pubkey, plaintext, signature });
    const res = await app.inject({ method: "POST", url: "/api/relayer/reveals", payload: env });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().accepted, true);
    assert.equal(typeof res.json().id, "string");
  });
});

describe("errors", () => {
  it("unknown route → 404 JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    assert.equal(res.statusCode, 404);
    assert.ok(res.json().error);
  });
});
