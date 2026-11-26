import nacl from "tweetnacl";
import bs58 from "bs58";
import type { Network, QuoteAssetSymbol } from "@sealed/shared";
import {
  InsufficientShieldedBalanceError,
  PrivacyRingError,
  type EncryptedBalance,
  type FundEscrowArgs,
  type PrivacyCapabilities,
  type PrivacyRingClient,
  type PrivacyTxResult,
  type RingStatus,
  type ShieldArgs,
  type TransferArgs,
  type UnshieldArgs,
  type ViewingKey,
} from "./types.js";

/**
 * Simulated Privacy Ring for demo mode, localnet and tests. NEVER touches real funds or the chain.
 * Balances are kept as nacl.secretbox ciphertexts keyed by a per-owner viewing key, so the UI exercises the real
 * shape of the flow: an observer sees ciphertext; only the viewing key yields the amount.
 * It also models the *target* escrow design (docs/PRIVACY.md, phase 2): escrow funding and refunds move between
 * shielded balances, so only sender/recipient are public.
 */

export interface SimulatedRingStorage {
  load(): string | null;
  save(json: string): void;
}

export const memoryRingStorage = (): SimulatedRingStorage => {
  let v: string | null = null;
  return { load: () => v, save: (s) => void (v = s) };
};

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Deterministic demo viewing key for an owner (simulation only — a real key comes from the wallet). */
export function simulatedViewingKey(owner: string): ViewingKey {
  return nacl.hash(enc.encode(`sealed-sim-viewing-key:v1:${owner}`)).slice(0, 32);
}

function boxKey(vk: ViewingKey, owner: string, symbol: string): Uint8Array {
  const m = new Uint8Array(vk.length + 64);
  m.set(vk);
  m.set(enc.encode(`${owner}:${symbol}`.slice(0, 64)), vk.length);
  return nacl.hash(m).slice(0, nacl.secretbox.keyLength);
}

const b64 = (u: Uint8Array) => {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function seal(atoms: bigint, vk: ViewingKey, owner: string, symbol: string): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(enc.encode(atoms.toString()), nonce, boxKey(vk, owner, symbol));
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce);
  out.set(box, nonce.length);
  return b64(out);
}

function open(ct: string, vk: ViewingKey, owner: string, symbol: string): bigint | null {
  const raw = unb64(ct);
  const nonce = raw.slice(0, nacl.secretbox.nonceLength);
  const pt = nacl.secretbox.open(raw.slice(nacl.secretbox.nonceLength), nonce, boxKey(vk, owner, symbol));
  return pt ? BigInt(dec.decode(pt)) : null;
}

export const simulatedSignature = (): string => `simring${bs58.encode(nacl.randomBytes(40))}`;

interface Entry { ct: string; outputs: number }
interface EscrowEntry { owner: string; symbol: QuoteAssetSymbol; atoms: string; commitmentHex: string; ts: number }
interface State { v: 1; balances: Record<string, Record<string, Entry>>; escrows: Record<string, EscrowEntry[]> }

export interface SimulatedPrivacyRingOptions {
  network?: Network;
  storage?: SimulatedRingStorage;
  viewingKeyFor?: (owner: string) => ViewingKey;
  /** Artificial proving delay (ms) so the UI can show a "proving" step. Default 0. */
  latencyMs?: number;
}

export class SimulatedPrivacyRingClient implements PrivacyRingClient {
  readonly kind = "simulated" as const;
  readonly network: Network;
  private readonly storage: SimulatedRingStorage;
  private readonly vkFor: (owner: string) => ViewingKey;
  private readonly latency: number;
  private state: State;

  constructor(opts: SimulatedPrivacyRingOptions = {}) {
    this.network = opts.network ?? "devnet";
    this.storage = opts.storage ?? memoryRingStorage();
    this.vkFor = opts.viewingKeyFor ?? simulatedViewingKey;
    this.latency = opts.latencyMs ?? 0;
    this.state = this.read();
  }

  private read(): State {
    try {
      const raw = this.storage.load();
      const j = raw ? (JSON.parse(raw) as State) : null;
      if (j && j.v === 1 && j.balances && j.escrows) return j;
    } catch {
      /* corrupt → reset */
    }
    return { v: 1, balances: {}, escrows: {} };
  }

  private write() {
    try {
      this.storage.save(JSON.stringify(this.state));
    } catch {
      /* storage unavailable: keep in memory */
    }
  }

  private wait() {
    return this.latency > 0 ? new Promise<void>((r) => setTimeout(r, this.latency)) : Promise.resolve();
  }

  private atoms(owner: string, symbol: QuoteAssetSymbol): bigint {
    const e = this.state.balances[owner]?.[symbol];
    if (!e) return 0n;
    const v = open(e.ct, this.vkFor(owner), owner, symbol);
    if (v === null) throw new PrivacyRingError("simulated ring: ciphertext does not open with the owner's viewing key");
    return v;
  }

  private set(owner: string, symbol: QuoteAssetSymbol, atoms: bigint) {
    const prev = this.state.balances[owner]?.[symbol];
    (this.state.balances[owner] ??= {})[symbol] = { ct: seal(atoms, this.vkFor(owner), owner, symbol), outputs: (prev?.outputs ?? 0) + 1 };
  }

  private debit(owner: string, symbol: QuoteAssetSymbol, atoms: bigint) {
    if (atoms <= 0n) throw new PrivacyRingError("amount must be greater than 0");
    const have = this.atoms(owner, symbol);
    if (have < atoms) throw new InsufficientShieldedBalanceError(have, atoms);
    this.set(owner, symbol, have - atoms);
  }

  capabilities(): PrivacyCapabilities {
    return {
      network: this.network, simulated: true, shield: true, confidentialTransfer: true, unshield: true, decrypt: true,
      fundProgramEscrow: true, proofMode: "simulated",
    };
  }

  async status(): Promise<RingStatus> {
    return { available: true, network: this.network, simulated: true, ringId: "simulated-default-ring" };
  }

  async isRegistered(owner: string): Promise<boolean> {
    return !!this.state.balances[owner];
  }

  async encryptedBalance(owner: string, symbol: QuoteAssetSymbol): Promise<EncryptedBalance> {
    const e = this.state.balances[owner]?.[symbol];
    return { owner, symbol, outputs: e?.outputs ?? 0, ciphertext: e?.ct ?? null };
  }

  async decryptBalance(owner: string, symbol: QuoteAssetSymbol, viewingKey: ViewingKey): Promise<bigint> {
    await this.wait();
    const e = this.state.balances[owner]?.[symbol];
    if (!e) return 0n;
    const v = open(e.ct, viewingKey, owner, symbol);
    if (v === null) throw new PrivacyRingError("Wrong viewing key: the ciphertext does not decrypt");
    return v;
  }

  async shield(a: ShieldArgs): Promise<PrivacyTxResult> {
    if (a.atoms <= 0n) throw new PrivacyRingError("amount must be greater than 0");
    await this.wait();
    this.set(a.owner, a.symbol, this.atoms(a.owner, a.symbol) + a.atoms);
    this.write();
    return { signature: simulatedSignature(), simulated: true, publicFields: ["sender", "recipient", "asset", "amount"] };
  }

  async confidentialTransfer(a: TransferArgs): Promise<PrivacyTxResult> {
    await this.wait();
    this.debit(a.owner, a.symbol, a.atoms);
    this.set(a.recipient, a.symbol, this.atoms(a.recipient, a.symbol) + a.atoms);
    this.write();
    return { signature: simulatedSignature(), simulated: true, publicFields: ["sender", "recipient"] };
  }

  async unshield(a: UnshieldArgs): Promise<PrivacyTxResult> {
    await this.wait();
    this.debit(a.owner, a.symbol, a.atoms);
    this.write();
    return { signature: simulatedSignature(), simulated: true, publicFields: ["sender", "recipient", "asset", "amount"] };
  }

  async fundEscrow(a: FundEscrowArgs): Promise<PrivacyTxResult> {
    await this.wait();
    this.debit(a.owner, a.symbol, a.atoms);
    (this.state.escrows[a.launchId] ??= []).push({ owner: a.owner, symbol: a.symbol, atoms: a.atoms.toString(), commitmentHex: a.commitmentHex, ts: Math.floor(Date.now() / 1000) });
    this.write();
    return { signature: simulatedSignature(), simulated: true, publicFields: ["sender", "recipient"] };
  }

  /** Simulation of a confidential refund / holder payout from the escrow back into the bidder's shielded balance. */
  async payout(launchId: string, owner: string, symbol: QuoteAssetSymbol, atoms: bigint): Promise<PrivacyTxResult> {
    await this.wait();
    if (atoms <= 0n) throw new PrivacyRingError("amount must be greater than 0");
    this.set(owner, symbol, this.atoms(owner, symbol) + atoms);
    this.write();
    void launchId;
    return { signature: simulatedSignature(), simulated: true, publicFields: ["sender", "recipient"] };
  }

  /** Number of privately funded escrow deposits for a launch (simulation bookkeeping). */
  privateDeposits(launchId: string): number {
    return this.state.escrows[launchId]?.length ?? 0;
  }

  /** Whether a specific commitment was privately funded. */
  isPrivatelyFunded(launchId: string, commitmentHex: string): boolean {
    return !!this.state.escrows[launchId]?.some((e) => e.commitmentHex === commitmentHex);
  }
}
