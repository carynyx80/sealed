import { randomUUID } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import {
  BPS_DENOMINATOR,
  CREDIT_TIERS,
  DEFAULT_DRIP_COUNT,
  DEFAULT_DRIP_INTERVAL_SEC,
  MAX_AUCTION_SUPPLY_BPS,
  MAX_COMMIT_DURATION_SEC,
  MAX_CREATOR_ALLOCATION_BPS,
  MIN_AUCTION_SUPPLY_BPS,
  NUM_PRICE_TICKS,
  QUOTE_ASSETS,
  TOKEN_UNIT,
  dripAmount,
  demoImage,
  pdas,
  programId,
  type BuybackEvent,
  type CreateLaunchInput,
  type CreditLedgerEntry,
  type CreditLedgerKind,
  type LaunchSummary,
  type QuoteAssetSymbol,
  type Trade,
} from "@sealed/shared";
import { acct, assetDecimals, fromAtoms, toAtoms, tokenAsset } from "../ledger.js";
import type { LaunchRow, TxRow } from "../repo/types.js";
import { EngineError, bi, invalidate, nowS, publish, type EngineDeps } from "./common.js";

export const quoteDecimals = (l: { quoteAsset: string }) => assetDecimals(l.quoteAsset);

/** POST /api/launches (offchain): creator = authed wallet; creator allocation ≤ 2% enforced here too. */
export async function createLaunch(d: EngineDeps, input: CreateLaunchInput, creator: string): Promise<LaunchRow> {
  if (input.creatorAllocationBps < 0 || input.creatorAllocationBps > MAX_CREATOR_ALLOCATION_BPS) throw new EngineError(400, "creator allocation must be ≤ 2% of supply");
  if (input.auctionSupplyBps < MIN_AUCTION_SUPPLY_BPS || input.auctionSupplyBps > MAX_AUCTION_SUPPLY_BPS) throw new EngineError(400, "auctionSupplyBps out of range");
  if (input.commitDurationSec < d.minCommitSec || input.commitDurationSec > MAX_COMMIT_DURATION_SEC) {
    throw new EngineError(400, `commitDurationSec must be within [${d.minCommitSec}, ${MAX_COMMIT_DURATION_SEC}]`);
  }
  const qa = QUOTE_ASSETS[input.quoteAsset];
  const floorPrice = toAtoms(input.floorPrice, qa.decimals);
  const tickSize = toAtoms(input.tickSize, qa.decimals);
  const targetRaise = toAtoms(input.targetRaise, qa.decimals);
  const clearingCap = toAtoms(input.clearingCap, qa.decimals);
  if (floorPrice <= 0n || tickSize <= 0n) throw new EngineError(400, "floorPrice / tickSize too small for the quote asset's decimals");
  if (clearingCap < targetRaise) throw new EngineError(400, "clearingCap must be ≥ targetRaise");

  const D = BigInt(BPS_DENOMINATOR);
  const totalSupply = BigInt(input.totalSupply) * TOKEN_UNIT;
  const creatorAllocation = (totalSupply * BigInt(input.creatorAllocationBps)) / D;
  const tokensForSale = (totalSupply * BigInt(input.auctionSupplyBps)) / D;
  const poolTokenAllocation = totalSupply - creatorAllocation - tokensForSale;

  const mint = Keypair.generate().publicKey;
  const [launchPda] = pdas.launch(mint, programId());
  const now = nowS(d);
  const hue = [...input.ticker].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
  const row: LaunchRow = {
    id: launchPda.toBase58(),
    mint: mint.toBase58(),
    name: input.name,
    ticker: input.ticker,
    description: input.description,
    imageUri: input.imageUri || demoImage(input.ticker, hue),
    creator,
    quoteAsset: input.quoteAsset,
    creditTier: input.creditTier,
    creditBps: CREDIT_TIERS[input.creditTier],
    network: d.network,
    status: "commit",
    createdTs: now,
    creatorAllocationBps: input.creatorAllocationBps,
    totalSupply,
    creatorAllocation,
    tokensForSale,
    poolTokenAllocation,
    floorPrice,
    tickSize,
    numTicks: NUM_PRICE_TICKS,
    targetRaise,
    clearingCap,
    commitStartTs: now,
    commitEndTs: now + input.commitDurationSec,
    revealEndTs: now + input.commitDurationSec + input.revealDurationSec,
    bidCount: 0,
    revealedCount: 0,
    totalEscrowed: 0n,
    clearingPrice: null,
    totalRaised: null,
    tokensSold: null,
    winners: 0,
    graduatedAtMs: null,
    creditLine: 0n,
    creditOutstanding: 0n,
    vaultInitial: 0n,
    dripCount: DEFAULT_DRIP_COUNT,
    dripsExecuted: 0,
    dripIntervalSec: DEFAULT_DRIP_INTERVAL_SEC,
    nextDripTs: 0,
    rewardPerShare: 0n,
    eligibleStaked: 0n,
    feeDistributions: 0,
    feesCollected: 0n,
    creditRepaid: 0n,
    holderPayouts: 0n,
    platformBurn: 0n,
    treasuryTotal: 0n,
    vaultQuoteSpent: 0n,
    tokensBurned: 0n,
    volumeQuote: 0n,
  };
  await d.repo.tx((t) => t.insertLaunch(row));
  await invalidate(d);
  const summary = await toSummary(d, row);
  publish(d, [{ type: "launch.created", data: summary }]);
  return row;
}

// ------------------------------------------------------------------ read model → existing DTOs

export async function poolReserves(d: EngineDeps, l: LaunchRow, t = d.repo.read) {
  const [q, k] = await Promise.all([t.getAccount(acct.launch("pool_quote", l.id, l.quoteAsset)), t.getAccount(acct.launch("pool_token", l.id, tokenAsset(l.id)))]);
  return { quote: q?.balance ?? 0n, token: k?.balance ?? 0n };
}

/** Spot price in UI units (quote per whole token). Display only. */
export function spotPriceUi(l: LaunchRow, quote: bigint, token: bigint): number {
  if (token <= 0n) return 0;
  return fromAtoms(quote, quoteDecimals(l)) / fromAtoms(token, 6);
}

export async function toSummary(d: EngineDeps, l: LaunchRow): Promise<LaunchSummary> {
  const qd = quoteDecimals(l);
  const q = (v: bigint | null) => (v === null ? null : fromAtoms(v, qd));
  const tok = (v: bigint) => fromAtoms(v, 6);
  const qa = QUOTE_ASSETS[l.quoteAsset as QuoteAssetSymbol];
  const graduated = l.status === "live" || l.status === "flywheel";
  const now = nowS(d);

  let market: LaunchSummary["market"] = null;
  let vault: LaunchSummary["vault"] = null;
  let credit: LaunchSummary["credit"] = null;
  if (graduated) {
    const r = d.repo.read;
    const res = await poolReserves(d, l);
    const price = spotPriceUi(l, res.quote, res.token);
    const swaps = await r.listTxs({ launchId: l.id, kinds: ["swap"], sinceTs: now - 86_400, limit: 5_000 });
    const vol = swaps.reduce((a, s) => a + bi(s.meta.amountQuote), 0n);
    const first = swaps[swaps.length - 1];
    const firstPrice = first ? Number(first.meta.priceBefore ?? first.meta.price ?? 0) : 0;
    const holders = new Set<string>();
    for (const a of await r.listAccounts({ asset: tokenAsset(l.id) })) if (a.owner !== "system" && a.balance > 0n) holders.add(a.owner);
    const vaultBal = (await r.getAccount(acct.launch("buyback_vault", l.id, l.quoteAsset)))?.balance ?? 0n;
    const circulating = l.totalSupply - l.tokensBurned;
    market = {
      price,
      priceUsd: price * qa.demoUsdPrice,
      change24hPct: firstPrice > 0 ? ((price - firstPrice) / firstPrice) * 100 : 0,
      volume24h: fromAtoms(vol, qd),
      liquidityQuote: fromAtoms(res.quote, qd) * 2,
      marketCapQuote: price * tok(circulating),
      holders: holders.size,
      graduationSlot: 0,
      graduatedTs: l.graduatedAtMs ? Math.floor(l.graduatedAtMs / 1000) : 0,
    };
    const nextDrip = l.dripsExecuted < l.dripCount && vaultBal > 0n ? dripAmount(l.vaultInitial, l.dripCount, l.dripsExecuted, vaultBal) : 0n;
    vault = {
      creditLine: fromAtoms(l.creditLine, qd),
      balance: fromAtoms(vaultBal, qd),
      dripAmount: fromAtoms(nextDrip, qd),
      dripIntervalSec: l.dripIntervalSec,
      nextDripTs: vaultBal > 0n ? l.nextDripTs : 0,
      dripsExecuted: l.dripsExecuted,
      dripsTotal: l.dripCount,
      tokensBurned: tok(l.tokensBurned),
      quoteSpent: fromAtoms(l.vaultQuoteSpent, qd),
    };
    credit = {
      creditLine: fromAtoms(l.creditLine, qd),
      repaid: fromAtoms(l.creditRepaid, qd),
      repaidPct: l.creditLine > 0n ? Number((l.creditRepaid * 10_000n) / l.creditLine) / 100 : 100,
      phase: l.status === "flywheel" ? "flywheel" : "repaying",
      feesCollected: fromAtoms(l.feesCollected, qd),
      holderPayouts: fromAtoms(l.holderPayouts, qd),
      platformBurnQuote: fromAtoms(l.platformBurn, qd),
      treasury: fromAtoms(l.treasuryTotal, qd),
    };
  }
  const cleared = !(l.status === "commit" || l.status === "reveal" || l.status === "clearing");
  return {
    id: l.id,
    mint: l.mint,
    name: l.name,
    ticker: l.ticker,
    description: l.description,
    imageUri: l.imageUri,
    creator: l.creator,
    creatorAllocationBps: l.creatorAllocationBps,
    totalSupply: tok(l.totalSupply),
    quoteAsset: l.quoteAsset as QuoteAssetSymbol,
    creditTier: l.creditTier as LaunchSummary["creditTier"],
    status: l.status,
    createdTs: l.createdTs,
    auction: {
      commitStartTs: l.commitStartTs,
      commitEndTs: l.commitEndTs,
      revealEndTs: l.revealEndTs,
      bidCount: l.bidCount,
      revealedCount: l.revealedCount,
      escrowedWallets: l.bidCount, // one bid per wallet
      totalEscrowed: fromAtoms(l.totalEscrowed, qd),
      floorPrice: fromAtoms(l.floorPrice, qd),
      tickSize: fromAtoms(l.tickSize, qd),
      tokensForSale: tok(l.tokensForSale),
      targetRaise: fromAtoms(l.targetRaise, qd),
      clearingCap: fromAtoms(l.clearingCap, qd),
      clearingPrice: cleared ? q(l.clearingPrice) : null,
      totalRaised: cleared ? q(l.totalRaised) : null,
    },
    market,
    vault,
    credit,
    network: l.network as LaunchSummary["network"],
    isDemo: false,
  };
}

export function tradeFromTx(l: LaunchRow, tx: TxRow): Trade {
  const qd = quoteDecimals(l);
  const m = tx.meta;
  const isBuyback = tx.kind === "drip";
  const amountQuote = fromAtoms(bi(isBuyback ? m.quoteSpent : m.amountQuote), qd);
  const amountToken = fromAtoms(bi(isBuyback ? m.tokensBurned : m.amountToken), 6);
  return {
    id: tx.id,
    launchId: l.id,
    side: isBuyback ? "buy" : (m.side as Trade["side"]),
    wallet: isBuyback ? "buyback_vault" : String(m.wallet),
    amountQuote,
    amountToken,
    price: amountToken > 0 ? amountQuote / amountToken : 0,
    signature: `offchain:${tx.id}`,
    slot: 0,
    ts: tx.createdTs,
    isBuyback,
    isSniper: m.isSniper === true,
  };
}

export function buybackFromTx(l: LaunchRow, tx: TxRow): BuybackEvent {
  const t = tradeFromTx(l, tx);
  return {
    id: tx.id,
    launchId: l.id,
    ticker: l.ticker,
    quoteAsset: l.quoteAsset as QuoteAssetSymbol,
    quoteSpent: t.amountQuote,
    tokensBurned: t.amountToken,
    price: t.price,
    signature: t.signature,
    ts: tx.createdTs,
    dripIndex: Number(tx.meta.dripIndex ?? 0),
  };
}

/** graduate → "advance"; distribute → repayment / platform_ops / flywheel_* rows (non-zero only). */
export function creditEntriesFromTx(l: LaunchRow, tx: TxRow): CreditLedgerEntry[] {
  const qd = quoteDecimals(l);
  const mk = (kind: CreditLedgerKind, atoms: bigint): CreditLedgerEntry => ({
    id: `${tx.id}:${kind}`,
    launchId: l.id,
    ticker: l.ticker,
    kind,
    amount: fromAtoms(atoms, qd),
    quoteAsset: l.quoteAsset as QuoteAssetSymbol,
    signature: `offchain:${tx.id}`,
    ts: tx.createdTs,
  });
  if (tx.kind === "graduate") return bi(tx.meta.credit) > 0n ? [mk("advance", bi(tx.meta.credit))] : [];
  if (tx.kind !== "distribute") return [];
  const m = tx.meta;
  const rows: [CreditLedgerKind, bigint][] = [
    ["repayment", bi(m.creditRepay)],
    ["platform_ops", bi(m.platformOps)],
    ["flywheel_holder", bi(m.holders)],
    ["flywheel_platform_burn", bi(m.platformBuybackBurn)],
    ["flywheel_treasury", bi(m.treasury)],
  ];
  return rows.filter(([, v]) => v > 0n).map(([k, v]) => mk(k, v));
}

export const newId = () => randomUUID();
