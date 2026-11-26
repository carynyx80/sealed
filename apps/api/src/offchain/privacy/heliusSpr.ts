import {
  LocalKeys,
  SHIELDED_POOL_PROGRAM_ID,
  ShieldedAddress,
  ShieldedKeypair,
  SigningKey,
  Wallet,
  buildRegistrationTransaction,
  buildTransferTransaction,
  createSprClient,
  initializePoseidon,
  syncWallet,
  type Address,
  type Bytes32,
} from "@heliuslabs/spr";
import { SignedTeePolicy, type SprClient } from "@heliuslabs/spr/client";
import { fetchUserRecord, validateRegisteredKeypair } from "@heliuslabs/spr/wallet";
import {
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isAddress,
  signTransactionWithSigners,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";
import bs58 from "bs58";
import { keypairFromSecret } from "../../services/solana.js";
import { shortErr, type InboundNote, type ProbeResult, type RecipientCheck, type SignedPrivateTx, type SprPort } from "./port.js";

/**
 * Real `SprPort` on `@heliuslabs/spr@0.9.0-alpha` (README "Quick start", "Registration", "Private transfer",
 * "Wallet sync and persistence"; https://www.helius.dev/docs/privacy/sdk.md).
 *
 * Company identity: `ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as Bytes32))` with the company wallet's
 * Ed25519 seed. Its viewing + nullifier roles expand from `SigningKey.derivationSeed()`, i.e. the wallet's signature
 * over `ed25519DerivationMessage(pubkey)` ("TSPP/derive/v1" off-chain message v0) — byte-identical to what
 * `LocalKeys.fromDerivationSeed` derives from a browser wallet signature (verified offline). The README requires the
 * shielded keypair and the Solana signer to share one owner seed, so the shielded owner IS the company wallet.
 *
 * Secret handling: the seed is copied into the SDK key objects and the local copy zeroed; nothing secret is logged,
 * returned, or persisted. Wallet state (UTXOs) lives in memory only and is rebuilt by a full sync after restarts.
 */
export interface HeliusSprPortOptions {
  network: "mainnet" | "devnet";
  /** Helius RPC root with api-key query (the SDK serves the indexer + prover from its `/v1/spr` namespace). */
  solanaRpcUrl: string;
  indexerUrl?: string;
  proverUrl?: string;
  companySecretKey: string;
  companyWallet: string;
  priorityFeeLamports?: bigint;
}

type WithLifetime = Transaction & { lifetimeConstraint?: { blockhash?: string; lastValidBlockHeight?: bigint | number } };

export class HeliusSprPort implements SprPort {
  private client!: SprClient;
  private keypair!: ShieldedKeypair;
  private keys!: LocalKeys;
  private signer!: TransactionPartialSigner;
  private wallet!: Wallet;

  constructor(private readonly opts: HeliusSprPortOptions) {}

  async init(): Promise<void> {
    await initializePoseidon(); // keypair derivation hashes with Poseidon (createSprClient loads it too, but later)
    const kp = keypairFromSecret(this.opts.companySecretKey);
    if (!kp) throw new Error("company wallet key could not be parsed");
    if (kp.publicKey.toBase58() !== this.opts.companyWallet) throw new Error("company wallet key does not match COMPANY_WALLET");
    const seed = kp.secretKey.slice(0, 32);
    try {
      this.keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as Bytes32));
    } finally {
      seed.fill(0);
    }
    const address = this.keypair.shieldedAddress();
    if (address.solanaAddress() !== this.opts.companyWallet) throw new Error("derived shielded owner does not match COMPANY_WALLET");
    this.client = await createSprClient({
      solanaRpcUrl: this.opts.solanaRpcUrl,
      ...(this.opts.indexerUrl ? { indexerUrl: this.opts.indexerUrl } : {}),
      ...(this.opts.proverUrl ? { proverUrl: this.opts.proverUrl } : {}),
      proverTee: SignedTeePolicy.forNetwork(this.opts.network),
      commitment: "confirmed",
      ...(this.opts.priorityFeeLamports !== undefined ? { priorityFeeLamports: this.opts.priorityFeeLamports } : {}),
    });
    this.keys = LocalKeys.fromKeypair(this.keypair, this.client.proofService);
    this.signer = this.keypair.toSolanaSigner();
    this.wallet = new Wallet({ identity: address });
  }

  companyIdentity() {
    const a = this.keypair.shieldedAddress();
    return { owner: a.solanaAddress(), shieldedAddressBytes: bs58.encode(a.toBytes()) };
  }

  async probe(): Promise<ProbeResult> {
    const step = async (name: string, fn: () => Promise<boolean>): Promise<string | null> => {
      try {
        return (await fn()) ? null : `${name} not found`;
      } catch (e) {
        return `${name} unreachable (${shortErr(e)})`;
      }
    };
    const problems = (
      await Promise.all([
        step("privacy program", async () => !!(await this.client.getAccount(SHIELDED_POOL_PROGRAM_ID))),
        step("state tree", async () => !!(await this.client.getAccount(this.client.tree))),
        step("privacy indexer", async () => {
          await this.client.getShieldedTransactionsByTags({ tags: [this.keypair.shieldedAddress().confidentialViewTag()], limit: 1 });
          return true;
        }),
        step("prover attestation", async () => {
          await this.client.attestProver();
          return true;
        }),
      ])
    ).filter((p): p is string => p !== null);
    return problems.length ? { ok: false, reason: problems.join("; ") } : { ok: true };
  }

  async registration(): Promise<"registered" | "unregistered" | "mismatch"> {
    const owner = this.opts.companyWallet as Address;
    const rec = await fetchUserRecord({ rpc: this.client, owner });
    if (!rec) return "unregistered";
    try {
      await validateRegisteredKeypair({ rpc: this.client, owner, keypair: this.keypair });
      return "registered";
    } catch {
      return "mismatch";
    }
  }

  async buildRegistration(): Promise<SignedPrivateTx | null> {
    const tx = await buildRegistrationTransaction({
      client: this.client,
      owner: this.opts.companyWallet as Address,
      address: this.keypair.shieldedAddress(),
    });
    return tx === undefined ? null : this.sign(tx);
  }

  async sync(): Promise<void> {
    await syncWallet({ client: this.client, wallet: this.wallet, keys: this.keys });
  }

  reset(): void {
    this.wallet = new Wallet({ identity: this.keypair.shieldedAddress() });
  }

  inbound(): InboundNote[] {
    const memoByLeaf = new Map<string, string | null>();
    for (const u of this.wallet.utxos()) {
      const m = u.utxo.data.memo();
      memoByLeaf.set(u.outputContext.leafIndex.toString(), m ? decodeMemo(m) : null);
    }
    const out: InboundNote[] = [];
    for (const t of this.wallet.privateTransactions()) {
      if (t.direction !== "inbound" || (t.kind !== "privateTransfer" && t.kind !== "deposit")) continue;
      out.push({
        signature: t.id.signature,
        slot: t.id.slot,
        index: t.id.index,
        kind: t.kind,
        mint: t.asset,
        amount: t.amount,
        memo: memoByLeaf.get(t.id.index.toString()) ?? null,
      });
    }
    return out;
  }

  balance(mint: string): bigint {
    try {
      return this.wallet.balance(mint as Address).amount;
    } catch {
      return 0n; // mint unknown to the wallet's asset registry → it holds none
    }
  }

  async checkRecipient(recipient: string): Promise<RecipientCheck> {
    if (isAddress(recipient)) {
      try {
        const rec = await fetchUserRecord({ rpc: this.client, owner: recipient });
        return rec ? { ok: true, kind: "owner", normalized: recipient } : { ok: false, reason: "recipient has no registered private address" };
      } catch (e) {
        throw new Error(`registry lookup failed: ${shortErr(e)}`);
      }
    }
    try {
      const a = ShieldedAddress.fromBytes(bs58.decode(recipient));
      return { ok: true, kind: "shieldedAddress", normalized: bs58.encode(a.toBytes()) };
    } catch {
      return { ok: false, reason: "privateTo must be a registered Solana address or a base58 shielded address" };
    }
  }

  async buildPrivatePayout(input: { recipient: string; mint: string; amount: bigint }): Promise<SignedPrivateTx> {
    const recipient = isAddress(input.recipient) ? input.recipient : ShieldedAddress.fromBytes(bs58.decode(input.recipient));
    const tx = await buildTransferTransaction({
      client: this.client,
      wallet: this.wallet,
      keys: this.keys,
      feePayer: this.opts.companyWallet as Address,
      recipient,
      asset: input.mint as Address,
      amount: input.amount,
    });
    return this.sign(tx);
  }

  private async sign(tx: Transaction): Promise<SignedPrivateTx> {
    const life = (tx as WithLifetime).lifetimeConstraint;
    if (!life?.blockhash || life.lastValidBlockHeight === undefined) throw new Error("built transaction carries no blockhash lifetime");
    const signed = await signTransactionWithSigners([this.signer], tx);
    return {
      signature: getSignatureFromTransaction(signed),
      rawTx: getBase64EncodedWireTransaction(signed),
      blockhash: life.blockhash,
      lastValidBlockHeight: Number(life.lastValidBlockHeight),
    };
  }
}

function decodeMemo(b: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b).trim();
  } catch {
    return null;
  }
}
