import { loadConfig } from "../src/config.js";
import { buildServer, type App } from "../src/server.js";

export async function makeApp(env: Record<string, string> = {}, workers = false): Promise<App> {
  const config = loadConfig({ NODE_ENV: "test", ...env });
  const app = await buildServer({ config, logger: false, workers });
  await app.ready();
  return app;
}

export const validLaunch = {
  name: "Test Token",
  ticker: "TEST",
  description: "integration test launch",
  quoteAsset: "USDC",
  creditTier: "standard",
  totalSupply: 1_000_000_000,
  creatorAllocationBps: 150,
  auctionSupplyBps: 4000,
  commitDurationSec: 600,
  revealDurationSec: 120,
  floorPrice: 0.0001,
  tickSize: 0.000005,
  targetRaise: 50_000,
  clearingCap: 75_000,
};
