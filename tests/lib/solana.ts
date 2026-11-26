/**
 * Dependency-free Solana helpers for tests/scripts (node:crypto ed25519 + base58 + a minimal legacy tx builder).
 * Keeps tests/ free of @solana/web3.js / tweetnacl. Never logs key material.
 */
import { createPrivateKey, createPublicKey, randomBytes, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------- base58
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = MAP.get(c);
    if (v === undefined) throw new Error("invalid base58");
    n = n * 58n + v;
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- ed25519 keypairs (Solana 64-byte secret = seed ‖ pubkey)
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface TestKeypair {
  publicKey: Uint8Array; // 32
  /** Solana-format secret key (seed ‖ pubkey), compatible with nacl.sign.detached. */
  secretKey: Uint8Array; // 64
  address: string; // base58 pubkey
  sign(message: Uint8Array): Uint8Array; // 64-byte detached signature
}

export function keypairFromSeed(seed: Uint8Array): TestKeypair {
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  const priv: KeyObject = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  const publicKey = Uint8Array.from(spki.subarray(spki.length - 32));
  const secretKey = new Uint8Array(64);
  secretKey.set(seed, 0);
  secretKey.set(publicKey, 32);
  return {
    publicKey,
    secretKey,
    address: b58encode(publicKey),
    sign: (message) => Uint8Array.from(edSign(null, Buffer.from(message), priv)),
  };
}

/** Fresh throwaway identity (never holds real funds). */
export const generateKeypair = (): TestKeypair => keypairFromSeed(randomBytes(32));

/** Solana CLI keypair file (JSON array of 64 bytes). Verifies the embedded pubkey matches the seed. */
export function loadKeypairFile(path: string): TestKeypair {
  let arr: unknown;
  try {
    arr = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read keypair file (${(e as Error).message.split("\n")[0]})`);
  }
  if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) {
    throw new Error("keypair file must be a JSON array of 64 bytes (solana-keygen format)");
  }
  const sk = Uint8Array.from(arr as number[]);
  const kp = keypairFromSeed(sk.subarray(0, 32));
  if (Buffer.compare(Buffer.from(kp.publicKey), Buffer.from(sk.subarray(32))) !== 0) throw new Error("keypair file is corrupt (pubkey does not match seed)");
  return kp;
}

export function verifySignature(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey)]);
  return edVerify(null, Buffer.from(message), createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(signature));
}

// ---------------------------------------------------------------- minimal legacy transaction: SOL transfer + SPL memo
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

function shortvec(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return out;
    }
    b |= 0x80;
    out.push(b);
  }
}
function u64le(v: bigint): number[] {
  const out: number[] = [];
  for (let i = 0; i < 8; i++) out.push(Number((v >> BigInt(8 * i)) & 0xffn));
  return out;
}

/**
 * Build + sign a legacy tx: SystemProgram.transfer(from → to, lamports) followed by an SPL Memo (v2) instruction.
 * Returns the base64 wire transaction and its signature (base58) — the tx id.
 */
export function buildTransferWithMemo(p: { from: TestKeypair; to: string; lamports: bigint; memo: string; recentBlockhash: string }): { base64: string; signature: string } {
  if (p.to === p.from.address) throw new Error("destination must differ from the payer");
  const keys = [p.from.publicKey, b58decode(p.to), b58decode(SYSTEM_PROGRAM), b58decode(MEMO_PROGRAM)];
  for (const k of keys) if (k.length !== 32) throw new Error("invalid public key length");
  const bh = b58decode(p.recentBlockhash);
  if (bh.length !== 32) throw new Error("invalid blockhash");
  const transferData = [2, 0, 0, 0, ...u64le(p.lamports)];
  const memoData = [...Buffer.from(p.memo, "utf8")];
  const msg = Uint8Array.from([
    1, 0, 2, // header: 1 signer (payer, writable), 0 readonly signed, 2 readonly unsigned (system, memo)
    ...shortvec(keys.length), ...keys.flatMap((k) => [...k]),
    ...bh,
    ...shortvec(2),
    2, ...shortvec(2), 0, 1, ...shortvec(transferData.length), ...transferData,
    3, ...shortvec(0), ...shortvec(memoData.length), ...memoData,
  ]);
  const sig = p.from.sign(msg);
  const wire = Uint8Array.from([...shortvec(1), ...sig, ...msg]);
  return { base64: Buffer.from(wire).toString("base64"), signature: b58encode(sig) };
}

/** Plain JSON-RPC call (the URL may contain an API key: callers must never print it). */
export async function rpcCall<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result as T;
}
