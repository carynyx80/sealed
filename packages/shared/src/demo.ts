import { PublicKey } from "@solana/web3.js";
import { CREDIT_TIERS, DEFAULT_DRIP_INTERVAL_SEC, FLYWHEEL_SPLIT, POOL_FEE_BPS, REPAY_SPLIT } from "./constants.js";
import { QUOTE_ASSETS } from "./quoteAssets.js";
import type { BuybackEvent, CreditLedgerEntry, LaunchSummary, PricePoint, ProtocolStats, QuoteAssetSymbol, Trade } from "./types.js";

/**
 * Deterministic demo world used by the API's memory store (DEMO_MODE=true) and as the web's offline fallback.
 * `createDemoWorld(now)` builds a realistic snapshot; `tickDemoWorld(world, now)` advances it in place and
 * returns the events produced (so callers can broadcast them over WS).
 */

export interface DemoWorld {
  launches: LaunchSummary[];
  trades: Record<string, Trade[]>; // launchId → newest first
  charts: Record<string, PricePoint[]>; // launchId → oldest first
  buybacks: BuybackEvent[]; // newest first
  ledger: CreditLedgerEntry[]; // newest first
  rngState: number;
  lastTickTs: number;
}

export type DemoEvent =
  | { kind: "trade"; trade: Trade }
  | { kind: "drip"; event: BuybackEvent; launch: LaunchSummary }
  | { kind: "ledger"; entry: CreditLedgerEntry; launch: LaunchSummary }
  | { kind: "phase"; launch: LaunchSummary; from: LaunchSummary["status"] }
  | { kind: "bid"; launch: LaunchSummary }
  | { kind: "flywheel"; launch: LaunchSummary };

// ---------- deterministic rng ----------
function mulberry(state: number): [number, number] {
  let t = (state + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, state + 0x6d2b79f5];
}
class Rng {
  constructor(public s: number) {}
  next() { const [v, s] = mulberry(this.s); this.s = s; return v; }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
  int(a: number, b: number) { return Math.floor(this.range(a, b + 1)); }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.next() * xs.length)]!; }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Valid 32-byte base58 pubkey derived from the rng (so `new PublicKey(id)` works on demo ids). */
function fakeKey(r: Rng) { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = r.int(0, 255); return new PublicKey(b).toBase58(); }
function fakeSig(r: Rng) { let s = ""; for (let i = 0; i < 88; i++) s += B58[r.int(0, 57)]; return s; }

interface Seed {
  name: string; ticker: string; quote: QuoteAssetSymbol; desc: string; phase: "commit" | "reveal" | "live" | "flywheel";
  /** for commit/reveal: seconds until window ends; for live/flywheel: seconds since graduation */
  t: number; repaidPct?: number; hue: number;
}

const SEEDS: Seed[] = [
  { name: "Silicon Saints", ticker: "SAINT", quote: "NVDAx", desc: "Community token paired with tokenized NVIDIA. Fees pay holders in NVDAx.", phase: "commit", t: 14 * 60 + 12, hue: 152 },
  { name: "Gigafactory", ticker: "GIGA", quote: "TSLAx", desc: "A meme for the builders. Holder payouts in TSLAx.", phase: "commit", t: 6 * 60 + 41, hue: 14 },
  { name: "Open World", ticker: "OPENW", quote: "TTWOx", desc: "Gaming culture coin with Take-Two paired liquidity.", phase: "commit", t: 22 * 60 + 5, hue: 268 },
  { name: "Quiet Money", ticker: "QUIET", quote: "USDC", desc: "Sealed bids only. No snipers, no copy-trading.", phase: "reveal", t: 84, hue: 200 },
  { name: "Solstice", ticker: "SOLST", quote: "SOL", desc: "A seasonal SOL-paired launch with a day-one buyback vault.", phase: "commit", t: 3 * 60 + 18, hue: 36 },
  { name: "Ledger Lane", ticker: "LANE", quote: "SOL", desc: "Programmatic buybacks every three minutes from minute one.", phase: "live", t: 47 * 60, repaidPct: 23.6, hue: 96 },
  { name: "Burnt Toast", ticker: "TOAST", quote: "SOL", desc: "Everything burns, eventually.", phase: "live", t: 19 * 3600, repaidPct: 68.4, hue: 22 },
  { name: "Index Fund Frog", ticker: "FROGX", quote: "SPYx", desc: "The frog that pays you in the S&P 500.", phase: "live", t: 5 * 3600, repaidPct: 41.2, hue: 130 },
  { name: "Fruit Stand", ticker: "FRUIT", quote: "AAPLx", desc: "Apple-paired. Holders get AAPLx drips.", phase: "live", t: 31 * 3600, repaidPct: 88.9, hue: 340 },
  { name: "Cream Soda", ticker: "SODA", quote: "USDC", desc: "Fully repaid. Now a permanent USDC holder flywheel.", phase: "flywheel", t: 4 * 86400, hue: 48 },
  { name: "Volt Club", ticker: "VOLT", quote: "TSLAx", desc: "Credit cleared in 51 hours. TSLAx to holders forever.", phase: "flywheel", t: 6 * 86400, hue: 190 },
  { name: "Green Room", ticker: "GREEN", quote: "NVDAx", desc: "Flywheel live: 50% of fees to holders in NVDAx.", phase: "flywheel", t: 9 * 86400, hue: 160 },
];

export function demoImage(ticker: string, hue: number): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'><rect width='96' height='96' rx='48' fill='hsl(${hue} 45% 88%)'/><text x='48' y='58' font-family='Georgia,serif' font-size='30' text-anchor='middle' fill='hsl(${hue} 40% 28%)'>${ticker.slice(0, 2)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Demo vaults spread the credit across the ~72h repayment window (1440 drips × 180s). */
const DEMO_DRIP_COUNT = Math.round((72 * 3600) / DEFAULT_DRIP_INTERVAL_SEC);

function usd(sym: QuoteAssetSymbol, amt: number) { return amt * QUOTE_ASSETS[sym].demoUsdPrice; }

/** Pick a raise size (in quote units) worth roughly $40k–$400k. */
function raiseFor(r: Rng, sym: QuoteAssetSymbol) { return Math.round((r.range(40_000, 400_000) / QUOTE_ASSETS[sym].demoUsdPrice) * 100) / 100; }

export function createDemoWorld(nowSec: number = Math.floor(Date.now() / 1000), seed = 7): DemoWorld {
  const r = new Rng(seed);
  const world: DemoWorld = { launches: [], trades: {}, charts: {}, buybacks: [], ledger: [], rngState: 0, lastTickTs: nowSec };

  for (const s of SEEDS) {
    const id = fakeKey(r);
    const mint = fakeKey(r);
    const totalSupply = 1_000_000_000;
    const tokensForSale = totalSupply * 0.4;
    const raise = raiseFor(r, s.quote);
    const floorPrice = (raise * 0.55) / tokensForSale;
    const tier = r.pick(["standard", "plus", "premier"] as const);
    const creditBps = CREDIT_TIERS[tier];
    const commitDur = 20 * 60;
    let commitEnd: number, revealEnd: number;
    if (s.phase === "commit") { commitEnd = nowSec + s.t; revealEnd = commitEnd + 120; }
    else if (s.phase === "reveal") { commitEnd = nowSec - (120 - s.t); revealEnd = nowSec + s.t; }
    else { revealEnd = nowSec - s.t - 30; commitEnd = revealEnd - 120; }
    const bidCount = s.phase === "commit" ? r.int(18, 140) : r.int(120, 900);
    const escrowedWallets = Math.max(1, Math.round(bidCount * r.range(0.78, 0.95)));
    const graduated = s.phase === "live" || s.phase === "flywheel";
    const clearingPrice = graduated ? floorPrice * r.range(1.2, 1.8) : null;
    const totalRaised = graduated ? Math.min(raise, clearingPrice! * tokensForSale) : null;

    const L: LaunchSummary = {
      id, mint, name: s.name, ticker: s.ticker, description: s.desc, imageUri: demoImage(s.ticker, s.hue),
      creator: fakeKey(r), creatorAllocationBps: r.pick([50, 100, 150, 200]), totalSupply, quoteAsset: s.quote, creditTier: tier,
      status: s.phase, createdTs: commitEnd - commitDur - 60,
      auction: {
        commitStartTs: commitEnd - commitDur, commitEndTs: commitEnd, revealEndTs: revealEnd, bidCount,
        revealedCount: s.phase === "reveal" ? Math.round(bidCount * 0.64) : graduated ? Math.round(bidCount * 0.97) : 0,
        escrowedWallets, totalEscrowed: Math.round(raise * r.range(0.6, 1.6) * 100) / 100,
        floorPrice, tickSize: floorPrice * 0.05, tokensForSale, targetRaise: raise, clearingCap: raise * 1.5,
        clearingPrice, totalRaised,
      },
      market: null, vault: null, credit: null, network: "devnet", isDemo: true,
    };

    if (graduated) {
      const creditLine = (totalRaised! * creditBps) / 10_000;
      const flywheel = s.phase === "flywheel";
      const repaidPct = flywheel ? 100 : s.repaidPct!;
      const repaid = (creditLine * repaidPct) / 100;
      const elapsedDrips = Math.floor(s.t / DEFAULT_DRIP_INTERVAL_SEC);
      const dripsExecuted = Math.min(DEMO_DRIP_COUNT, elapsedDrips);
      const dripAmount = creditLine / DEMO_DRIP_COUNT;
      const spent = dripAmount * dripsExecuted;
      const price = clearingPrice! * r.range(1.1, 3.4);
      const feesCollected = repaid / (REPAY_SPLIT.creditRepayBps / 10_000) + (flywheel ? creditLine * r.range(0.4, 2.2) : 0);
      const flyFees = flywheel ? feesCollected - repaid / 0.8 : 0;
      const volume = feesCollected / (POOL_FEE_BPS / 10_000);
      L.market = {
        price, priceUsd: usd(s.quote, price), change24hPct: r.range(-18, 64), volume24h: volume * r.range(0.08, 0.35),
        liquidityQuote: totalRaised! * r.range(1.6, 2.4), marketCapQuote: price * totalSupply, holders: r.int(400, 6200),
        graduationSlot: 312_000_000 + r.int(0, 4_000_000), graduatedTs: nowSec - s.t,
      };
      L.vault = {
        creditLine, balance: Math.max(0, creditLine - spent), dripAmount, dripIntervalSec: DEFAULT_DRIP_INTERVAL_SEC,
        nextDripTs: dripsExecuted >= DEMO_DRIP_COUNT ? 0 : nowSec + (DEFAULT_DRIP_INTERVAL_SEC - (s.t % DEFAULT_DRIP_INTERVAL_SEC)),
        dripsExecuted, dripsTotal: DEMO_DRIP_COUNT, tokensBurned: spent / (price * 0.8), quoteSpent: spent,
      };
      L.credit = {
        creditLine, repaid, repaidPct, phase: flywheel ? "flywheel" : "repaying", feesCollected,
        holderPayouts: (flyFees * FLYWHEEL_SPLIT.holderPayoutBps) / 10_000,
        platformBurnQuote: (repaid / 0.8) * 0.2 + (flyFees * FLYWHEEL_SPLIT.platformBuybackBurnBps) / 10_000,
        treasury: (flyFees * FLYWHEEL_SPLIT.treasuryBps) / 10_000,
      };
      L.status = flywheel ? "flywheel" : "live";

      // chart: 96 points back from now
      const pts: PricePoint[] = [];
      let p = clearingPrice!;
      const span = Math.min(s.t, 2 * 86400);
      for (let i = 0; i < 96; i++) {
        const ts = nowSec - span + Math.floor((span * i) / 95);
        const target = clearingPrice! + ((price - clearingPrice!) * i) / 95;
        p = Math.max(clearingPrice! * 0.6, target * r.range(0.94, 1.06));
        pts.push({ ts, price: i === 95 ? price : p, volume: (volume / 96) * r.range(0.3, 1.8) });
      }
      world.charts[id] = pts;

      // trades + buybacks
      const trades: Trade[] = [];
      for (let i = 0; i < 40; i++) {
        const isBuyback = i % 6 === 2;
        const ts = nowSec - i * r.int(8, 45);
        const px = price * r.range(0.97, 1.03);
        const amountQuote = isBuyback ? dripAmount : r.range(0.2, 8) * (raise / 400);
        trades.push({
          id: `${id}-t${i}`, launchId: id, side: isBuyback || r.next() > 0.42 ? "buy" : "sell", wallet: isBuyback ? "BuybackVault" : fakeKey(r),
          amountQuote, amountToken: amountQuote / px, price: px, signature: fakeSig(r), slot: L.market.graduationSlot + 1000 + (40 - i) * 30,
          ts, isBuyback, isSniper: false,
        });
        if (isBuyback && i < 30) {
          world.buybacks.push({ id: `${id}-b${i}`, launchId: id, ticker: s.ticker, quoteAsset: s.quote, quoteSpent: dripAmount, tokensBurned: dripAmount / px, price: px, signature: trades[i]!.signature, ts, dripIndex: Math.max(0, dripsExecuted - Math.floor(i / 6)) });
        }
      }
      world.trades[id] = trades;

      world.ledger.push({ id: `${id}-adv`, launchId: id, ticker: s.ticker, kind: "advance", amount: creditLine, quoteAsset: s.quote, signature: fakeSig(r), ts: nowSec - s.t });
      for (let i = 0; i < 4; i++) {
        world.ledger.push({ id: `${id}-rp${i}`, launchId: id, ticker: s.ticker, kind: "repayment", amount: repaid / 4, quoteAsset: s.quote, signature: fakeSig(r), ts: nowSec - Math.floor((s.t * (4 - i)) / 5) });
      }
      if (flywheel) world.ledger.push({ id: `${id}-fh`, launchId: id, ticker: s.ticker, kind: "flywheel_holder", amount: L.credit.holderPayouts, quoteAsset: s.quote, signature: fakeSig(r), ts: nowSec - r.int(60, 900) });
    }
    world.launches.push(L);
  }
  world.buybacks.sort((a, b) => b.ts - a.ts);
  world.ledger.sort((a, b) => b.ts - a.ts);
  world.rngState = r.s;
  return world;
}

/** Advance the simulation to `nowSec`. Mutates the world, returns produced events. */
export function tickDemoWorld(world: DemoWorld, nowSec: number = Math.floor(Date.now() / 1000)): DemoEvent[] {
  const r = new Rng(world.rngState || 1);
  const events: DemoEvent[] = [];
  const dt = Math.max(0, nowSec - world.lastTickTs);
  world.lastTickTs = nowSec;
  if (dt === 0) return events;

  for (const L of world.launches) {
    const a = L.auction;
    if (L.status === "commit") {
      if (r.next() < Math.min(0.9, dt * 0.25)) {
        a.bidCount += 1;
        if (r.next() < 0.85) a.escrowedWallets += 1;
        a.totalEscrowed += a.targetRaise * r.range(0.002, 0.02);
        events.push({ kind: "bid", launch: L });
      }
      if (nowSec >= a.commitEndTs) { L.status = "reveal"; events.push({ kind: "phase", launch: L, from: "commit" }); }
    } else if (L.status === "reveal") {
      a.revealedCount = Math.min(a.bidCount, a.revealedCount + r.int(0, 4));
      if (nowSec >= a.revealEndTs) {
        // Demo restarts finished auctions as fresh ones so the lobby always has live sealed auctions.
        const from = L.status;
        a.commitStartTs = nowSec; a.commitEndTs = nowSec + r.int(8, 25) * 60; a.revealEndTs = a.commitEndTs + 120;
        a.bidCount = r.int(3, 12); a.escrowedWallets = a.bidCount; a.revealedCount = 0; a.totalEscrowed = a.targetRaise * 0.05;
        L.status = "commit";
        events.push({ kind: "phase", launch: L, from });
      }
    } else if ((L.status === "live" || L.status === "flywheel") && L.market && L.vault && L.credit) {
      const m = L.market, v = L.vault, c = L.credit;
      // organic trades
      const nTrades = r.next() < Math.min(0.95, dt * 0.35) ? 1 : 0;
      for (let i = 0; i < nTrades; i++) {
        const side = r.next() > 0.45 ? "buy" : "sell";
        const amountQuote = r.range(0.1, 6) * (a.targetRaise / 400);
        m.price *= side === "buy" ? 1 + r.range(0, 0.006) : 1 - r.range(0, 0.005);
        const t: Trade = { id: `${L.id}-t${nowSec}-${i}`, launchId: L.id, side, wallet: fakeKey(r), amountQuote, amountToken: amountQuote / m.price, price: m.price, signature: fakeSig(r), slot: m.graduationSlot + (nowSec - m.graduatedTs) * 2, ts: nowSec, isBuyback: false, isSniper: false };
        pushTrade(world, t);
        events.push({ kind: "trade", trade: t });
        const fee = (amountQuote * POOL_FEE_BPS) / 10_000;
        c.feesCollected += fee; m.volume24h += amountQuote;
        if (c.phase === "repaying") {
          const rep = Math.min(fee * 0.8, c.creditLine - c.repaid);
          c.repaid += rep; c.platformBurnQuote += fee * 0.2;
          c.repaidPct = Math.min(100, (c.repaid / c.creditLine) * 100);
          if (r.next() < 0.15) {
            const e: CreditLedgerEntry = { id: `${L.id}-rp${nowSec}`, launchId: L.id, ticker: L.ticker, kind: "repayment", amount: rep, quoteAsset: L.quoteAsset, signature: fakeSig(r), ts: nowSec };
            world.ledger.unshift(e); events.push({ kind: "ledger", entry: e, launch: L });
          }
          if (c.repaid >= c.creditLine - 1e-9) { c.phase = "flywheel"; L.status = "flywheel"; c.repaidPct = 100; events.push({ kind: "flywheel", launch: L }); }
        } else {
          c.holderPayouts += fee * 0.5; c.platformBurnQuote += fee * 0.35; c.treasury += fee * 0.15;
        }
      }
      // demo accelerates repayment slowly so bars visibly move
      if (c.phase === "repaying") {
        const bump = c.creditLine * 0.0004 * dt;
        c.repaid = Math.min(c.creditLine, c.repaid + bump); c.repaidPct = (c.repaid / c.creditLine) * 100;
      }
      // buyback drip
      if (v.nextDripTs > 0 && nowSec >= v.nextDripTs && v.balance > 0 && v.dripsExecuted < v.dripsTotal) {
        // final drip sweeps the remainder (no float dust left behind)
        const amt = v.dripsExecuted >= v.dripsTotal - 1 ? v.balance : Math.min(v.dripAmount, v.balance);
        const burned = amt / m.price;
        v.balance = Math.max(0, v.balance - amt); v.quoteSpent += amt; v.tokensBurned += burned; v.dripsExecuted += 1;
        v.nextDripTs = v.dripsExecuted >= v.dripsTotal || v.balance <= 0 ? 0 : nowSec + v.dripIntervalSec;
        m.price *= 1 + r.range(0.001, 0.008);
        const sig = fakeSig(r);
        const ev: BuybackEvent = { id: `${L.id}-b${nowSec}`, launchId: L.id, ticker: L.ticker, quoteAsset: L.quoteAsset, quoteSpent: amt, tokensBurned: burned, price: m.price, signature: sig, ts: nowSec, dripIndex: v.dripsExecuted };
        world.buybacks.unshift(ev); world.buybacks.length = Math.min(world.buybacks.length, 200);
        const t: Trade = { id: `${L.id}-bt${nowSec}`, launchId: L.id, side: "buy", wallet: "BuybackVault", amountQuote: amt, amountToken: burned, price: m.price, signature: sig, slot: m.graduationSlot + (nowSec - m.graduatedTs) * 2, ts: nowSec, isBuyback: true, isSniper: false };
        pushTrade(world, t);
        events.push({ kind: "drip", event: ev, launch: L });
      } else if (v.nextDripTs === 0 && v.balance > 0 && v.dripsExecuted < v.dripsTotal) {
        v.nextDripTs = nowSec + v.dripIntervalSec;
      }
      m.priceUsd = usd(L.quoteAsset, m.price);
      m.marketCapQuote = m.price * L.totalSupply;
      const pts = world.charts[L.id] ?? (world.charts[L.id] = []);
      const last = pts[pts.length - 1];
      if (!last || nowSec - last.ts >= 60) { pts.push({ ts: nowSec, price: m.price, volume: 0 }); if (pts.length > 240) pts.shift(); }
      else { last.price = m.price; }
    }
  }
  world.rngState = r.s;
  return events;
}

function pushTrade(world: DemoWorld, t: Trade) {
  const list = world.trades[t.launchId] ?? (world.trades[t.launchId] = []);
  list.unshift(t);
  if (list.length > 100) list.length = 100;
}

export function demoStats(world: DemoWorld, nowSec: number = Math.floor(Date.now() / 1000)): ProtocolStats {
  let vol = 0, fees = 0, active = 0, deployed = 0, repaid = 0, burnedUsd = 0, holder = 0, platBurn = 0;
  let live = 0, vaults = 0, fly = 0;
  for (const L of world.launches) {
    const px = QUOTE_ASSETS[L.quoteAsset].demoUsdPrice;
    if (L.status === "commit" || L.status === "reveal") live++;
    if (L.status === "live") vaults++;
    if (L.status === "flywheel") fly++;
    if (L.credit && L.vault) {
      vol += (L.credit.feesCollected / (POOL_FEE_BPS / 10_000)) * px;
      fees += L.credit.feesCollected * px;
      active += L.vault.balance * px;
      deployed += L.credit.creditLine * px;
      repaid += L.credit.repaid * px;
      burnedUsd += L.vault.quoteSpent * px;
      holder += L.credit.holderPayouts * px;
      platBurn += L.credit.platformBurnQuote * px;
    }
  }
  const outstanding = Math.max(1, deployed - repaid);
  return {
    totalVolumeUsd: vol, totalFeesUsd: fees, activeBuybackCreditUsd: active, totalCreditDeployedUsd: deployed, totalCreditRepaidUsd: repaid,
    // Credit Pool assets (outstanding principal + recycled repayments + reserve) / outstanding obligations.
    solvencyRatio: Math.min(9.99, (outstanding + repaid * 0.25 + deployed * 0.1) / outstanding),
    totalTokensBurnedUsd: burnedUsd, platformTokensBurned: Math.round(platBurn * 412.5), holderPayoutsUsd: holder,
    liveAuctions: live, activeVaults: vaults, graduatedFlywheels: fly, snipersBlocked: 37 + Math.floor((nowSec % 86400) / 3600),
    network: "devnet", isDemo: true, updatedTs: nowSec,
  };
}
