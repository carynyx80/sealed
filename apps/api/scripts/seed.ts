/**
 * Demo/devnet seed.
 *
 *   pnpm seed                      # from repo root (→ pnpm --filter @sealed/api seed)
 *   DATABASE_URL=postgres://… pnpm --filter @sealed/api seed [--reset]
 *
 * - With DATABASE_URL: upserts the deterministic `createDemoWorld()` snapshot (launches, trades, buybacks,
 *   credit ledger, protocol stats) into Postgres via Prisma. `--reset` first deletes existing *demo* launches
 *   (isDemo = true; cascades to their trades/buybacks/ledger) — real indexed launches are never touched.
 * - Without DATABASE_URL: nothing to do — the API's memory store builds the same world on boot (DEMO_MODE).
 *
 * Run `prisma migrate deploy` (or `prisma db push`) before seeding a fresh database.
 */
import { createDemoWorld, demoStats, type LaunchSummary } from "@sealed/shared";

const reset = process.argv.includes("--reset");

function launchRow(L: LaunchSummary) {
  const a = L.auction;
  return {
    id: L.id,
    mint: L.mint,
    name: L.name,
    ticker: L.ticker,
    description: L.description,
    imageUri: L.imageUri,
    creator: L.creator,
    creatorAllocationBps: L.creatorAllocationBps,
    totalSupply: L.totalSupply,
    quoteAsset: L.quoteAsset,
    creditTier: L.creditTier,
    status: L.status,
    createdTs: L.createdTs,
    network: L.network,
    isDemo: true,
    commitStartTs: a.commitStartTs,
    commitEndTs: a.commitEndTs,
    revealEndTs: a.revealEndTs,
    bidCount: a.bidCount,
    revealedCount: a.revealedCount,
    escrowedWallets: a.escrowedWallets,
    totalEscrowed: a.totalEscrowed,
    floorPrice: a.floorPrice,
    tickSize: a.tickSize,
    tokensForSale: a.tokensForSale,
    targetRaise: a.targetRaise,
    clearingCap: a.clearingCap,
    clearingPrice: a.clearingPrice,
    totalRaised: a.totalRaised,
    // Prisma Json? columns: undefined leaves NULL on create; objects are stored as JSON.
    market: L.market ? (L.market as object) : undefined,
    vault: L.vault ? (L.vault as object) : undefined,
    credit: L.credit ? (L.credit as object) : undefined,
    nextDripTs: L.vault && L.vault.nextDripTs > 0 ? L.vault.nextDripTs : null,
  };
}

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.log("[seed] DATABASE_URL is not set — nothing to seed.");
    console.log("[seed] Memory mode seeds automatically: `pnpm dev` (or `node apps/api/dist/server.js`) boots with DEMO_MODE and an in-memory demo world.");
    return;
  }

  let PrismaClient: new () => any;
  try {
    ({ PrismaClient } = (await import("@prisma/client")) as any);
  } catch (e) {
    console.error("[seed] @prisma/client is not available. Run `pnpm --filter @sealed/api exec prisma generate` first.", e);
    process.exit(1);
  }
  const prisma = new PrismaClient();
  const now = Math.floor(Date.now() / 1000);
  const world = createDemoWorld(now);
  const stats = demoStats(world, now);

  try {
    if (reset) {
      const { count } = await prisma.launch.deleteMany({ where: { isDemo: true } });
      console.log(`[seed] --reset: removed ${count} demo launches (cascade).`);
    }

    for (const L of world.launches) {
      const row = launchRow(L);
      const { id, ...update } = row;
      await prisma.launch.upsert({ where: { id }, create: row, update });
    }

    const trades = Object.values(world.trades).flat();
    const tradeRes = await prisma.trade.createMany({
      data: trades.map((t) => ({ id: t.id, launchId: t.launchId, side: t.side, wallet: t.wallet, amountQuote: t.amountQuote, amountToken: t.amountToken, price: t.price, signature: t.signature, slot: t.slot, ts: t.ts, isBuyback: t.isBuyback, isSniper: t.isSniper })),
      skipDuplicates: true,
    });
    const bbRes = await prisma.buybackEvent.createMany({
      data: world.buybacks.map((b) => ({ id: b.id, launchId: b.launchId, ticker: b.ticker, quoteAsset: b.quoteAsset, quoteSpent: b.quoteSpent, tokensBurned: b.tokensBurned, price: b.price, signature: b.signature, ts: b.ts, dripIndex: b.dripIndex })),
      skipDuplicates: true,
    });
    const ledgerRes = await prisma.creditLedger.createMany({
      data: world.ledger.map((l) => ({ id: l.id, launchId: l.launchId, ticker: l.ticker, kind: l.kind, amount: l.amount, quoteAsset: l.quoteAsset, signature: l.signature, ts: l.ts })),
      skipDuplicates: true,
    });
    const { network, isDemo, updatedTs, ...numbers } = stats;
    await prisma.protocolStats.upsert({
      where: { id: 1 },
      create: { id: 1, ...numbers, network, isDemo, updatedTs },
      update: { ...numbers, network, isDemo, updatedTs },
    });

    console.log(`[seed] upserted ${world.launches.length} launches, ${tradeRes.count} trades, ${bbRes.count} buybacks, ${ledgerRes.count} ledger entries, protocol stats.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("[seed] failed:", e);
  process.exit(1);
});
