import type { FastifyBaseLogger } from "fastify";
import type { Network, WsEvent } from "@sealed/shared";
import type { Cache } from "../../cache/index.js";
import type { EventBus } from "../../events.js";
import type { Ledger } from "../ledger.js";
import type { OffchainRepo } from "../repo/types.js";

export interface EngineDeps {
  repo: OffchainRepo;
  ledger: Ledger;
  bus: EventBus;
  cache: Cache;
  network: Network;
  /** x25519 secret used to open sealed auto-reveal envelopes (same key as the on-chain relayer). */
  relayerBox: { publicKey: Uint8Array; secretKey: Uint8Array };
  relayerBoxPubB64: string;
  /** Max fee-credit advanced to a single launch (quote atoms). */
  maxCreditPerLaunch: bigint;
  /** Minimum commit duration (seconds) — 15 min on mainnet, 2 min elsewhere. */
  minCommitSec: number;
  /** Injectable clock (ms) for deterministic tests. */
  nowMs: () => number;
  log?: FastifyBaseLogger;
}

export const nowS = (d: EngineDeps) => Math.floor(d.nowMs() / 1000);

/** Error with an HTTP status, rendered by the Fastify error handler / routes. */
export class EngineError extends Error {
  constructor(readonly statusCode: number, message: string, readonly details?: unknown) {
    super(message);
    this.name = "EngineError";
  }
}

export const REWARD_SCALE = 1_000_000_000_000n; // matches Rust REWARD_SCALE (1e12)
export const U64_MAX = 0xffff_ffff_ffff_ffffn;

export function publish(d: EngineDeps, evts: WsEvent[]) {
  for (const e of evts) d.bus.publish(e);
}

export async function invalidate(d: EngineDeps) {
  await d.cache.bump("launches").catch(() => undefined);
  await d.cache.del("stats").catch(() => undefined);
}

export const bi = (s: unknown): bigint => (typeof s === "bigint" ? s : BigInt(String(s ?? "0")));
