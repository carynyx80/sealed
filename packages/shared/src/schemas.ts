import { z } from "zod";
import { MAX_COMMIT_DURATION_SEC, MAX_CREATOR_ALLOCATION_BPS, MIN_COMMIT_DURATION_SEC_DEVNET } from "./constants.js";

export const QuoteAssetSymbolSchema = z.enum(["SOL", "USDC", "NVDAx", "TSLAx", "TTWOx", "AAPLx", "SPYx"]);
export const LaunchStatusSchema = z.enum(["commit", "reveal", "clearing", "live", "flywheel", "failed"]);
export const CreditTierSchema = z.enum(["standard", "plus", "premier"]);
export const Base58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "invalid base58 pubkey");
export const HexSchema = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`));

/** Launch Studio form → POST /api/launches (demo) or used to build the create_launch tx (devnet/mainnet). */
export const CreateLaunchInputSchema = z.object({
  name: z.string().min(2).max(32),
  ticker: z.string().min(2).max(10).regex(/^[A-Z0-9]+$/, "uppercase letters/digits"),
  description: z.string().max(280).default(""),
  imageUri: z.string().url().or(z.literal("")).default(""),
  metadataUri: z.string().url().or(z.literal("")).default(""),
  quoteAsset: QuoteAssetSymbolSchema,
  creditTier: CreditTierSchema.default("standard"),
  totalSupply: z.number().int().positive().default(1_000_000_000), // whole tokens
  creatorAllocationBps: z.number().int().min(0).max(MAX_CREATOR_ALLOCATION_BPS),
  auctionSupplyBps: z.number().int().min(2_000).max(6_000).default(4_000),
  commitDurationSec: z.number().int().min(MIN_COMMIT_DURATION_SEC_DEVNET).max(MAX_COMMIT_DURATION_SEC).default(20 * 60),
  revealDurationSec: z.number().int().min(60).max(600).default(120),
  floorPrice: z.number().positive(), // quote per whole token (UI units)
  tickSize: z.number().positive(),
  targetRaise: z.number().positive(),
  clearingCap: z.number().positive(),
  creator: Base58Schema.optional(),
});
export type CreateLaunchInput = z.infer<typeof CreateLaunchInputSchema>;

export const ListLaunchesQuerySchema = z.object({
  status: z.union([LaunchStatusSchema, z.enum(["auctions", "vaults", "graduated"])]).optional(),
  quote: z.union([QuoteAssetSymbolSchema, z.enum(["stocks", "all"])]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListLaunchesQuery = z.infer<typeof ListLaunchesQuerySchema>;

/** Sealed auto-reveal payload posted to the relayer (see relayer.ts for the crypto). */
export const SealedRevealEnvelopeSchema = z.object({
  version: z.literal(1),
  launchId: Base58Schema,
  bidder: Base58Schema,
  commitment: HexSchema(32),
  relayerPubkey: z.string(), // base64 x25519 key the payload was sealed to
  ephemeralPubkey: z.string(), // base64
  nonce: z.string(), // base64, 24 bytes
  ciphertext: z.string(), // base64 nacl.box of JSON RevealPlaintext
  /** base64 ed25519 signature by `bidder` over utf8(`sealed-reveal:v1:${launchId}:${commitment}`) */
  signature: z.string(),
});
export type SealedRevealEnvelope = z.infer<typeof SealedRevealEnvelopeSchema>;

export const RevealPlaintextSchema = z.object({
  maxPrice: z.string().regex(/^\d+$/), // u64 decimal string, quote atoms per whole token
  bidAmount: z.string().regex(/^\d+$/), // u64 decimal string, quote atoms
  salt: HexSchema(32),
});
export type RevealPlaintext = z.infer<typeof RevealPlaintextSchema>;

/** Demo-mode bid (no wallet) → POST /api/auctions/:id/demo-bid — server stores hidden, increments counters. */
export const DemoBidInputSchema = z.object({
  wallet: Base58Schema.optional(),
  commitment: HexSchema(32),
  deposit: z.number().positive(),
});
export type DemoBidInput = z.infer<typeof DemoBidInputSchema>;
