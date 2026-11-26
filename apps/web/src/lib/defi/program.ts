"use client";
// Owned by defi-integrations-agent. Lazily builds the Anchor client + launch keys for a LaunchSummary.
import { PublicKey, type Connection } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";
import { QUOTE_ASSETS, type LaunchSummary } from "@sealed/shared";
import {
  SealedLaunchpadClient,
  getRegisteredIdl,
  quoteMintOrThrow,
  quoteTokenProgramId,
  quoteTokenProgramKind,
  registerIdl,
  type LaunchKeys,
} from "@sealed/defi";

const PROGRAM_ID_ENV = process.env.NEXT_PUBLIC_PROGRAM_ID || undefined;
const IDL_URL = process.env.NEXT_PUBLIC_IDL_URL || undefined;

let idlPromise: Promise<Idl | null> | null = null;

/** IDL sources: registerIdl() by the app → NEXT_PUBLIC_IDL_URL → on-chain IDL account (inside SealedLaunchpadClient). */
async function loadIdl(): Promise<Idl | null> {
  const reg = getRegisteredIdl();
  if (reg) return reg;
  if (!IDL_URL) return null;
  idlPromise ??= fetch(IDL_URL)
    .then((r) => (r.ok ? (r.json() as Promise<Idl>) : null))
    .then((idl) => {
      if (idl) registerIdl(idl);
      return idl;
    })
    .catch(() => null);
  return idlPromise;
}

const clients = new Map<string, Promise<SealedLaunchpadClient>>();

export async function getSealedClient(connection: Connection, walletPk: PublicKey | null): Promise<SealedLaunchpadClient> {
  const key = `${connection.rpcEndpoint}|${walletPk?.toBase58() ?? "-"}`;
  let p = clients.get(key);
  if (!p) {
    p = loadIdl().then((idl) =>
      SealedLaunchpadClient.create({ connection, wallet: walletPk ? { publicKey: walletPk } : null, idl, programId: PROGRAM_ID_ENV }),
    );
    p.catch(() => clients.delete(key));
    clients.set(key, p);
  }
  return p;
}

export interface ResolvedLaunchKeys extends LaunchKeys {
  launch: PublicKey;
  tokenMint: PublicKey;
  quoteMint: PublicKey;
  quoteTokenProgram: PublicKey;
  quoteDecimals: number;
}

export function launchKeys(launch: LaunchSummary): ResolvedLaunchKeys {
  return {
    launch: new PublicKey(launch.id),
    tokenMint: new PublicKey(launch.mint),
    quoteMint: quoteMintOrThrow(launch.quoteAsset, launch.network),
    quoteTokenProgram: quoteTokenProgramId(quoteTokenProgramKind(launch.quoteAsset, launch.network)),
    quoteDecimals: QUOTE_ASSETS[launch.quoteAsset].decimals,
  };
}
