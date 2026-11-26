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
/** SPL Memo text a hardware-wallet (Ledger) sign-in transaction must carry: `sealed-login:<nonce>`. */
export const AUTH_LOGIN_MEMO_PREFIX = "sealed-login:";

export const AuthNonceRequestSchema = z.object({ wallet: Base58Schema });

/**
 * Wallet Standard `solana:signIn` input that reproduces `message` field-for-field
 * (createSignInMessageText(signInInput) === message). Pass it unchanged to `wallet.signIn(signInInput)`.
 */
export interface AuthSignInInput {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: "1";
  nonce: string;
  issuedAt: string; // ISO-8601
  expirationTime: string; // ISO-8601
}
export interface AuthNonceResponse { nonce: string; message: string; expiresTs: number; signInInput: AuthSignInInput }

const ByteArraySchema = (max: number) => z.array(z.number().int().min(0).max(255)).min(1).max(max);
/** base58 / base64 / base64url / hex string, or a plain byte array (Array.from(Uint8Array)). */
const SignatureInputSchema = z.union([z.string().min(64).max(200), ByteArraySchema(64)]);

/**
 * Exactly one proof:
 *  (a) `signature` over the exact `message` (signMessage)                                  — base58 or base64 accepted
 *  (b) `signedMessage` (base64 bytes the wallet signed) + `signature` (+ `address`)       — Wallet Standard signIn output
 *  (c) `signedTransaction` (base64 serialized legacy/v0 tx; fee payer = wallet; only ComputeBudget + one SPL Memo
 *      `sealed-login:<nonce>`). Never broadcast by the server.                             — Ledger / hardware fallback
 */
export const AuthVerifyRequestSchema = z
  .object({
    wallet: Base58Schema,
    nonce: z.string().min(16).max(128),
    signature: SignatureInputSchema.optional(),
    signedMessage: z.union([z.string().min(1).max(3000), ByteArraySchema(2048)]).optional(),
    signatureType: z.literal("ed25519").optional(),
    address: Base58Schema.optional(),
    signedTransaction: z.string().min(1).max(3000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.signedTransaction !== undefined) {
      if (v.signedMessage !== undefined) ctx.addIssue({ code: "custom", path: ["signedTransaction"], message: "send either signedTransaction or signedMessage, not both" });
    } else if (v.signature === undefined) {
      ctx.addIssue({ code: "custom", path: ["signature"], message: "signature (or signedTransaction) is required" });
    }
  });
export type AuthVerifyRequest = z.infer<typeof AuthVerifyRequestSchema>;
export interface AuthVerifyResponse { token: string; wallet: string; expiresTs: number }

/** Stable machine-readable auth error codes (`{error, code}` on every /api/auth/* failure). */
export type AuthErrorCode =
  | "malformed" // request/proof could not be decoded
  | "invalid_signature" // signature does not verify for this wallet
  | "expired" // nonce / signed message expired (or issuedAt outside allowed clock skew)
  | "domain_mismatch" // signed message is for a different site / uri / chain
  | "nonce_used" // unknown, already-used or replayed nonce
  | "nonce_mismatch" // signed message / memo carries a different nonce
  | "wallet_mismatch" // nonce issued for another wallet, or a different account signed
  | "invalid_transaction" // hardware-wallet tx is not a pure Sealed login memo tx
  | "rate_limited"
  | "unauthorized"
  | "auth_unavailable";
export interface AuthErrorResponse { error: string; code: AuthErrorCode; details?: unknown }

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
  /** Set for private payouts (confidential transfer to this Shielded Address); `destination` then equals it. Additive. */
  privateTo?: string;
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

/**
 * Withdrawal safety rails (USD-equivalent). Devnet values with demo prices (quoteAssets.ts); mainnet uses a live
 * price (Jupiter Price API, 60s cache, ≤5 min staleness) and routes to pending_approval when no fresh price exists.
 */
export const WITHDRAWAL_LIMITS = { autoApproveMaxUsd: 2_500, dailyPerWalletUsd: 25_000 } as const;

/** Custody REST routes (all except /api/custody/info require `Authorization: Bearer <token>`). */
export const CUSTODY_ROUTES = {
  info: "/api/custody/info", // GET → { companyWallet, network, mode, payoutsEnabled, payoutsReason, feePayer, proofOfReserves }
  rpc: "/api/rpc", // POST JSON-RPC proxy to the API's Solana RPC (method allowlist, rate-limited; no key exposed)
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
  payoutsEnabled: boolean; // false until COMPANY_WALLET_SECRET_KEY is configured AND the company wallet can pay fees
  /** Why payouts are paused (null when enabled), e.g. "company wallet needs SOL for fees". Additive. */
  payoutsReason?: string | null;
  /** Fee payer (company wallet) SOL health; present when an RPC is configured. Additive. */
  feePayer?: FeePayerHealth;
  proofOfReserves: { asset: QuoteAssetSymbol; onchain: number; liabilities: number; ratio: number; asOfTs: number }[];
}

/**
 * Company wallet fee-payer health. The wallet pays network fees (+ rent for recipients' token accounts) from SOL
 * that is NOT owed to users: surplusSol = onchain SOL − SOL liabilities. Payouts pause when surplusSol < requiredSol.
 */
export interface FeePayerHealth {
  ok: boolean;
  solBalance: number;
  solLiabilities: number;
  surplusSol: number;
  /** Minimum surplus kept for one payout: fee buffer + token-account rent + rent-exempt reserve. */
  requiredSol: number;
  asOfTs: number;
}

// ---------------- browser RPC proxy (POST /api/rpc) ----------------
/** JSON-RPC methods the API proxies to its Solana RPC for the web app. Anything else → 403 (-32601). */
export const RPC_PROXY_METHODS = [
  "getLatestBlockhash", "getBalance", "getAccountInfo", "getMultipleAccounts", "getTokenAccountsByOwner",
  "getTokenAccountBalance", "getSignatureStatuses", "getTransaction", "sendTransaction", "simulateTransaction",
  "getMinimumBalanceForRentExemption", "getFeeForMessage", "getSlot", "getBlockHeight", "getEpochInfo",
  "getRecentPrioritizationFees", "getHealth", "getVersion", "getGenesisHash",
] as const;
export type RpcProxyMethod = (typeof RPC_PROXY_METHODS)[number];
/** Proxy limits: max JSON-RPC batch size, max body bytes, per-IP requests/min (all methods / sendTransaction). */
export const RPC_PROXY_LIMITS = { maxBatch: 10, maxBodyBytes: 64 * 1024, perIpPerMin: 120, sendTxPerIpPerMin: 20 } as const;

// ---------------- Helius Solana Privacy Rings (custodial private deposits / payouts; additive) ----------------
/**
 * Off-chain message the Helius SPR SDK derives a wallet's shielded keypair from (`ED25519_DERIVATION_MSG` in
 * `@heliuslabs/spr/keypair`). A wallet must sign the FULL Solana off-chain message v0 bytes produced by
 * `ed25519DerivationMessage(walletPublicKey)` from `@heliuslabs/spr/keypair` — signing only this string is rejected.
 * The resulting signature is secret key material (pass it to `LocalKeys.fromDerivationSeed`).
 */
export const SPR_DERIVE_MESSAGE = "TSPP/derive/v1";

/** Assets accepted for private deposits / payouts through the Default Ring. */
export type PrivacyAsset = "SOL" | "USDC";

/** Privacy REST routes. Everything except `status` requires `Authorization: Bearer <token>`; `adminRegister` needs `x-admin-token`. */
export const PRIVACY_ROUTES = {
  status: "/api/privacy/status", // GET → PrivacyStatusResponse (+ enabled, companyShieldedAddress, companyRegistered)
  rpc: "/api/privacy/rpc", // POST {method, params} → Helius SPR indexer proxy
  /** Keyed passthrough to https://{network}.helius-rpc.com/v1/spr/* — use as the SDK's indexerUrl AND proverUrl. */
  spr: "/api/privacy/spr",
  depositInfo: "/api/privacy/deposit-info", // GET → PrivateDepositInfo
  claimDeposit: "/api/privacy/deposits/claim", // POST {signature} → PrivateDepositClaimResponse
  deposits: "/api/privacy/deposits", // GET → { deposits: PrivateDepositRecord[] }
  withdrawals: "/api/account/withdrawals", // POST WithdrawRequest + privateTo → WithdrawalRecord (private payout)
  adminRegister: "/api/admin/privacy/register", // POST → registers the company shielded address (admin, costs SOL)
} as const;

/** Returned (HTTP 503) by every privacy route while the feature is off or unavailable. */
export interface PrivacyDisabledResponse {
  enabled: false;
  reason: string;
}

export interface PrivateDepositInfo {
  enabled: boolean;
  reason?: string;
  /**
   * Where users send confidential transfers: the company's registered Solana owner address. Pass it as `recipient`
   * to `buildTransferTransaction` (the SDK resolves its Shielded Address through the User Registry).
   */
  companyShieldedAddress: string;
  /** base58 of `ShieldedAddress.toBytes()` (signing ‖ nullifier ‖ viewing keys), for senders that skip the registry. */
  companyShieldedAddressBytes?: string;
  /**
   * Stable per-user reference (same as AccountResponse.depositRef). Attribution: the transfer must be SENT FROM the
   * signed-in wallet (its Solana signer is visible in the Default Ring), or carry this reference as the note memo.
   */
  reference: string;
  assets: PrivacyAsset[];
  network: "mainnet" | "devnet" | "localnet";
  minAmount: Record<PrivacyAsset, number>;
}

export const PrivateDepositClaimSchema = z.object({ signature: z.string().min(64).max(100) });
export interface PrivateDepositClaimResponse {
  status: "detected" | "credited" | "pending" | "rejected";
  reason?: string;
}
export interface PrivateDepositRecord {
  id: string;
  signature: string;
  asset: QuoteAssetSymbol;
  amount: number;
  status: DepositStatus;
  ts: number;
  reason?: string;
}

/** POST /api/account/withdrawals with `privateTo` → confidential transfer instead of a public payout. */
export const PrivateWithdrawRequestSchema = WithdrawRequestSchema.extend({
  /**
   * Recipient Shielded Address: a REGISTERED Solana owner address (base58, 32 bytes), or base58 of
   * `ShieldedAddress.toBytes()` (99 bytes).
   */
  privateTo: z.string().min(32).max(160).regex(/^[1-9A-HJ-NP-Za-km-z]+$/).optional(),
});
