import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { fromHex, relayerKeypairFromSeed, base64 } from "@sealed/shared";
import nacl from "tweetnacl";
import type { AppConfig } from "../config.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Parse a secret key given as base58 (64 bytes) or a JSON byte array (solana-keygen format). */
export function keypairFromSecret(secret: string | undefined): Keypair | null {
  if (!secret) return null;
  const s = secret.trim();
  try {
    if (s.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s) as number[]));
    const bytes = bs58.decode(s);
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
    return Keypair.fromSecretKey(bytes);
  } catch {
    return null;
  }
}

let connection: Connection | null = null;
export function getConnection(cfg: AppConfig): Connection | null {
  if (!cfg.rpcUrl) return null;
  if (!connection) connection = new Connection(cfg.rpcUrl, { commitment: "confirmed", wsEndpoint: cfg.wsUrl });
  return connection;
}

/** RPC url safe to show publicly (API keys stripped). */
export function redactRpc(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/key|token|secret/i.test(k)) u.searchParams.set(k, "***");
    return u.toString();
  } catch {
    return "configured";
  }
}

export interface RelayerKeys {
  /** x25519 box keypair reveal payloads are sealed to. */
  box: { publicKey: Uint8Array; secretKey: Uint8Array };
  boxPubkeyB64: string;
  /** ed25519 fee payer that submits reveal_bid. */
  payer: Keypair;
  ephemeral: boolean;
}

/** Relayer identity from env; in demo / unconfigured mode generates an ephemeral one (logged as a warning by caller). */
export function loadRelayerKeys(cfg: AppConfig): RelayerKeys {
  const box = cfg.relayerBoxSeed ? relayerKeypairFromSeed(fromHex(cfg.relayerBoxSeed)) : nacl.box.keyPair();
  const payer = keypairFromSecret(cfg.relayerSecretKey) ?? Keypair.generate();
  return { box, boxPubkeyB64: base64.enc(box.publicKey), payer, ephemeral: !cfg.relayerBoxSeed || !cfg.relayerSecretKey };
}

/** Locate and parse the Anchor IDL (runtime-only; returns null if missing so workers degrade gracefully). */
export function loadIdl(cfg: AppConfig): Record<string, unknown> | null {
  const rel = ["programs/sealed-launchpad/idl/sealed_launchpad.json", "programs/sealed-launchpad/target/idl/sealed_launchpad.json"];
  const candidates = [
    cfg.idlPath,
    ...rel.map((r) => resolve(here, "../../../../", r)), // apps/api/{src,dist}/services → ROOT
    ...rel.map((r) => resolve(process.cwd(), r)),
    ...rel.map((r) => resolve(process.cwd(), "../..", r)),
    resolve(process.cwd(), "idl/sealed_launchpad.json"),
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const idl = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
        idl.address = cfg.programId;
        return idl;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Anchor module loaded lazily (CJS interop + keeps demo boot light). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnchorModule = any;
let anchorMod: AnchorModule | null = null;
export async function loadAnchor(): Promise<AnchorModule> {
  if (!anchorMod) {
    const m = (await import("@coral-xyz/anchor")) as AnchorModule;
    anchorMod = m.Program ? m : m.default;
  }
  return anchorMod;
}

/** Build an Anchor Program client for the launchpad signed by `signer`. Null if RPC or IDL unavailable. */
export async function loadProgram(cfg: AppConfig, signer: Keypair): Promise<{ program: AnchorModule; anchor: AnchorModule } | null> {
  const conn = getConnection(cfg);
  const idl = loadIdl(cfg);
  if (!conn || !idl) return null;
  const anchor = await loadAnchor();
  const wallet = new anchor.Wallet(signer);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);
  return { program, anchor };
}

export function isPubkey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}
