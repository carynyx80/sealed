import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { WsEnvelope } from "@sealed/shared";
import type { App } from "../src/server.js";
import { makeApp, validLaunch } from "./helpers.js";

let app: App;
let url: string;

before(async () => {
  app = await makeApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  url = `ws://127.0.0.1:${addr.port}/ws`;
});
after(async () => {
  await app.close();
});

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

function waitFor(ws: WebSocket, pred: (m: WsEnvelope & { type: string }) => boolean, timeoutMs = 5000): Promise<WsEnvelope> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for ws message")), timeoutMs);
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (pred(m)) {
        clearTimeout(t);
        resolve(m);
      }
    });
  });
}

describe("websocket /ws", () => {
  it("subscribes to global and receives events", async () => {
    const ws = await connect();
    try {
      const first = waitFor(ws, (m) => m.channel === "global");
      ws.send(JSON.stringify({ op: "subscribe", channels: ["global"] }));
      const msg = await first;
      assert.equal(msg.channel, "global");
      assert.equal(typeof msg.ts, "number");

      // A broadcast (not just the snapshot): creating a launch emits launch.created on global.
      const created = waitFor(ws, (m) => m.type === "launch.created");
      const res = await fetch(url.replace("ws://", "http://").replace("/ws", "/api/launches"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...validLaunch, ticker: "WSTEST" }),
      });
      assert.equal(res.status, 200);
      const evt = await created;
      assert.equal(evt.type, "launch.created");
      if (evt.type === "launch.created") assert.equal(evt.data.ticker, "WSTEST");

      const pong = waitFor(ws, (m) => m.type === "pong");
      ws.send(JSON.stringify({ op: "ping" }));
      await pong;
    } finally {
      ws.close();
    }
  });

  it("delivers launch-channel events (demo bid)", async () => {
    const list = await (await fetch(url.replace("ws://", "http://").replace("/ws", "/api/launches?status=commit"))).json();
    const launch = list.launches[0];
    const ws = await connect();
    try {
      const snap = waitFor(ws, (m) => m.type === "launch.updated" && m.channel === `launch:${launch.id}`);
      ws.send(JSON.stringify({ op: "subscribe", channels: [`launch:${launch.id}`] }));
      await snap;
      const committed = waitFor(ws, (m) => m.type === "auction.bid_committed" && m.channel === `launch:${launch.id}`);
      await fetch(url.replace("ws://", "http://").replace("/ws", `/api/auctions/${launch.id}/demo-bid`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commitment: "ab".repeat(32), deposit: 5 }),
      });
      const evt = await committed;
      if (evt.type === "auction.bid_committed") assert.equal(evt.data.launchId, launch.id);
      assert.ok(!JSON.stringify(evt).includes("ab".repeat(32)), "commitment must not be broadcast");
    } finally {
      ws.close();
    }
  });
});
