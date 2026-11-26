import type { Network, QuoteAssetSymbol } from "@sealed/shared";

/**
 * Helius Solana Privacy Rings ("SPR") — adapter surface used by the sealed-auction launchpad.
 *
 * Everything named here as a Helius API was checked against the official docs on 2026-11-26:
 *   - Overview / concepts ........ https://www.helius.dev/docs/privacy
 *   - SDK (TS `@heliuslabs/spr`) .. https://www.helius.dev/docs/privacy/sdk.md
 *   - Indexer JSON-RPC methods .... https://www.helius.dev/docs/api-reference/privacy/llms.txt
 *   - Endpoints ................... https://www.helius.dev/docs/privacy/endpoints.md
 *   - Program addresses ........... https://www.helius.dev/docs/privacy/addresses.md
 * Anything we could not verify is behind an interface below and marked TODO with its doc URL.
 */

export const SPR_DOCS = {
  overview: "https://www.helius.dev/docs/privacy",
  sdk: "https://www.helius.dev/docs/privacy/sdk.md",
  rpc: "https://www.helius.dev/docs/api-reference/privacy/llms.txt",
  endpoints: "https://www.helius.dev/docs/privacy/endpoints.md",
  addresses: "https://www.helius.dev/docs/privacy/addresses.md",
  deposit: "https://www.helius.dev/docs/privacy/guides/deposit.md",
  transfer: "https://www.helius.dev/docs/privacy/guides/transfer.md",
  withdraw: "https://www.helius.dev/docs/privacy/guides/withdraw.md",
  readBalance: "https://www.helius.dev/docs/privacy/guides/read-balance.md",
  wallet: "https://www.helius.dev/docs/privacy/integration/wallet.md",
  encryption: "https://www.helius.dev/docs/privacy/concepts/encryption.md",
  customRings: "https://www.helius.dev/docs/privacy/integration/enterprise.md",
} as const;

/** Official TypeScript SDK (npm publisher: Helius Labs maintainers). Not installed — see docs/PRIVACY.md. */
export const SPR_SDK_PACKAGE = "@heliuslabs/spr" as const;
export const SPR_SDK_VERSION = "0.9.0-alpha" as const;

/** Program ids — identical on mainnet and devnet (addresses.md). */
export const SPR_ADDRESSES = {
  privacyProgram: "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW",
  userRegistryProgram: "regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ",
  stateMerkleTree: "777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor",
  /** Mainnet token-interface PDAs (escrow that holds deposited tokens per mint). */
  interfaces: {
    SOL: "CiNmas621VuyofiDSrEPfTXHKrdZuB6jMKECyNiMpLXE",
    USDC: "H4RD4XSWp8TLmrNYCLmV74a5ixude5s9gGqpCFjXkBLQ",
  } as Partial<Record<QuoteAssetSymbol, string>>,
} as const;

/** Indexer JSON-RPC methods documented by Helius. The API proxy only forwards these. */
export const SPR_RPC_METHODS = [
  "getEncryptedUtxosByTags",
  "getShieldedTransactionsByTags",
  "getShieldedTransactionsBySignature",
  "getShieldedTransactionsByNullifiers",
  "getMerkleProofs",
  "getNonInclusionProofs",
  "getNullifierQueueElements",
  "getUserRecords",
] as const;
export type SprRpcMethod = (typeof SPR_RPC_METHODS)[number];
export const isSprRpcMethod = (m: unknown): m is SprRpcMethod => typeof m === "string" && (SPR_RPC_METHODS as readonly string[]).includes(m);

/** Networks with a Helius-hosted SPR endpoint (endpoints.md lists mainnet beta + devnet beta). */
export const SPR_NETWORKS: readonly Network[] = ["mainnet", "devnet"];

/** Helius indexer URL for a method: `https://{network}.helius-rpc.com/v1/spr/{method}?api-key=KEY` (server-side only). */
export function sprIndexerUrl(network: Network, method: SprRpcMethod, apiKey: string): string {
  if (network === "localnet") return `http://127.0.0.1:8784/${method}`;
  return `https://${network}.helius-rpc.com/v1/spr/${method}?api-key=${encodeURIComponent(apiKey)}`;
}

/** Quote assets the Default Ring can carry today without creating a token interface first. */
export const SPR_READY_ASSETS: readonly QuoteAssetSymbol[] = ["SOL", "USDC"];

/* ------------------------------------------------------------------------------------------ adapter */

export type ProofMode = "remote" | "local" | "simulated";

export interface PrivacyCapabilities {
  network: Network;
  simulated: boolean;
  /** Public → private balance (SDK `depositInstruction`). Amount is PUBLIC at deposit time. */
  shield: boolean;
  /** Private → private (SDK `ConfidentialTransfer#send` + `proveTransact` + `transactInstruction`). Hides amount + asset. */
  confidentialTransfer: boolean;
  /** Private → public (SDK `ConfidentialTransfer#withdraw`). Amount is PUBLIC at withdrawal. */
  unshield: boolean;
  /** Local viewing-key decryption (SDK `decryptToBalances`). */
  decrypt: boolean;
  /** Fund the sealed-launchpad escrow PDA without revealing the deposit size. */
  fundProgramEscrow: boolean;
  fundProgramEscrowReason?: string;
  proofMode: ProofMode;
}

export interface RingStatus {
  available: boolean;
  network: Network;
  simulated: boolean;
  ringId?: string;
  reason?: string;
}

/** What anyone can see: ciphertexts exist, never the amount. */
export interface EncryptedBalance {
  owner: string;
  symbol: QuoteAssetSymbol;
  /** Number of encrypted outputs (UTXOs / shielded events) found for the owner's view tag. */
  outputs: number;
  /** Opaque ciphertext preview (base64) — for display as redacted glyphs only. */
  ciphertext: string | null;
  asOfSlot?: number;
}

export interface PrivacyTxResult {
  signature: string;
  simulated: boolean;
  /** What an observer of the chain learns from this transaction. */
  publicFields: Array<"sender" | "recipient" | "asset" | "amount">;
}

export interface ShieldArgs { owner: string; symbol: QuoteAssetSymbol; atoms: bigint }
export interface TransferArgs { owner: string; recipient: string; symbol: QuoteAssetSymbol; atoms: bigint }
export interface UnshieldArgs { owner: string; recipient: string; symbol: QuoteAssetSymbol; atoms: bigint }
export interface FundEscrowArgs { owner: string; launchId: string; escrow?: string; symbol: QuoteAssetSymbol; atoms: bigint; commitmentHex: string }

/**
 * Viewing key material. For the real ring this is the X25519 viewing key derived from the wallet's
 * signature over "TSPP/derive/v1" (wallet.md); for the simulated ring any byte string.
 */
export type ViewingKey = Uint8Array;

export interface PrivacyRingClient {
  readonly kind: "helius" | "simulated";
  readonly network: Network;
  capabilities(): PrivacyCapabilities;
  status(): Promise<RingStatus>;
  /** Is this wallet registered in the SPR user registry (can receive private transfers)? */
  isRegistered(owner: string): Promise<boolean>;
  encryptedBalance(owner: string, symbol: QuoteAssetSymbol): Promise<EncryptedBalance>;
  decryptBalance(owner: string, symbol: QuoteAssetSymbol, viewingKey: ViewingKey): Promise<bigint>;
  shield(a: ShieldArgs): Promise<PrivacyTxResult>;
  confidentialTransfer(a: TransferArgs): Promise<PrivacyTxResult>;
  unshield(a: UnshieldArgs): Promise<PrivacyTxResult>;
  /** Fund a sealed-bid escrow from the private balance. Throws EscrowFundingUnsupportedError when impossible. */
  fundEscrow(a: FundEscrowArgs): Promise<PrivacyTxResult>;
}

/* ------------------------------------------------------------------------------------------- errors */

export class PrivacyRingError extends Error {
  constructor(message: string, public readonly docUrl?: string) {
    super(message);
    this.name = "PrivacyRingError";
  }
}

export class EscrowFundingUnsupportedError extends PrivacyRingError {
  constructor(reason = ESCROW_UNSUPPORTED_REASON) {
    super(reason, "https://www.helius.dev/docs/privacy/guides/transfer.md");
    this.name = "EscrowFundingUnsupportedError";
  }
}

export class PrivacySdkUnavailableError extends PrivacyRingError {
  constructor(what: string, docUrl: string = SPR_DOCS.sdk) {
    super(`${what} needs the Helius SPR SDK (${SPR_SDK_PACKAGE}) wired in via HeliusPrivacyRingOptions.sdk — not enabled in this build.`, docUrl);
    this.name = "PrivacySdkUnavailableError";
  }
}

export class InsufficientShieldedBalanceError extends PrivacyRingError {
  constructor(public readonly have: bigint, public readonly need: bigint) {
    super(`Shielded balance too low: have ${have}, need ${need} (atoms)`);
    this.name = "InsufficientShieldedBalanceError";
  }
}

export const ESCROW_UNSUPPORTED_REASON =
  "The sealed-launchpad escrow is a public SPL token account and commit_bid records the deposit in plaintext. " +
  "Helius Privacy Ring transfers only reach Shielded Addresses and ring withdrawals publish their amount, so a private " +
  "deposit needs the commit_bid_shielded program upgrade described in docs/PRIVACY.md.";
