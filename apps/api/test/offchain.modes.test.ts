import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LaunchListResponse, ProtocolStats } from "@sealed/shared";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { EventBus } from "../src/events.js";
import { MemoryStore } from "../src/store/index.js";
import { makeApp, validLaunch } from "./helpers.js";
import { bearer, installDevAuth } from "./offchain.helpers.js";

/** An empty non-demo primary store that reports itself as Postgres (stands in for an empty Prisma DB). */
function emptyPgLikeStore() {
  const s = new MemoryStore({ isDemo: false, network: "devnet", bus: new EventBus(), autoTick: false });
  Object.defineProperty(s, "kind", { value: "postgres" });
  return s;
}

describe("execution modes / read model", () => {
  it("DEMO_MODE=true + Postgres store with zero real launches still serves the demo world", async () => {
    const config = loadConfig({ NODE_ENV: "test", DEMO_MODE: "true" });
    const app = await buildServer({ config, logger: false, workers: false, store: emptyPgLikeStore() });
    await app.ready();
    try {
      const health = (await app.inject({ method: "GET", url: "/api/health" })).json();
      assert.equal(health.db, "postgres");
      const res = await app.inject({ method: "GET", url: "/api/launches?status=auctions" });
      assert.equal(res.statusCode, 200);
      const body = res.json<LaunchListResponse>();
      assert.ok(body.launches.length > 0, "auctions non-empty");
      assert.ok(body.launches.every((l) => l.isDemo));
      const stats = (await app.inject({ method: "GET", url: "/api/stats" })).json<ProtocolStats>();
      assert.ok(stats.liveAuctions > 0 && stats.totalVolumeUsd > 0);
      const live = (await app.inject({ method: "GET", url: "/api/launches?status=vaults" })).json<LaunchListResponse>().launches[0]!;
      const trades = (await app.inject({ method: "GET", url: `/api/launches/${live.id}/trades` })).json();
      assert.ok(trades.trades.length > 0);
      const rev = (await app.inject({ method: "GET", url: "/api/revenue" })).json();
      assert.ok(rev.ledger.length > 0 && rev.recentBuybacks.length > 0);
      // real offchain launch is merged next to the demo world, flagged isDemo=false
      installDevAuth(app);
      const creator = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
      const created = await app.inject({ method: "POST", url: "/api/launches", payload: { ...validLaunch, commitDurationSec: 120 }, headers: bearer(creator) });
      assert.equal(created.statusCode, 200, created.body);
      const all = (await app.inject({ method: "GET", url: "/api/launches?status=auctions&limit=200" })).json<LaunchListResponse>();
      assert.ok(all.launches.some((l) => !l.isDemo && l.creator === creator));
      assert.ok(all.launches.some((l) => l.isDemo));
    } finally {
      await app.close();
    }
  });

  it("NETWORK=mainnet + EXECUTION_MODE=offchain refuses to start without DATABASE_URL", async () => {
    const config = loadConfig({ NODE_ENV: "test", NETWORK: "mainnet", DEMO_MODE: "false" });
    await assert.rejects(buildServer({ config, logger: false, workers: false }), /DATABASE_URL/);
  });

  it("EXECUTION_MODE=onchain keeps the legacy behaviour; trade routes answer 503", async () => {
    const app = await makeApp({ EXECUTION_MODE: "onchain" });
    try {
      assert.equal(app.ctx.offchain, null);
      const r = await app.inject({ method: "POST", url: "/api/trade/swap", payload: {} });
      assert.equal(r.statusCode, 503);
    } finally {
      await app.close();
    }
  });

  it("non-demo offchain: POST /api/launches requires a session", async () => {
    const app = await makeApp({ DEMO_MODE: "false" });
    try {
      installDevAuth(app);
      const r = await app.inject({ method: "POST", url: "/api/launches", payload: validLaunch });
      assert.equal(r.statusCode, 401);
      const ok = await app.inject({ method: "POST", url: "/api/launches", payload: validLaunch, headers: bearer("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin") });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(ok.json().isDemo, false);
      const list = (await app.inject({ method: "GET", url: "/api/launches" })).json<LaunchListResponse>();
      assert.equal(list.launches.length, 1);
    } finally {
      await app.close();
    }
  });
});
