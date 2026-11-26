/**
 * The boundary between Sealed custody and the Helius Solana Privacy Rings SDK (`@heliuslabs/spr@0.9.0-alpha`).
 * `HeliusSprPort` (heliusSpr.ts) implements it with the real SDK; tests inject a mock (no network).
 * Nothing here ever carries secret key material: the port owns the company shielded keypair internally.
 */

/** A fully signed transaction, persisted BEFORE broadcast (payout idempotency, same as the public path). */
export interface SignedPrivateTx {
  signature: string;
  /** base64 wire transaction (version 1). */
  rawTx: string;
  blockhash: string;
  /** From the transaction's own lifetime constraint: after this height (+ margin) it can never land. */
  lastValidBlockHeight: number;
}

/**
 * One inbound private output owned by the company shielded identity (history row of the company Wallet).
 * `index` is the indexer's leaf index for received outputs, so `${signature}:${index}` is unique on the ring.
 */
export interface InboundNote {
  signature: string;
  slot: bigint;
  index: bigint;
  kind: "privateTransfer" | "deposit";
  /** Mint address; SOL is `11111111111111111111111111111111` (SDK `SOL_MINT`). */
  mint: string;
  amount: bigint;
  /** UTF-8 memo carried in the note's encrypted data (deposits can attach one; transfers through the SDK builders cannot). */
  memo: string | null;
}

export type RecipientCheck =
  | { ok: true; kind: "owner" | "shieldedAddress"; normalized: string }
  | { ok: false; reason: string };

export interface ProbeResult {
  ok: boolean;
  reason?: string;
}

export interface SprPort {
  /** Derives the company identity from the company wallet seed and connects the client. Throws on failure. */
  init(): Promise<void>;
  /** Company Solana owner (must equal COMPANY_WALLET) and base58 `ShieldedAddress.toBytes()`. */
  companyIdentity(): { owner: string; shieldedAddressBytes: string };
  /** Network/ring liveness: program + tree accounts, indexer read, prover TEE attestation. Never throws. */
  probe(): Promise<ProbeResult>;
  /** "registered" | "unregistered" | "mismatch" (record holds other keys — never overwritten). */
  registration(): Promise<"registered" | "unregistered" | "mismatch">;
  /** Signed registration tx paid by the company wallet, or null when already registered with these keys. */
  buildRegistration(): Promise<SignedPrivateTx | null>;
  /** Pull new encrypted state for the company wallet (decrypts locally with the company viewing key). */
  sync(): Promise<void>;
  /** Drop local wallet state (reservations, cursors) and resync from scratch on the next `sync()`. */
  reset(): void;
  /** Inbound history rows (after the last sync). */
  inbound(): InboundNote[];
  /** Spendable company shielded balance for a mint (atoms); 0 when the mint is unknown to the wallet. */
  balance(mint: string): bigint;
  /** Validate a payout recipient (registered owner address, or full shielded address bytes). */
  checkRecipient(recipient: string): Promise<RecipientCheck>;
  /** Build + sign a confidential transfer from the company shielded balance. Company wallet pays the fee. */
  buildPrivatePayout(input: { recipient: string; mint: string; amount: bigint }): Promise<SignedPrivateTx>;
}

export const SPR_SOL_MINT = "11111111111111111111111111111111";
/** Prefix stored in WithdrawalRec.destination for private payouts (never a valid public key → public path cannot pay it). */
export const PRIVATE_DEST_PREFIX = "spr:";
export const isPrivateDestination = (d: string) => d.startsWith(PRIVATE_DEST_PREFIX);
export const privateRecipientOf = (d: string) => (isPrivateDestination(d) ? d.slice(PRIVATE_DEST_PREFIX.length) : null);
/** DepositRec.key prefix for ring deposits: `spr:${signature}:${leafIndex}`. */
export const PRIVATE_DEPOSIT_KEY_PREFIX = "spr:";

/** Error text without URLs / keys. */
export function shortErr(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  const msg = (e as Error)?.message ?? String(e);
  return (typeof code === "string" && code !== msg ? `${code}: ` : "") + msg.replace(/https?:\/\/\S+/g, "<url>").replace(/api-key=[^&\s"']+/gi, "api-key=***").slice(0, 160);
}
