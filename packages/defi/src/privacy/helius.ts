import type { Network, QuoteAssetSymbol } from "@sealed/shared";
import {
  ESCROW_UNSUPPORTED_REASON,
  EscrowFundingUnsupportedError,
  PrivacyRingError,
  PrivacySdkUnavailableError,
  SPR_ADDRESSES,
  SPR_DOCS,
  SPR_NETWORKS,
  isSprRpcMethod,
  sprIndexerUrl,
  type EncryptedBalance,
  type FundEscrowArgs,
  type PrivacyCapabilities,
  type PrivacyRingClient,
  type PrivacyTxResult,
  type RingStatus,
  type ShieldArgs,
  type SprRpcMethod,
  type TransferArgs,
  type UnshieldArgs,
  type ViewingKey,
} from "./types.js";

/* -------------------------------------------------------------------------------------- transport */

/** JSON-RPC 2.0 call to a Helius SPR indexer method; resolves with `result`. */
export type SprTransport = (method: SprRpcMethod, params: Record<string, unknown>) => Promise<unknown>;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface JsonRpcEnvelope { result?: unknown; error?: { code?: number; message?: string } }

function unwrap(method: string, body: unknown, status: number): unknown {
  const env = (body ?? {}) as JsonRpcEnvelope & { error?: unknown };
  if (env.error) {
    const msg = typeof env.error === "string" ? env.error : (env.error as { message?: string }).message ?? "unknown error";
    throw new PrivacyRingError(`${method}: ${msg}`, SPR_DOCS.rpc);
  }
  if (!("result" in env)) throw new PrivacyRingError(`${method}: malformed response (HTTP ${status})`, SPR_DOCS.rpc);
  return env.result;
}

/**
 * Server-side transport: talks to `https://{network}.helius-rpc.com/v1/spr/{method}?api-key=…` directly.
 * Never use this in a browser bundle (it needs the API key) — use `proxyTransport` there.
 */
export function directTransport(opts: { network: Network; apiKey: string; fetch?: FetchLike; timeoutMs?: number }): SprTransport {
  const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  return async (method, params) => {
    if (!isSprRpcMethod(method)) throw new PrivacyRingError(`unsupported SPR method ${String(method)}`, SPR_DOCS.rpc);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
    try {
      const res = await f(sprIndexerUrl(opts.network, method, opts.apiKey), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "sealed", method, params }),
        signal: ctrl.signal,
      });
      const body = await res.json().catch(() => null);
      return unwrap(method, body, res.status);
    } finally {
      clearTimeout(t);
    }
  };
}

/** Browser transport: POST `${apiBase}/api/privacy/rpc` → the API attaches HELIUS_API_KEY server-side. */
export function proxyTransport(apiBase: string, fetchImpl?: FetchLike): SprTransport {
  const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const base = apiBase.replace(/\/$/, "");
  return async (method, params) => {
    const res = await f(`${base}/api/privacy/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ method, params }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok && !(body && typeof body === "object" && "error" in body)) throw new PrivacyRingError(`${method}: HTTP ${res.status}`);
    return unwrap(method, body, res.status);
  };
}

/* ------------------------------------------------------------------------------------ SDK bindings */

/**
 * Seam for the operations that need the official TS SDK (`@heliuslabs/spr`, verified names in comments) and a
 * ShieldedKeypair. We do not ship the SDK yet: a browser wallet must derive the shielded keypair from a signature
 * over the off-chain message "TSPP/derive/v1" (wallet.md), and the SDK's wallet-adapter entry point for that is not
 * documented. TODO(helius-spr): implement with the SDK once wallet derivation is documented — see SPR_DOCS.wallet.
 */
export interface HeliusSprBindings {
  proofMode: "remote" | "local";
  /** `depositInstruction({ tree, depositor, deposits: [{ asset: DepositAsset.sol()|spl(…), viewTag, recipientOwnerHash, amount }] })` */
  shield(a: ShieldArgs): Promise<string>;
  /** `new ConfidentialTransfer(addr, inputs, payer).send(recipientShieldedAddress, mint, amount)` → `client.proveTransact` → `transactInstruction` */
  confidentialTransfer(a: TransferArgs): Promise<string>;
  /** `ConfidentialTransfer#withdraw(mint, amount, WithdrawalTarget.sol|spl(…))` + `TransactWithdrawal` */
  unshield(a: UnshieldArgs): Promise<string>;
  /** `decryptToBalances({ keypair, registry, transactions }).balance(mint).amount` */
  decryptBalance(owner: string, symbol: QuoteAssetSymbol, viewingKey: ViewingKey): Promise<bigint>;
}

export interface HeliusPrivacyRingOptions {
  network: Network;
  transport: SprTransport;
  sdk?: HeliusSprBindings;
}

interface ShieldedEvent { outputSlots?: Array<{ viewTag?: string; payload?: string }>; messages?: Array<{ viewTag?: string; payload?: string }> }
interface ByTagsResult { context?: { slot?: number }; data?: Array<{ slot?: number; signature?: string; events?: ShieldedEvent[] }> }
interface UserRecordsResult { records?: Array<unknown | null> }

/* ----------------------------------------------------------------------------------------- client */

export class HeliusPrivacyRingClient implements PrivacyRingClient {
  readonly kind = "helius" as const;
  readonly network: Network;
  private readonly transport: SprTransport;
  private readonly sdk?: HeliusSprBindings;

  constructor(opts: HeliusPrivacyRingOptions) {
    this.network = opts.network;
    this.transport = opts.transport;
    this.sdk = opts.sdk;
  }

  capabilities(): PrivacyCapabilities {
    const net = SPR_NETWORKS.includes(this.network);
    const sdk = net && !!this.sdk;
    return {
      network: this.network,
      simulated: false,
      shield: sdk,
      confidentialTransfer: sdk,
      unshield: sdk,
      decrypt: sdk,
      fundProgramEscrow: false,
      fundProgramEscrowReason: ESCROW_UNSUPPORTED_REASON,
      proofMode: this.sdk?.proofMode ?? "remote",
    };
  }

  async status(): Promise<RingStatus> {
    if (!SPR_NETWORKS.includes(this.network)) {
      return { available: false, network: this.network, simulated: false, reason: `Helius Privacy Rings are not hosted on ${this.network}` };
    }
    try {
      // Cheapest documented read: a registry lookup for one key proves the endpoint + key work.
      await this.transport("getUserRecords", { owners: [SPR_ADDRESSES.privacyProgram] });
      return { available: true, network: this.network, simulated: false, ringId: SPR_ADDRESSES.privacyProgram };
    } catch (e) {
      return { available: false, network: this.network, simulated: false, ringId: SPR_ADDRESSES.privacyProgram, reason: (e as Error).message };
    }
  }

  /** getUserRecords — https://www.helius.dev/docs/api-reference/privacy/getuserrecords.md */
  async isRegistered(owner: string): Promise<boolean> {
    const r = (await this.transport("getUserRecords", { owners: [owner] })) as UserRecordsResult;
    return !!r?.records?.[0];
  }

  /**
   * getShieldedTransactionsByTags — in the Default (confidential) Ring the view tag is the owner's Solana pubkey
   * (read-balance.md). The asset is encrypted too, so `outputs` counts outputs across ALL assets; per-asset
   * amounts only come out of local viewing-key decryption.
   */
  async encryptedBalance(owner: string, symbol: QuoteAssetSymbol): Promise<EncryptedBalance> {
    const r = (await this.transport("getShieldedTransactionsByTags", { tags: [owner], limit: 1000 })) as ByTagsResult;
    let outputs = 0;
    let ciphertext: string | null = null;
    for (const tx of r?.data ?? []) {
      for (const ev of tx.events ?? []) {
        for (const o of ev.outputSlots ?? []) {
          if (o.viewTag !== owner) continue;
          outputs++;
          ciphertext ??= o.payload ?? null;
        }
      }
    }
    return { owner, symbol, outputs, ciphertext, asOfSlot: r?.context?.slot };
  }

  async decryptBalance(owner: string, symbol: QuoteAssetSymbol, viewingKey: ViewingKey): Promise<bigint> {
    if (!this.sdk) throw new PrivacySdkUnavailableError("Viewing-key decryption", SPR_DOCS.readBalance);
    return this.sdk.decryptBalance(owner, symbol, viewingKey);
  }

  async shield(a: ShieldArgs): Promise<PrivacyTxResult> {
    if (!this.sdk) throw new PrivacySdkUnavailableError("Shielding (deposit into the ring)", SPR_DOCS.deposit);
    return { signature: await this.sdk.shield(a), simulated: false, publicFields: ["sender", "recipient", "asset", "amount"] };
  }

  async confidentialTransfer(a: TransferArgs): Promise<PrivacyTxResult> {
    if (!this.sdk) throw new PrivacySdkUnavailableError("Confidential transfer", SPR_DOCS.transfer);
    return { signature: await this.sdk.confidentialTransfer(a), simulated: false, publicFields: ["sender", "recipient"] };
  }

  async unshield(a: UnshieldArgs): Promise<PrivacyTxResult> {
    if (!this.sdk) throw new PrivacySdkUnavailableError("Unshielding (withdraw from the ring)", SPR_DOCS.withdraw);
    return { signature: await this.sdk.unshield(a), simulated: false, publicFields: ["sender", "recipient", "asset", "amount"] };
  }

  /**
   * The current program escrow (SEED_ESCROW SPL account) cannot receive a confidential transfer, and a ring
   * withdrawal into it publishes the amount — which defeats the purpose. Fail closed until the contracts change.
   */
  async fundEscrow(_a: FundEscrowArgs): Promise<PrivacyTxResult> {
    throw new EscrowFundingUnsupportedError();
  }
}
