"use client";
/**
 * Client-side demo world. Used whenever the API is unreachable so the UI stays alive with
 * ticking auctions, buyback drips and repayment bars. Built on the shared deterministic
 * simulator (createDemoWorld / tickDemoWorld / demoStats).
 * NEVER on mainnet: every entry point is guarded by DEMO_ENABLED (lib/config) so a mainnet build cannot
 * construct, tick or display a demo world, even if a caller forgets to check.
 */
import {
  createDemoWorld,
  demoImage,
  demoStats,
  tickDemoWorld,
  type CreateLaunchInput,
  type DemoWorld,
  type LaunchSummary,
  type RevenueResponse,
} from "@sealed/shared";
import { DEMO_ENABLED, NETWORK } from "./config";

const LOCAL_KEY = "sealed:local-launches:v1";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

let world: DemoWorld | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();
let version = 0;

const nowSec = () => Math.floor(Date.now() / 1000);

function randomKey(len = 44): string {
  let s = "";
  const bytes = new Uint8Array(len);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  for (let i = 0; i < len; i++) s += B58[bytes[i]! % 58];
  return s;
}

function loadLocal(): LaunchSummary[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as LaunchSummary[]) : [];
  } catch {
    return [];
  }
}

function saveLocal() {
  if (!world) return;
  try {
    const mine = world.launches.filter((l) => l.id.startsWith("local"));
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(mine.slice(-10)));
  } catch {
    /* storage unavailable */
  }
}

export class DemoDisabledError extends Error {
  constructor() {
    super("Demo data is disabled on mainnet");
    this.name = "DemoDisabledError";
  }
}

export function getDemoWorld(): DemoWorld {
  if (!DEMO_ENABLED) throw new DemoDisabledError();
  if (!world) {
    world = createDemoWorld(nowSec());
    const local = loadLocal();
    for (const L of local) {
      // Expired local auctions restart so they stay demo-able.
      if (L.auction.revealEndTs < nowSec()) {
        const dur = L.auction.commitEndTs - L.auction.commitStartTs;
        L.auction.commitStartTs = nowSec();
        L.auction.commitEndTs = nowSec() + dur;
        L.auction.revealEndTs = L.auction.commitEndTs + 120;
        L.status = "commit";
      }
      world.launches.unshift(L);
    }
  }
  return world;
}

function emit() {
  version++;
  for (const l of listeners) l();
}

export function subscribeDemo(fn: () => void): () => void {
  if (!DEMO_ENABLED) return () => undefined;
  listeners.add(fn);
  getDemoWorld();
  if (!timer) {
    timer = setInterval(() => {
      if (!world) return;
      tickDemoWorld(world, nowSec());
      emit();
    }, 1000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function demoVersion() {
  return version;
}

export function findDemoLaunch(idOrMint: string): LaunchSummary | undefined {
  if (!DEMO_ENABLED) return undefined;
  return getDemoWorld().launches.find((l) => l.id === idOrMint || l.mint === idOrMint);
}

export function demoRevenue(): RevenueResponse {
  const w = getDemoWorld();
  const stats = demoStats(w, nowSec());
  const days = 14;
  const daily: RevenueResponse["daily"] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000);
    const t = (days - i) / days;
    const wobble = 0.75 + 0.5 * Math.abs(Math.sin((days - i) * 1.7));
    const share = (t * t * wobble) / (days * 0.4);
    daily.push({
      date: d.toISOString().slice(0, 10),
      feesUsd: stats.totalFeesUsd * share,
      creditRepaidUsd: stats.totalCreditRepaidUsd * share,
      burnedUsd: stats.totalTokensBurnedUsd * share,
      holderPayoutsUsd: stats.holderPayoutsUsd * share,
    });
  }
  return { stats, recentBuybacks: w.buybacks.slice(0, 40), ledger: w.ledger.slice(0, 60), daily };
}

/** Create a sealed auction in the local demo world (used when POST /api/launches is unreachable). */
export function createDemoLaunch(input: CreateLaunchInput): LaunchSummary {
  const w = getDemoWorld();
  const now = nowSec();
  const tokensForSale = (input.totalSupply * (input.auctionSupplyBps ?? 4000)) / 10_000;
  const hue = Math.floor(Math.random() * 360);
  const L: LaunchSummary = {
    id: `local${randomKey(39)}`,
    mint: randomKey(44),
    name: input.name,
    ticker: input.ticker,
    description: input.description ?? "",
    imageUri: input.imageUri || demoImage(input.ticker, hue),
    creator: input.creator ?? randomKey(44),
    creatorAllocationBps: input.creatorAllocationBps,
    totalSupply: input.totalSupply,
    quoteAsset: input.quoteAsset,
    creditTier: input.creditTier ?? "standard",
    status: "commit",
    createdTs: now,
    auction: {
      commitStartTs: now,
      commitEndTs: now + input.commitDurationSec,
      revealEndTs: now + input.commitDurationSec + (input.revealDurationSec ?? 120),
      bidCount: 0,
      revealedCount: 0,
      escrowedWallets: 0,
      totalEscrowed: 0,
      floorPrice: input.floorPrice,
      tickSize: input.tickSize,
      tokensForSale,
      targetRaise: input.targetRaise,
      clearingCap: input.clearingCap,
      clearingPrice: null,
      totalRaised: null,
    },
    market: null,
    vault: null,
    credit: null,
    network: NETWORK,
    isDemo: true,
  };
  w.launches.unshift(L);
  saveLocal();
  emit();
  return L;
}

/** Reflect a locally committed bid in the demo world's public counters (amounts stay hidden). */
export function noteDemoBid(idOrMint: string, deposit: number) {
  if (!DEMO_ENABLED) return;
  const L = world?.launches.find((l) => l.id === idOrMint || l.mint === idOrMint);
  if (!L || L.status !== "commit") return;
  L.auction.bidCount += 1;
  L.auction.escrowedWallets += 1;
  L.auction.totalEscrowed += deposit;
  emit();
}
