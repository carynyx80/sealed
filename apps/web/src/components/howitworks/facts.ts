// Every number on /how-it-works is derived here from @sealed/shared so the explainer never drifts from the protocol.
import {
  ANTI_SNIPE_WINDOW_SEC,
  BPS_DENOMINATOR,
  COMPANY_WALLET,
  CREDIT_TIERS,
  DEFAULT_DRIP_COUNT,
  DEFAULT_DRIP_INTERVAL_SEC,
  DEFAULT_REVEAL_DURATION_SEC,
  FLYWHEEL_SPLIT,
  MAX_COMMIT_DURATION_SEC,
  MAX_CREATOR_ALLOCATION_BPS,
  MAX_DRIP_INTERVAL_SEC,
  MIN_COMMIT_DURATION_SEC_MAINNET,
  MIN_DRIP_INTERVAL_SEC,
  NO_REVEAL_SLASH_BPS,
  POOL_FEE_BPS,
  QUOTE_ASSETS,
  QUOTE_ASSET_MAINNET,
  REPAY_SPLIT,
  TOKEN_UNIT,
  WITHDRAWAL_LIMITS,
  computeClearing,
  settleBid,
  type QuoteAssetSymbol,
} from "@sealed/shared";

export const pct = (bps: number) => `${+(bps / 100).toFixed(2)}%`;
export const share = (bps: number) => bps / BPS_DENOMINATOR;
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const mins = (s: number) => +(s / 60).toFixed(1);

const tiers = Object.values(CREDIT_TIERS);
const enabled = (Object.keys(QUOTE_ASSET_MAINNET) as QuoteAssetSymbol[]).filter((s) => QUOTE_ASSET_MAINNET[s].enabled);
const comingSoon = (Object.keys(QUOTE_ASSET_MAINNET) as QuoteAssetSymbol[]).filter((s) => !QUOTE_ASSET_MAINNET[s].enabled && QUOTE_ASSETS[s].kind === "stock");

export const FACTS = {
  companyWallet: COMPANY_WALLET,
  companyWalletShort: `${COMPANY_WALLET.slice(0, 4)}…${COMPANY_WALLET.slice(-4)}`,
  assets: enabled, // ["SOL", "USDC"]
  assetsLabel: enabled.join(" or "),
  comingSoon,
  commitMin: mins(MIN_COMMIT_DURATION_SEC_MAINNET),
  commitMax: mins(MAX_COMMIT_DURATION_SEC),
  revealMin: mins(DEFAULT_REVEAL_DURATION_SEC),
  noRevealSlash: pct(NO_REVEAL_SLASH_BPS),
  creditMin: pct(Math.min(...tiers)),
  creditMax: pct(Math.max(...tiers)),
  dripEvery: mins(DEFAULT_DRIP_INTERVAL_SEC),
  dripMin: mins(MIN_DRIP_INTERVAL_SEC),
  dripMax: mins(MAX_DRIP_INTERVAL_SEC),
  dripCount: DEFAULT_DRIP_COUNT,
  dripHours: +((DEFAULT_DRIP_COUNT * DEFAULT_DRIP_INTERVAL_SEC) / 3600).toFixed(1),
  poolFee: pct(POOL_FEE_BPS),
  repayBps: REPAY_SPLIT.creditRepayBps,
  opsBps: REPAY_SPLIT.platformBurnOpsBps,
  holdersBps: FLYWHEEL_SPLIT.holderPayoutBps,
  burnBps: FLYWHEEL_SPLIT.platformBuybackBurnBps,
  treasuryBps: FLYWHEEL_SPLIT.treasuryBps,
  creatorMax: pct(MAX_CREATOR_ALLOCATION_BPS),
  antiSnipeSec: ANTI_SNIPE_WINDOW_SEC,
  autoWithdrawMax: usd(WITHDRAWAL_LIMITS.autoApproveMaxUsd),
  dailyWithdrawMax: usd(WITHDRAWAL_LIMITS.dailyPerWalletUsd),
} as const;

/* ---------------- worked clearing example (real computeClearing / settleBid) ---------------- */

const USDC = 1_000_000n; // USDC atoms per 1 USDC
const FLOOR = 10_000n; // 0.010 USDC per token
const TICK = 1_000n; // 0.001 USDC per tick
const NUM_TICKS = 64;
const FOR_SALE_WHOLE = 1_000_000n;

const RAW_BIDS = [
  { who: "A", maxPrice: 0.02, amount: 6_000 },
  { who: "B", maxPrice: 0.018, amount: 4_000 },
  { who: "C", maxPrice: 0.015, amount: 5_000 },
  { who: "D", maxPrice: 0.013, amount: 3_000 },
  { who: "E", maxPrice: 0.011, amount: 2_000 },
];

const tickOf = (p: number) => Math.round((p * 1_000_000 - Number(FLOOR)) / Number(TICK));
const buckets: bigint[] = Array.from({ length: NUM_TICKS }, () => 0n);
for (const b of RAW_BIDS) buckets[tickOf(b.maxPrice)]! += BigInt(b.amount) * USDC;

const clearing = computeClearing({
  floorPrice: FLOOR,
  tickSize: TICK,
  numTicks: NUM_TICKS,
  buckets,
  tokensForSale: FOR_SALE_WHOLE * TOKEN_UNIT,
  clearingCap: 1_000_000n * USDC,
});

const atomsToUsdc = (a: bigint) => Number(a) / Number(USDC);
const atomsToTokens = (a: bigint) => Number(a / TOKEN_UNIT);

export interface ExampleBid {
  who: string;
  maxPrice: number;
  amount: number;
  won: boolean;
  spent: number;
  tokens: number;
  refund: number;
}

export const EXAMPLE = {
  forSale: Number(FOR_SALE_WHOLE),
  floor: atomsToUsdc(FLOOR),
  price: atomsToUsdc(clearing.clearingPrice),
  raised: atomsToUsdc(clearing.totalRaised),
  bids: RAW_BIDS.map((b): ExampleBid => {
    const amt = BigInt(b.amount) * USDC;
    const s = settleBid(clearing, FLOOR, TICK, tickOf(b.maxPrice), amt, amt);
    return { ...b, won: s.won, spent: atomsToUsdc(s.spent), tokens: atomsToTokens(s.tokens), refund: atomsToUsdc(s.refund) };
  }),
};

export const fmtNum = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmtPrice = (n: number) => n.toFixed(3);
