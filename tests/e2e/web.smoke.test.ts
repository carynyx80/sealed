/**
 * Smoke test for the production Next.js build (apps/web/.next).
 * Boots the API (port 4200) as the data source, then `next start -p 3200` with NEXT_PUBLIC_API_URL pointing at it.
 * Ports can be overridden with E2E_API_PORT / E2E_WEB_PORT.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import type { LaunchListResponse } from "@sealed/shared";
import { ROOT, start, waitFor, portFree, type Proc } from "../lib/proc.ts";

const API_PORT = Number(process.env.E2E_API_PORT ?? 4200);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3200);
const API = `http://127.0.0.1:${API_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const WEB_DIR = path.join(ROOT, "apps/web");
const SERVER = path.join(ROOT, "apps/api/dist/server.js");
const NEXT_BIN = path.join(WEB_DIR, "node_modules/next/dist/bin/next");

const reasons: string[] = [];
if (!existsSync(path.join(WEB_DIR, ".next/BUILD_ID"))) reasons.push("apps/web/.next not built — run `pnpm --filter @sealed/web build`");
if (!existsSync(SERVER)) reasons.push("apps/api/dist/server.js not built");
if (!existsSync(NEXT_BIN)) reasons.push("next binary not installed in apps/web");
const skip = reasons.length ? `${reasons.join("; ")} (web smoke PENDING, not failed)` : false;
if (skip) console.log(`# SKIP web smoke: ${skip}`);

let api: Proc | undefined;
let web: Proc | undefined;
let sampleMint = "";
let sampleTicker = "";

async function page(p: string): Promise<{ status: number; html: string }> {
  const res = await fetch(WEB + p, { signal: AbortSignal.timeout(30_000) });
  return { status: res.status, html: await res.text() };
}
/** Strip tags so copy split across spans still matches; case-insensitive. */
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").toLowerCase();
function expectCopy(html: string, any: string[], where: string) {
  const t = text(html) + " " + html.toLowerCase();
  assert.ok(any.some((s) => t.includes(s.toLowerCase())), `${where}: none of [${any.join(" | ")}] found`);
}

describe("web smoke (next start)", { skip }, () => {
  before(async () => {
    if (await portFree(API_PORT)) {
      api = start(process.execPath, [SERVER], { cwd: path.join(ROOT, "apps/api"), env: { PORT: String(API_PORT) } });
    }
    await waitFor(`${API}/api/health`, api ?? ({ child: { exitCode: null }, logs: () => "" } as unknown as Proc), 30_000);
    const list = (await (await fetch(`${API}/api/launches?status=vaults&limit=1`)).json()) as LaunchListResponse;
    sampleMint = list.launches[0]!.mint;
    sampleTicker = list.launches[0]!.ticker;

    assert.ok(await portFree(WEB_PORT), `port ${WEB_PORT} busy — set E2E_WEB_PORT`);
    web = start(process.execPath, [NEXT_BIN, "start", "-p", String(WEB_PORT)], {
      cwd: WEB_DIR,
      env: {
        NODE_ENV: "production",
        NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`,
        NEXT_PUBLIC_WS_URL: `ws://localhost:${API_PORT}/ws`,
        NEXT_PUBLIC_NETWORK: "devnet",
        API_URL: `http://localhost:${API_PORT}`,
      },
    });
    await waitFor(`${WEB}/`, web, 60_000);
  });
  after(async () => {
    await web?.stop();
    await api?.stop();
  });

  test("/ renders the lobby with the 3-step loop and tabs", async () => {
    const { status, html } = await page("/");
    assert.equal(status, 200);
    expectCopy(html, ["sealed bid", "sealed-bid", "sealed auction"], "/");
    expectCopy(html, ["buyback"], "/");
    expectCopy(html, ["flywheel"], "/");
    expectCopy(html, ["devnet", "demo"], "/ network label");
  });

  test("/launch renders the Launch Studio wizard with the 2% cap", async () => {
    const { status, html } = await page("/launch");
    assert.equal(status, 200);
    expectCopy(html, ["launch studio", "launch a token", "create launch", "launch"], "/launch");
    expectCopy(html, ["2%", "2 %", "200 bps"], "/launch creator cap");
  });

  test("/revenue renders the dashboard", async () => {
    const { status, html } = await page("/revenue");
    assert.equal(status, 200);
    expectCopy(html, ["revenue"], "/revenue");
    expectCopy(html, ["burn"], "/revenue");
    expectCopy(html, ["credit"], "/revenue");
  });

  test("/token/<mint from API> renders the token room", async () => {
    const { status, html } = await page(`/token/${sampleMint}`);
    assert.equal(status, 200);
    expectCopy(html, [sampleTicker, "buyback", "credit"], "/token");
  });

  test("unknown route → 404", async () => {
    const { status } = await page("/definitely-not-a-page");
    assert.equal(status, 404);
  });
});
