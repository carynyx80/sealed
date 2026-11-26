import { z } from "zod";
import { Base58Schema, HexSchema, QuoteAssetSymbolSchema } from "./schemas.js";
import type { QuoteAssetSymbol } from "./types.js";

/**
 * OFFCHAIN CUSTODIAL MODE (default execution mode).
 *
 * The Sealed backend runs auctions, clearing, the graduation pool, buyback drips, fee splits and holder
 * rewards in a Postgres double-entry ledger. Real assets are held in the COMPANY WALLET. Users:
 *   1. sign in with their Solana wallet (Sign-In-With-Solana message → session token),
 *   2. deposit SOL/SPL by sending an on-chain transfer to the company wallet with a memo `sealed:<depositRef>`,
 *      which the backend detects via Helius RPC and credits after confirmation,
 *   3. trade/bid/claim against their internal balances through the API,
 *   4. withdraw: the backend pays out from the company wallet (needs COMPANY_WALLET_SECRET_KEY; when it is
 *      absent or a limit is exceeded, withdrawals queue for manual approval).
 * The on-chain Anchor program in programs/ remains as the future non-custodial mode.
 */

export const COMPANY_WALLET = "DDhVBh8HSwvYmCmXRowowUdDLcCc5vA9BM3GJMR3hm1j";
export type ExecutionMode = "offchain" | "onchain";

export const DEPOSIT_MEMO_PREFIX = "sealed:";
export const SIWS_STATEMENT = "Sign in to Sealed. This request will not trigger a transaction or cost any fees.";

/** Ledger asset ids: quote assets by symbol, launched tokens by `tok:<launchId>`. */
export type AssetId = QuoteAssetSymbol | `tok:${string}`;

// ---------------- auth ----------------
export const AuthNonceRequestSchema = z.object({ wallet: Base58Schema });
export interface AuthNonceResponse { nonce: string; message: string; expiresTs: number }
export const AuthVerifyRequestSchema = z.object({
  wallet: Base58Schema,
  nonce: z.string().min(16),
  signature: z.string(), // base58 ed25519 signature over `message` (utf8)
});
export interface AuthVerifyResponse { token: string; wallet: string; expiresTs: number }

// ---------------- account ----------------
export interface BalanceRow {
  asset: AssetId;
  symbol: string; // e.g. "SOL" or token ticker
  available: number; // UI units
  locked: number; // in open bids / pending withdrawals
  launchId?: string;
}
export interface AccountResponse {
  wallet: string;
  balances: BalanceRow[];
  depositRef: string; // stable per-user memo reference
  companyWallet: string;
  network: "mainnet" | "devnet" | "localnet";
  sniperFlags: string[]; // launchIds where this wallet is anti-snipe ineligible
}

export interface DepositInstructions {
  companyWallet: string;
  memo: string; // `sealed:<depositRef>`
  asset: QuoteAssetSymbol;
  mint: string | null; // null for native SOL
  minConfirmations: number;
  note: string;
}
export type DepositStatus = "detected" | "confirmed" | "credited" | "rejected";
export interface DepositRecord {
  id: string;
  signature: string;
  asset: QuoteAssetSymbol;
  amount: number;
  status: DepositStatus;
  ts: number;
  reason?: string;
}
export const DepositClaimSchema = z.object({ signature: z.string().min(64).max(100) }); // user can nudge detection

export const WithdrawRequestSchema = z.object({
  asset: QuoteAssetSymbolSchema,
  amount: z.number().positive(),
  destination: Base58Schema, // defaults client-side to the signed-in wallet
});
export type WithdrawalStatus = "queued" | "pending_approval" | "sending" | "sent" | "failed" | "rejected";
export interface WithdrawalRecord {
  id: string;
  asset: QuoteAssetSymbol;
  amount: number;
  destination: string;
  status: WithdrawalStatus;
  signature?: string;
  ts: number;
  reason?: string;
}

// ---------------- trading ----------------
export const OffchainCommitBidSchema = z.object({
  launchId: Base58Schema,
  commitment: HexSchema(32), // same keccak preimage as onchain mode (commitment.ts), bidder = signed-in wallet
  deposit: z.number().positive(), // locked from available quote balance
  /** Optional sealed auto-reveal envelope (relayer.ts) so the backend reveals at window open. */
  sealedReveal: z.unknown().optional(),
});
export const OffchainRevealSchema = z.object({
  launchId: Base58Schema,
  maxPrice: z.string().regex(/^\d+$/),
  bidAmount: z.string().regex(/^\d+$/),
  salt: HexSchema(32),
});
export const OffchainSwapSchema = z.object({
  launchId: Base58Schema,
  side: z.enum(["buy", "sell"]),
  amountIn: z.number().positive(), // quote for buy, tokens for sell
  minAmountOut: z.number().nonnegative(),
});
export interface OffchainSwapResponse { tradeId: string; amountIn: number; amountOut: number; fee: number; price: number; isSniper: boolean }

/** Anti-snipe offchain: buys executed within this many seconds of graduation are flagged (≈ same-slot rule). */
export const ANTI_SNIPE_WINDOW_SEC = 2;

/** Withdrawal safety rails (USD-equivalent, demo prices from quoteAssets.ts). */
export const WITHDRAWAL_LIMITS = { autoApproveMaxUsd: 2_500, dailyPerWalletUsd: 25_000 } as const;

/** Custody REST routes (all except /api/custody/info require `Authorization: Bearer <token>`). */
export const CUSTODY_ROUTES = {
  info: "/api/custody/info", // GET → { companyWallet, network, mode, payoutsEnabled, proofOfReserves }
  nonce: "/api/auth/nonce", // POST AuthNonceRequest → AuthNonceResponse
  verify: "/api/auth/verify", // POST AuthVerifyRequest → AuthVerifyResponse
  me: "/api/account", // GET → AccountResponse
  depositInstructions: (asset: QuoteAssetSymbol) => `/api/account/deposit/${asset}`, // GET → DepositInstructions
  deposits: "/api/account/deposits", // GET → { deposits: DepositRecord[] }; POST DepositClaim → DepositRecord
  withdrawals: "/api/account/withdrawals", // GET → { withdrawals }; POST WithdrawRequest → WithdrawalRecord
  commitBid: "/api/trade/commit", // POST OffchainCommitBid → { bidId, bidCount }
  reveal: "/api/trade/reveal", // POST OffchainReveal → { revealed: true }
  swap: "/api/trade/swap", // POST OffchainSwap → OffchainSwapResponse
  claim: (launchId: string) => `/api/trade/claim/${launchId}`, // POST → { tokens, refund } (after clearing)
  stake: "/api/trade/stake", // POST { launchId, amount } (negative = unstake)
  claimRewards: (launchId: string) => `/api/trade/rewards/${launchId}`, // POST → { amount }
  adminWithdrawals: "/api/admin/withdrawals", // GET/POST approve|reject — requires ADMIN_TOKEN header
} as const;

export interface CustodyInfoResponse {
  companyWallet: string;
  network: "mainnet" | "devnet" | "localnet";
  mode: ExecutionMode;
  payoutsEnabled: boolean; // false until COMPANY_WALLET_SECRET_KEY is configured
  proofOfReserves: { asset: QuoteAssetSymbol; onchain: number; liabilities: number; ratio: number; asOfTs: number }[];
}
