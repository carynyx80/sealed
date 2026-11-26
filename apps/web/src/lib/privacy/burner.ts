// Owned by privacy-web-agent. The private Sealed wallet ("burner"): pure crypto helpers, no SDK, no React.
//
// Why: every wallet we tried refuses to signMessage the Helius SDK's binary off-chain derivation envelope, so the
// user's main wallet cannot own a Privacy Ring identity directly. Instead the main wallet signs ONE plain UTF-8
// text message; we HKDF its (deterministic) Ed25519 signature into a 32-byte seed and use that seed as a separate
// Ed25519 wallet that owns the ring identity and signs every ring transaction locally. Same wallet, same message,
// same signature, same burner: nothing is stored anywhere.
//
// Safety rules enforced here:
//  - the text never looks like a SIWS message or a transaction (starts with "Sealed private wallet");
//  - the signature is verified locally against the main wallet's public key before it is used;
//  - the signature and seed buffers are zeroed by the caller right after use (deriveBurnerSeed zeroes its copy).
import nacl from "tweetnacl";
import bs58 from "bs58";

export const BURNER_MESSAGE_VERSION = 1;
export const BURNER_HKDF_SALT = "sealed-burner-v1";
export const LINK_MESSAGE_PREFIX = "sealed-privacy-link:v1";

/** The exact text the main wallet signs. Constant and versioned: changing it changes every user's burner. */
export function burnerMessage(mainWallet: string): string {
  return (
    "Sealed private wallet\n\n" +
    "Sign this message to open your private Sealed wallet for Helius Privacy Rings on www.sealedsol.xyz.\n\n" +
    "It does not move funds or cost anything. Only sign it on www.sealedsol.xyz.\n\n" +
    `Wallet: ${mainWallet}\n` +
    `Version: ${BURNER_MESSAGE_VERSION}`
  );
}

/** What the BURNER signs (raw ed25519 over UTF-8) to link itself to the signed-in Sealed account. */
export function linkMessage(mainWallet: string, burner: string): string {
  return `${LINK_MESSAGE_PREFIX}:${mainWallet}:${burner}`;
}

export class BurnerError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "BurnerError";
    this.code = code;
  }
}

const utf8 = (s: string) => new TextEncoder().encode(s);

function pubkeyBytes(address: string): Uint8Array {
  let b: Uint8Array;
  try {
    b = bs58.decode(address);
  } catch {
    throw new BurnerError("That wallet address is not readable.", "bad_wallet");
  }
  if (b.length !== 32) throw new BurnerError("That wallet address is not readable.", "bad_wallet");
  return b;
}

/** Local Ed25519 check of the main wallet's signature over the burner message. */
export function verifyBurnerSignature(mainWallet: string, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  try {
    return nacl.sign.detached.verify(utf8(burnerMessage(mainWallet)), signature, pubkeyBytes(mainWallet));
  } catch {
    return false;
  }
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new BurnerError("This browser can't open a private wallet (WebCrypto is unavailable). Use a current browser over https.", "no_webcrypto");
  return s;
}

/**
 * seed = HKDF-SHA256(ikm = 64-byte signature, salt = "sealed-burner-v1", info = mainWallet, L = 32).
 * Refuses unless the signature verifies against the main wallet. The caller owns `signature` and should zero it.
 */
export async function deriveBurnerSeed(mainWallet: string, signature: Uint8Array): Promise<Uint8Array> {
  if (!verifyBurnerSignature(mainWallet, signature)) {
    throw new BurnerError(
      "Your wallet's signature didn't match this wallet address or this message, so no private wallet was opened. Try again, and make sure the same account is selected in your wallet.",
      "bad_signature",
    );
  }
  const ikm = signature.slice();
  try {
    const key = await subtle().importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    const bits = await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: utf8(BURNER_HKDF_SALT), info: utf8(mainWallet) }, key, 256);
    return new Uint8Array(bits);
  } finally {
    ikm.fill(0);
  }
}

/** base58 Ed25519 public key (the burner's Solana address) for a 32-byte seed. */
export function burnerAddressFromSeed(seed: Uint8Array): string {
  const kp = nacl.sign.keyPair.fromSeed(seed);
  try {
    return bs58.encode(kp.publicKey);
  } finally {
    kp.secretKey.fill(0);
  }
}

/**
 * Resolve the company recipient the API hands us. Accepts the 99-byte Shielded Address (base58, preferred) or the
 * registered 32-byte owner address, and fails closed unless it belongs to `companyWallet`.
 * `fromBytes` is the SDK's `ShieldedAddress.fromBytes` (passed in so this module stays SDK-free).
 */
export function resolveCompanyRecipient<S extends { solanaAddress(): string }>(
  value: string,
  companyWallet: string,
  fromBytes: (b: Uint8Array) => S,
): { kind: "owner"; owner: string } | { kind: "shielded"; address: S } {
  const raw = (value ?? "").trim();
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(raw);
  } catch {
    throw new BurnerError("Sealed returned an unreadable private deposit address. Nothing was sent.", "bad_company_address");
  }
  if (bytes.length === 32) {
    if (raw !== companyWallet) throw new BurnerError("The private deposit address does not belong to Sealed's company wallet. Nothing was sent.", "company_mismatch");
    return { kind: "owner", owner: raw };
  }
  let sa: S;
  try {
    sa = fromBytes(bytes);
  } catch {
    throw new BurnerError("Sealed returned an unreadable private deposit address. Nothing was sent.", "bad_company_address");
  }
  if (sa.solanaAddress() !== companyWallet) throw new BurnerError("The private deposit address does not belong to Sealed's company wallet. Nothing was sent.", "company_mismatch");
  return { kind: "shielded", address: sa };
}
