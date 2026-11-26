import nacl from "tweetnacl";
import type { RevealPlaintext, SealedRevealEnvelope } from "./schemas.js";

/**
 * Auto-reveal sealing: the browser seals the reveal preimage to the relayer's x25519 key using
 * nacl.box with a fresh ephemeral keypair. Only the relayer can open it, and only the bidder's
 * wallet signature authorises it. The relayer submits `reveal_bid` as soon as the reveal window opens.
 */

const b64 = {
  enc: (u: Uint8Array) => (typeof Buffer !== "undefined" ? Buffer.from(u).toString("base64") : btoa(String.fromCharCode(...u))),
  dec: (s: string) => (typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0))),
};
export const base64 = b64;

export function revealSignMessage(launchId: string, commitmentHex: string): Uint8Array {
  return new TextEncoder().encode(`sealed-reveal:v1:${launchId}:${commitmentHex.toLowerCase()}`);
}

export function sealReveal(args: {
  launchId: string;
  bidder: string;
  commitmentHex: string;
  relayerPubkeyB64: string;
  plaintext: RevealPlaintext;
  /** ed25519 signature (from wallet.signMessage) over revealSignMessage(launchId, commitmentHex). */
  signature: Uint8Array;
}): SealedRevealEnvelope {
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const msg = new TextEncoder().encode(JSON.stringify(args.plaintext));
  const ct = nacl.box(msg, nonce, b64.dec(args.relayerPubkeyB64), eph.secretKey);
  return {
    version: 1,
    launchId: args.launchId,
    bidder: args.bidder,
    commitment: args.commitmentHex.toLowerCase(),
    relayerPubkey: args.relayerPubkeyB64,
    ephemeralPubkey: b64.enc(eph.publicKey),
    nonce: b64.enc(nonce),
    ciphertext: b64.enc(ct),
    signature: b64.enc(args.signature),
  };
}

/** Relayer side. Returns null if decryption fails. Caller must also verify signature + commitment hash. */
export function openReveal(env: SealedRevealEnvelope, relayerSecretKey: Uint8Array): RevealPlaintext | null {
  const pt = nacl.box.open(b64.dec(env.ciphertext), b64.dec(env.nonce), b64.dec(env.ephemeralPubkey), relayerSecretKey);
  if (!pt) return null;
  try {
    return JSON.parse(new TextDecoder().decode(pt)) as RevealPlaintext;
  } catch {
    return null;
  }
}

export function verifyRevealSignature(env: SealedRevealEnvelope, bidderPubkeyBytes: Uint8Array): boolean {
  return nacl.sign.detached.verify(revealSignMessage(env.launchId, env.commitment), b64.dec(env.signature), bidderPubkeyBytes);
}

export function relayerKeypairFromSeed(seed32: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return nacl.box.keyPair.fromSecretKey(seed32);
}
