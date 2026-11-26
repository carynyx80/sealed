// Owned by privacy-web-agent. The ONLY module that imports @heliuslabs/spr and @solana/kit at runtime. It is loaded with
// `import("./spr")` from session.ts when the user opens a private feature, so the homepage never ships the SDK.
//
// Bridge (SDK is @solana/kit, the app is @solana/web3.js + wallet-adapter):
//  - identity: the wallet signs `ed25519DerivationMessage(pubkey)` (the off-chain message v0 envelope around
//    "TSPP/derive/v1") through wallet-adapter signMessage; LocalKeys.fromDerivationSeed verifies that signature and
//    derives the nullifier + viewing keys. The signature is secret key material: it is wiped right after.
//  - transactions: every SDK builder returns a kit *version 1* Transaction. web3.js 1.x cannot parse v1, so we never
//    convert it: the raw wire bytes go to the Wallet Standard `solana:signTransaction` feature (which declares
//    `supportedTransactionVersions`), and the signed bytes are decoded with kit, checked against what we built, and
//    sent with the SDK client's kit RPC.
//  - endpoints: Solana RPC is the Sealed API's keyed proxy; indexer + prover go through the API's SPR passthrough
//    (the prover payloads are HPKE-encrypted to the attested enclave, so the proxy only relays ciphertext).
import {
  LocalKeys,
  SOL_MINT,
  ShieldedAddress,
  Wallet,
  buildDepositTransaction,
  buildRegistrationTransaction,
  buildTransferTransaction,
  buildWithdrawalTransaction,
  initializePoseidon,
  syncWallet,
  type Address,
} from "@heliuslabs/spr";
import { SignedTeePolicy, SprClient } from "@heliuslabs/spr/client";
import { bytes32, ed25519DerivationMessage } from "@heliuslabs/spr/keypair";
import { getSplAssetRegistryAddress } from "@heliuslabs/spr/addresses";
import { decodeSplAssetRegistry } from "@heliuslabs/spr/interface";
import { isWalletRegistered } from "@heliuslabs/spr/wallet";
import {
  address as kitAddress,
  getBase58Decoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  type Transaction,
} from "@solana/kit";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { COMPANY_WALLET, QUOTE_ASSETS } from "@sealed/shared";
import { API_URL, NETWORK, RPC_ENDPOINT } from "../config";
import { PRIVACY_ROUTES, type PrivateAsset } from "./contract";

/** What session.ts hands us from wallet-adapter. */
export interface WalletBridge {
  /** base58 owner (the connected wallet). */
  owner: string;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  /** Raw v1 wire bytes in, signed wire bytes out (Wallet Standard solana:signTransaction). */
  signTransactionBytes: (wire: Uint8Array) => Promise<Uint8Array>;
}

export interface Identity {
  owner: string;
  keys: LocalKeys;
  wallet: Wallet;
  /** base58 of the 99-byte Shielded Address (signing ‖ nullifier ‖ viewing). */
  shieldedAddress: string;
}

export class PrivacyFlowError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "PrivacyFlowError";
  }
}

/* ------------------------------------------------------------------------------------------ client */

let clientPromise: Promise<SprClient> | null = null;

export function sprGatewayUrl(): string {
  return (process.env.NEXT_PUBLIC_SPR_PROXY_URL || `${API_URL}${PRIVACY_ROUTES.spr}`).replace(/\/$/, "");
}

/** Lazily create the SDK client (and load the Poseidon wasm once). */
export function getClient(): Promise<SprClient> {
  clientPromise ??= (async () => {
    await initializePoseidon();
    const gateway = sprGatewayUrl();
    return new SprClient({
      solanaRpcUrl: RPC_ENDPOINT,
      indexerUrl: gateway,
      proverUrl: gateway,
      // The SDK pins the release signers per network; attestation, nonce and HPKE checks stay on.
      proverTee: SignedTeePolicy.forNetwork(NETWORK === "mainnet" ? "mainnet" : "devnet"),
      commitment: "confirmed",
    });
  })().catch((e) => {
    clientPromise = null;
    throw e;
  });
  return clientPromise;
}

/* ---------------------------------------------------------------------------------------- encoding */

const b58enc = getBase58Encoder(); // string -> bytes
const b58dec = getBase58Decoder(); // bytes -> string

export function encodeShieldedAddress(a: ShieldedAddress): string {
  return b58dec.decode(a.toBytes());
}

/**
 * The company recipient from the API. Accepts the 99-byte Shielded Address (base58) or the registered owner
 * address. Fails closed unless it belongs to Sealed's published company wallet.
 */
export function companyRecipient(value: string): Address | ShieldedAddress {
  const raw = value.trim();
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(b58enc.encode(raw) as ArrayLike<number>);
  } catch {
    throw new PrivacyFlowError("Sealed returned an unreadable shielded address. Nothing was sent.", "bad_company_address");
  }
  if (bytes.length === 32) {
    if (raw !== COMPANY_WALLET) throw new PrivacyFlowError("The private deposit address does not belong to Sealed's company wallet. Nothing was sent.", "company_mismatch");
    return kitAddress(raw);
  }
  let sa: ShieldedAddress;
  try {
    sa = ShieldedAddress.fromBytes(bytes);
  } catch {
    throw new PrivacyFlowError("Sealed returned an unreadable shielded address. Nothing was sent.", "bad_company_address");
  }
  if (sa.solanaAddress() !== COMPANY_WALLET) throw new PrivacyFlowError("The private deposit address does not belong to Sealed's company wallet. Nothing was sent.", "company_mismatch");
  return sa;
}

/* ---------------------------------------------------------------------------------------- identity */

/** Derive the user's shielded identity from one wallet signature, exactly as Helius documents. */
export async function deriveIdentity(bridge: WalletBridge): Promise<Identity> {
  const client = await getClient();
  const ownerBytes = new PublicKey(bridge.owner).toBytes();
  const message = ed25519DerivationMessage(bytes32(ownerBytes));
  let seed: Uint8Array;
  try {
    seed = await bridge.signMessage(message);
  } catch (e) {
    throw e; // user rejection etc: surfaced by the caller
  }
  try {
    const keys = LocalKeys.fromDerivationSeed({ solanaPublicKey: kitAddress(bridge.owner), derivationSeed: seed }, client.proofService);
    const shielded = keys.address();
    const wallet = new Wallet({ identity: shielded });
    return { owner: bridge.owner, keys, wallet, shieldedAddress: encodeShieldedAddress(shielded) };
  } catch {
    throw new PrivacyFlowError(
      "Your wallet signed the key message in a format the Privacy Ring can't use. Try another wallet (it must sign raw off-chain messages).",
      "bad_derivation_signature",
    );
  } finally {
    seed.fill(0);
  }
}

export async function isRegistered(owner: string): Promise<boolean> {
  const client = await getClient();
  return isWalletRegistered({ rpc: client, owner: kitAddress(owner) });
}

/* ------------------------------------------------------------------------------------------ assets */

function mintOf(asset: PrivateAsset): Address {
  if (asset === "SOL") return SOL_MINT;
  const m = QUOTE_ASSETS.USDC.mints[NETWORK === "mainnet" ? "mainnet" : NETWORK];
  if (!m) throw new PrivacyFlowError("USDC is not available on this network", "no_mint");
  return kitAddress(m);
}
export const decimalsOf = (asset: PrivateAsset) => QUOTE_ASSETS[asset].decimals;

export function toAtoms(ui: number, asset: PrivateAsset): bigint {
  const d = decimalsOf(asset);
  const [w, f = ""] = ui.toFixed(d).split(".");
  return BigInt(w! + f.padEnd(d, "0").slice(0, d));
}
export function fromAtoms(atoms: bigint, asset: PrivateAsset): number {
  const d = decimalsOf(asset);
  const s = atoms.toString().padStart(d + 1, "0");
  return Number(`${s.slice(0, -d)}.${s.slice(-d)}`);
}

/**
 * Register the USDC asset id in the local wallet before syncing (one getAccountInfo of its registry PDA), so sync
 * never needs getProgramAccounts (not allowed through the Sealed RPC proxy).
 */
async function ensureKnownAssets(client: SprClient, wallet: Wallet) {
  try {
    const mint = mintOf("USDC");
    const acct = await client.getAccount(await getSplAssetRegistryAddress(mint));
    if (!acct) return;
    const reg = decodeSplAssetRegistry(acct.data);
    wallet.ensureAsset(reg.assetId, reg.mint);
  } catch {
    /* USDC has no ring interface on this network: SOL still works */
  }
}

export interface Balances {
  SOL: bigint;
  USDC: bigint | null;
}

/** Sync the in-memory wallet against the indexer and decrypt balances locally with the viewing key. */
export async function syncBalances(id: Identity, requireSlot?: bigint): Promise<Balances> {
  const client = await getClient();
  await ensureKnownAssets(client, id.wallet);
  await syncWallet({ client, wallet: id.wallet, keys: id.keys, config: requireSlot !== undefined ? { requireSlot } : undefined });
  const read = (asset: PrivateAsset): bigint | null => {
    try {
      return id.wallet.balance(mintOf(asset)).amount;
    } catch {
      return null;
    }
  };
  return { SOL: read("SOL") ?? 0n, USDC: read("USDC") };
}

/* ------------------------------------------------------------------------------------ sign + send */

const txEncoder = getTransactionEncoder();
const txDecoder = getTransactionDecoder();

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Wallet signs the exact v1 bytes we built; we refuse a modified message, then send and confirm. */
async function signAndSend(tx: Transaction, bridge: WalletBridge): Promise<{ signature: string; slot: bigint }> {
  const client = await getClient();
  const wire = Uint8Array.from(txEncoder.encode(tx) as ArrayLike<number>);
  const signedWire = await bridge.signTransactionBytes(wire);
  const signed = txDecoder.decode(signedWire) as Transaction;
  if (!sameBytes(signed.messageBytes as unknown as ArrayLike<number>, tx.messageBytes as unknown as ArrayLike<number>)) {
    throw new PrivacyFlowError("Your wallet changed the transaction before signing. Nothing was sent.", "modified_tx");
  }
  const ownerSig = signed.signatures[kitAddress(bridge.owner)];
  if (!ownerSig) throw new PrivacyFlowError("Your wallet returned the transaction without its signature. Nothing was sent.", "unsigned");
  const signature = getSignatureFromTransaction(signed as Parameters<typeof getSignatureFromTransaction>[0]);
  await client.solanaRpc
    .sendTransaction(getBase64EncodedWireTransaction(signed as Parameters<typeof getBase64EncodedWireTransaction>[0]), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3n })
    .send();
  const slot = await client.confirmTransaction(signature);
  return { signature, slot };
}

/* ----------------------------------------------------------------------------------------- flows */

export async function register(id: Identity, bridge: WalletBridge): Promise<string | null> {
  const client = await getClient();
  const tx = await buildRegistrationTransaction({ client, owner: kitAddress(id.owner), address: id.keys.address() });
  if (!tx) return null; // already registered with these keys
  return (await signAndSend(tx, bridge)).signature;
}

/** Public wallet balance into the user's private balance. The amount of this step is public on-chain. */
export async function shield(id: Identity, bridge: WalletBridge, asset: PrivateAsset, ui: number) {
  const client = await getClient();
  const owner = kitAddress(id.owner);
  const amount = toAtoms(ui, asset);
  const tx =
    asset === "SOL"
      ? await buildDepositTransaction({ client, feePayer: owner, depositor: owner, recipient: id.keys.address(), amount })
      : await buildDepositTransaction({
          client,
          feePayer: owner,
          depositor: owner,
          recipient: id.keys.address(),
          asset: mintOf(asset),
          splTokenAccount: kitAddress(getAssociatedTokenAddressSync(new PublicKey(mintOf(asset)), new PublicKey(id.owner)).toBase58()),
          amount,
        });
  const r = await signAndSend(tx, bridge);
  return { ...r, balances: await syncBalances(id, r.slot) };
}

/** Private balance back to the user's own public wallet. The amount of this step is public on-chain. */
export async function unshield(id: Identity, bridge: WalletBridge, asset: PrivateAsset, ui: number) {
  const client = await getClient();
  const owner = kitAddress(id.owner);
  const tx = await buildWithdrawalTransaction({
    client,
    wallet: id.wallet,
    keys: id.keys,
    feePayer: owner,
    recipient: owner,
    ...(asset === "SOL" ? {} : { asset: mintOf(asset) }),
    amount: toAtoms(ui, asset),
  });
  const r = await signAndSend(tx, bridge);
  return { ...r, balances: await syncBalances(id, r.slot) };
}

/** Confidential transfer from the user's private balance to Sealed custody. The amount is hidden on-chain. */
export async function sendPrivateToCompany(id: Identity, bridge: WalletBridge, companyShieldedAddress: string, asset: PrivateAsset, ui: number) {
  const recipient = companyRecipient(companyShieldedAddress);
  const client = await getClient();
  const tx = await buildTransferTransaction({
    client,
    wallet: id.wallet,
    keys: id.keys,
    feePayer: kitAddress(id.owner),
    recipient,
    ...(asset === "SOL" ? {} : { asset: mintOf(asset) }),
    amount: toAtoms(ui, asset),
  });
  const r = await signAndSend(tx, bridge);
  return { ...r, balances: await syncBalances(id, r.slot) };
}

/** SDK error codes to plain sentences (no secrets, no amounts). */
export function describeSprError(e: unknown): string | null {
  const code = (e as { code?: string; causeCode?: string })?.code;
  const cause = (e as { causeCodes?: readonly string[] })?.causeCodes ?? [];
  const all = [code, ...cause].filter(Boolean).join(" ");
  if (/INSUFFICIENT_BALANCE/.test(all)) return "Not enough in your private balance for that amount.";
  if (/RECIPIENT_NOT_REGISTERED/.test(all)) return "Sealed's shielded address isn't registered yet. Private deposits will open once it is.";
  if (/TOO_MANY_INPUTS/.test(all)) return "Your private balance is split across too many notes for one transfer. Send a smaller amount first.";
  if (/USER_RECORD_KEYS_MISMATCH|REGISTERED_KEYPAIR_MISMATCH/.test(all)) return "This wallet is registered with different Privacy Ring keys.";
  if (/MISSING_SPL_TOKEN_ACCOUNT/.test(all)) return "Your wallet has no USDC token account.";
  if (/CLIENT_PROVER|PROVER|TEE|ATTEST/.test(all)) return "The Helius prover could not be reached or attested. Nothing was sent; try again shortly.";
  if (/INDEXER|WALLET_SYNC/.test(all)) return "The Privacy Ring indexer is not answering right now. Try again shortly.";
  return null;
}
