/**
 * Domain types shared by API, web and integration code.
 *
 * Convention: API/WS DTOs carry amounts in UI units (JS numbers, already divided by decimals).
 * On-chain / transaction-building code uses bigint atoms. Never mix the two in one object.
 */

export type Network = "mainnet" | "devnet" | "localnet";

export type LaunchStatus =
  | "commit" // sealed commit window open
  | "reveal" // reveal window open
  | "clearing" // reveal closed, awaiting clear_auction / graduation
  | "live" // graduated, buyback vault active, fees repaying credit
  | "flywheel" // credit 100% repaid, permanent holder flywheel
  | "failed"; // no valid bids / below minimum, all refunded

export type QuoteAssetKind = "native" | "stable" | "stock";

export type QuoteAssetSymbol = "SOL" | "USDC" | "NVDAx" | "TSLAx" | "TTWOx" | "AAPLx" | "SPYx";

export interface QuoteAsset {
  symbol: QuoteAssetSymbol;
  name: string;
  kind: QuoteAssetKind;
  decimals: number;
  /** Mint per network; null = not configured (set via env QUOTE_MINT_<SYMBOL>_<NETWORK>). */
  mints: Record<Network, string | null>;
  /** Approx USD reference price used for demo valuations only. */
  demoUsdPrice: number;
  /** Jupiter-tradable on mainnet. */
  jupiterRoutable: boolean;
}

export interface AuctionState {
  commitStartTs: number; // unix seconds
  commitEndTs: number;
  revealEndTs: number;
  bidCount: number;
  revealedCount: number;
  escrowedWallets: number;
  /** Total collateral escrowed (public on-chain; individual bids are hidden). UI units of quote. */
  totalEscrowed: number;
  floorPrice: number; // quote per whole token
  tickSize: number; // quote per whole token
  tokensForSale: number; // whole tokens
  targetRaise: number; // quote, soft target
  clearingCap: number; // quote, hard max raise
  clearingPrice: number | null;
  totalRaised: number | null;
  /** Optional: number of bids whose escrow deposit was funded from a Helius Privacy Ring confidential balance. */
  privateDeposits?: number;
}

export interface MarketState {
  price: number; // quote per whole token
  priceUsd: number;
  change24hPct: number;
  volume24h: number; // quote
  liquidityQuote: number;
  marketCapQuote: number;
  holders: number;
  graduationSlot: number;
  graduatedTs: number;
}

export interface VaultState {
  creditLine: number; // quote advanced at graduation
  balance: number; // quote remaining in the buyback vault
  dripAmount: number; // quote per drip
  dripIntervalSec: number;
  nextDripTs: number; // unix seconds
  dripsExecuted: number;
  dripsTotal: number;
  tokensBurned: number; // whole tokens burned by buybacks
  quoteSpent: number;
}

export type CreditPhase = "repaying" | "flywheel";

export interface CreditState {
  creditLine: number;
  repaid: number;
  repaidPct: number; // 0–100
  phase: CreditPhase;
  feesCollected: number; // lifetime quote fees on this pool
  holderPayouts: number;
  platformBurnQuote: number;
  treasury: number;
}

export interface LaunchSummary {
  id: string; // launch PDA (base58)
  mint: string; // token mint (base58)
  name: string;
  ticker: string;
  description: string;
  imageUri: string;
  creator: string;
  creatorAllocationBps: number;
  totalSupply: number; // whole tokens
  quoteAsset: QuoteAssetSymbol;
  creditTier: "standard" | "plus" | "premier";
  status: LaunchStatus;
  createdTs: number;
  auction: AuctionState;
  market: MarketState | null;
  vault: VaultState | null;
  credit: CreditState | null;
  network: Network;
  isDemo: boolean;
}

export type TradeSide = "buy" | "sell";

export interface Trade {
  id: string;
  launchId: string;
  side: TradeSide;
  wallet: string;
  amountQuote: number;
  amountToken: number;
  price: number;
  signature: string;
  slot: number;
  ts: number;
  /** Programmatic vault buy-and-burn. */
  isBuyback: boolean;
  /** Wallet bought in the graduation slot → anti-snipe registry. */
  isSniper: boolean;
}

export interface BuybackEvent {
  id: string;
  launchId: string;
  ticker: string;
  quoteAsset: QuoteAssetSymbol;
  quoteSpent: number;
  tokensBurned: number;
  price: number;
  signature: string;
  ts: number;
  dripIndex: number;
}

export type CreditLedgerKind = "advance" | "repayment" | "flywheel_holder" | "flywheel_platform_burn" | "flywheel_treasury" | "platform_ops";

export interface CreditLedgerEntry {
  id: string;
  launchId: string;
  ticker: string;
  kind: CreditLedgerKind;
  amount: number; // quote UI units
  quoteAsset: QuoteAssetSymbol;
  signature: string;
  ts: number;
}

export interface HolderReward {
  launchId: string;
  wallet: string;
  staked: number; // whole tokens
  claimable: number; // quote
  claimed: number;
  quoteAsset: QuoteAssetSymbol;
  eligible: boolean; // false if in anti-snipe registry
}

export interface PricePoint {
  ts: number;
  price: number;
  volume: number;
}

export interface ProtocolStats {
  totalVolumeUsd: number;
  totalFeesUsd: number;
  activeBuybackCreditUsd: number;
  totalCreditDeployedUsd: number;
  totalCreditRepaidUsd: number;
  /** creditPoolAssets / outstandingCredit, ≥ 1 means solvent. */
  solvencyRatio: number;
  totalTokensBurnedUsd: number;
  platformTokensBurned: number;
  holderPayoutsUsd: number;
  liveAuctions: number;
  activeVaults: number;
  graduatedFlywheels: number;
  snipersBlocked: number;
  network: Network;
  isDemo: boolean;
  updatedTs: number;
}

/* ---------------------------------------------------------------- Helius Solana Privacy Rings (additive) */

/** GET /api/privacy/status */
export interface PrivacyStatusResponse {
  /** Privacy Ring usable (real Helius endpoint configured) or simulated (demo). */
  available: boolean;
  network: Network;
  /** true when the API runs the simulated ring (demo mode / no HELIUS_API_KEY / localnet). */
  simulated: boolean;
  /** Solana Privacy Program id when real. */
  ringId?: string;
  /** Whether the sealed-launchpad escrow PDA can be funded from a confidential balance on this deployment. */
  escrowFunding?: boolean;
  /** Human-readable reason when something is unavailable. */
  reason?: string;
}
