// Owned by privacy-web-agent. The ONLY module that imports @heliuslabs/spr and @solana/kit at runtime. It is loaded with
// `import("./spr")` from session.ts when the user opens a private feature, so the homepage never ships the SDK.
//
// Private Sealed wallet ("burner"), mirroring the API's company identity (apps/api/.../heliusSpr.ts):
//  - the main wallet signs ONE plain UTF-8 text message (./burner.ts burnerMessage); we verify that signature
//    locally, HKDF it into a 32-byte Ed25519 seed, and build the ring identity exactly as the SDK README documents
//    for an Ed25519 owner: `ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed))`, `LocalKeys.fromKeypair`,
//    `new Wallet({ identity })`, and `keypair.toSolanaSigner()` as the one Solana signer (same seed).
//  - the burner is owner + fee payer + signer of every ring transaction (registration, deposit, private transfer,
//    withdrawal). They are version 1 transactions signed here with kit's signTransactionWithSigners and sent through
//    the SDK client's RPC (Sealed's /api/rpc proxy). The main wallet never signs a version 1 transaction.
//  - funding and sweeping are ordinary LEGACY web3.js transfers: main wallet → burner (signed by the main wallet in
//    its own UI), burner → main wallet (signed here with the burner key).
//  - endpoints: Solana RPC is the Sealed API's keyed proxy; indexer + prover go through the API's SPR passthrough
//    (the prover payloads are HPKE-encrypted to the attested enclave, so the proxy only relays ciphertext).
import {
  LocalKeys,
  SOL_MINT,
  ShieldedAddress,
  ShieldedKeypair,
  SigningKey,
  Wallet,
  buildDepositTransaction,
  buildRegistrationTransaction,
  buildTransferTransaction,
  buildWithdrawalTransaction,
  initializePoseidon,
  syncWallet,
  type Address,
  type Bytes32,
} from "@heliuslabs/spr";
import { SignedTeePolicy, SprClient } from "@heliuslabs/spr/client";
import { getSplAssetRegistryAddress } from "@heliuslabs/spr/addresses";
import { decodeSplAssetRegistry } from "@heliuslabs/spr/interface";
import { isWalletRegistered } from "@heliuslabs/spr/wallet";
import {
  address as kitAddress,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransactionWithSigners,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, Transaction as LegacyTransaction, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { COMPANY_WALLET, QUOTE_ASSETS } from "@sealed/shared";
import { buildTransaction } from "@sealed/defi";
import { API_URL, NETWORK, RPC_ENDPOINT } from "../config";
import { ConfirmationTimeoutError, computeBudgetIxs, confirmSignature, priorityFeeMicroLamports, simulateOrThrow } from "../solana/tx";
import { PRIVACY_ROUTES, type PrivateAsset } from "./contract";
import { BurnerError, burnerAddressFromSeed, burnerMessage, deriveBurnerSeed, linkMessage, resolveCompanyRecipient } from "./burner";

/** What session.ts hands us from wallet-adapter (the user's MAIN wallet). */
export interface MainWalletBridge {
  main: string;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  /** Wallet-adapter sendTransaction for a LEGACY transaction (funding the burner). */
  sendLegacy: (tx: LegacyTransaction, connection: Connection) => Promise<string>;
}

export interface Identity {
  /** The user's main (connected) wallet. */
  main: string;
  /** The burner's Solana address: ring owner, fee payer and signer. */
  burner: string;
  keypair: ShieldedKeypair;
  keys: LocalKeys;
  wallet: Wallet;
  signer: TransactionPartialSigner;
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

let connection: Connection | null = null;
/** web3.js connection for the legacy funding / sweep transfers (same Sealed RPC proxy). */
export function legacyConnection(): Connection {
  connection ??= new Connection(RPC_ENDPOINT, "confirmed");
  return connection;
}

/* ---------------------------------------------------------------------------------------- encoding */

const b58dec = getBase58Decoder(); // bytes -> string

export function encodeShieldedAddress(a: ShieldedAddress): string {
  return b58dec.decode(a.toBytes());
}

/** The company recipient from the API, failing closed unless it belongs to Sealed's published company wallet. */
export function companyRecipient(value: string): Address | ShieldedAddress {
  try {
    const r = resolveCompanyRecipient(value, COMPANY_WALLET, (b) => ShieldedAddress.fromBytes(b));
    return r.kind === "owner" ? kitAddress(r.owner) : r.address;
  } catch (e) {
    if (e instanceof BurnerError) throw new PrivacyFlowError(e.message, e.code);
    throw e;
  }
}

/* ---------------------------------------------------------------------------------------- identity */

/**
 * Open the private Sealed wallet: the main wallet signs the plain text message once, we verify it, derive the
 * seed, build the ring identity, and zero every secret buffer we held.
 */
export async function openBurner(bridge: MainWalletBridge): Promise<Identity> {
  const client = await getClient();
  const message = new TextEncoder().encode(burnerMessage(bridge.main));
  const raw = await bridge.signMessage(message);
  const signature = Uint8Array.from(raw);
  try {
    raw.fill?.(0);
  } catch {
    /* read-only buffer from the wallet */
  }
  let seed: Uint8Array | null = null;
  try {
    seed = await deriveBurnerSeed(bridge.main, signature);
    const burner = burnerAddressFromSeed(seed);
    const keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as Bytes32));
    const shielded = keypair.shieldedAddress();
    if (shielded.solanaAddress() !== burner) {
      keypair.destroy();
      throw new PrivacyFlowError("The private wallet keys didn't line up. Nothing was opened; reload and try again.", "key_mismatch");
    }
    const keys = LocalKeys.fromKeypair(keypair, client.proofService);
    const wallet = new Wallet({ identity: shielded });
    return { main: bridge.main, burner, keypair, keys, wallet, signer: keypair.toSolanaSigner(), shieldedAddress: encodeShieldedAddress(shielded) };
  } catch (e) {
    if (e instanceof BurnerError) throw new PrivacyFlowError(e.message, e.code);
    throw e;
  } finally {
    signature.fill(0);
    seed?.fill(0);
  }
}

export function destroyIdentity(id: Identity | null) {
  if (!id) return;
  for (const k of [id.keys, id.keypair]) {
    try {
      k.destroy();
    } catch {
      /* already destroyed */
    }
  }
}

/** base58 signature BY THE BURNER over the link message (raw Ed25519 over UTF-8). */
export function signLink(id: Identity): string {
  return bs58.encode(id.keypair.sign(new TextEncoder().encode(linkMessage(id.main, id.burner))));
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

function usdcAta(owner: string): PublicKey {
  return getAssociatedTokenAddressSync(new PublicKey(mintOf("USDC")), new PublicKey(owner), true, TOKEN_PROGRAM_ID);
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

/* ------------------------------------------------------------------------- public burner balances */

/** User record (100 bytes) rent + generous fee headroom for ~6 ring transactions. Labeled as an estimate in the UI. */
const USER_RECORD_SIZE = 100;
const TOKEN_ACCOUNT_SIZE = 165;
const RING_FEE_HEADROOM_LAMPORTS = 3_000_000n; // 0.003 SOL
const LEGACY_FEE_LAMPORTS = 10_000n;

export interface PublicBalances {
  /** lamports */
  sol: bigint;
  /** USDC atoms in the burner's token account (null: no token account yet) */
  usdc: bigint | null;
  /** lamports the burner should hold for fees + registration rent (+ token account rent when it has none) */
  needsLamports: bigint;
  registrationRentLamports: bigint;
  /** the needs figure came from getMinimumBalanceForRentExemption (false: fallback estimate) */
  exact: boolean;
}

export async function publicBalances(burner: string, registered: boolean | null): Promise<PublicBalances> {
  const conn = legacyConnection();
  const owner = new PublicKey(burner);
  const [sol, usdcBal, recordRent, ataRent] = await Promise.all([
    conn.getBalance(owner, "confirmed"),
    conn.getTokenAccountBalance(usdcAta(burner), "confirmed").then((r) => BigInt(r.value.amount)).catch(() => null),
    conn.getMinimumBalanceForRentExemption(USER_RECORD_SIZE).catch(() => null),
    conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE).catch(() => null),
  ]);
  const exact = recordRent !== null && ataRent !== null;
  const rent = BigInt(recordRent ?? 1_586_880);
  const needs = (registered ? 0n : rent) + RING_FEE_HEADROOM_LAMPORTS + (usdcBal === null ? BigInt(ataRent ?? 2_039_280) : 0n);
  return { sol: BigInt(sol), usdc: usdcBal, needsLamports: needs, registrationRentLamports: rent, exact };
}

/* ------------------------------------------------------------------------------------ sign + send */

/** Sign a ring (version 1) transaction with the burner key, send it through the SDK client's RPC, confirm. */
async function signAndSend(tx: Transaction, id: Identity): Promise<{ signature: string; slot: bigint }> {
  const client = await getClient();
  const signed = await signTransactionWithSigners([id.signer], tx);
  const signature = getSignatureFromTransaction(signed);
  await client.solanaRpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3n })
    .send();
  const slot = await client.confirmTransaction(signature);
  return { signature, slot };
}

async function legacyTx(feePayer: PublicKey, ixs: TransactionInstruction[], units: number, writable: PublicKey[]) {
  const conn = legacyConnection();
  const micro = await priorityFeeMicroLamports(conn, writable);
  return buildTransaction(conn, feePayer, [...computeBudgetIxs(units, micro), ...ixs]);
}

async function confirmLegacy(signature: string, lastValidBlockHeight: number) {
  const r = await confirmSignature(legacyConnection(), signature, { lastValidBlockHeight }).catch((e) => {
    if (e instanceof ConfirmationTimeoutError) throw new PrivacyFlowError(e.message, "timeout");
    throw e;
  });
  if (r.err) throw new PrivacyFlowError("The transfer failed on-chain. No funds moved.", "tx_failed");
}

/** Burner signs a legacy transaction locally (raw Ed25519 over the message, same key as the ring signer). */
async function sendFromBurner(id: Identity, ixs: TransactionInstruction[], units: number, writable: PublicKey[]): Promise<string> {
  const burner = new PublicKey(id.burner);
  const { tx, lastValidBlockHeight } = await legacyTx(burner, ixs, units, writable);
  await simulateOrThrow(legacyConnection(), tx);
  tx.addSignature(burner, id.keypair.sign(tx.serializeMessage()) as unknown as Buffer); // web3.js copies it into its own Buffer
  if (!tx.verifySignatures()) throw new PrivacyFlowError("The private wallet signature didn't verify. Nothing was sent.", "bad_local_signature");
  const signature = await legacyConnection().sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 3 });
  await confirmLegacy(signature, lastValidBlockHeight);
  return signature;
}

function transferIxs(from: PublicKey, to: PublicKey, asset: PrivateAsset, atoms: bigint): TransactionInstruction[] {
  if (asset === "SOL") return [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: atoms })];
  const mint = new PublicKey(mintOf("USDC"));
  const src = getAssociatedTokenAddressSync(mint, from, true, TOKEN_PROGRAM_ID);
  const dst = getAssociatedTokenAddressSync(mint, to, true, TOKEN_PROGRAM_ID);
  return [
    createAssociatedTokenAccountIdempotentInstruction(from, dst, to, mint, TOKEN_PROGRAM_ID),
    createTransferCheckedInstruction(src, mint, dst, from, atoms, decimalsOf("USDC"), [], TOKEN_PROGRAM_ID),
  ];
}

/* ----------------------------------------------------------------------------------------- flows */

/** Main wallet → burner public address, an ordinary legacy transfer the main wallet approves in its own UI. */
export async function fundBurner(id: Identity, bridge: MainWalletBridge, asset: PrivateAsset, ui: number): Promise<{ signature: string }> {
  if (bridge.main !== id.main) throw new PrivacyFlowError("Your wallet changed. Open the private wallet again.", "wallet_changed");
  const atoms = toAtoms(ui, asset);
  if (atoms <= 0n) throw new PrivacyFlowError("Enter an amount.", "no_amount");
  const main = new PublicKey(id.main);
  const burner = new PublicKey(id.burner);
  const conn = legacyConnection();
  if (asset === "SOL") {
    const bal = BigInt(await conn.getBalance(main, "confirmed"));
    if (bal < atoms + LEGACY_FEE_LAMPORTS) throw new PrivacyFlowError("Not enough SOL in your main wallet for this amount plus the network fee.", "insufficient");
  } else {
    const src = await conn.getTokenAccountBalance(usdcAta(id.main), "confirmed").catch(() => null);
    if (!src || BigInt(src.value.amount) < atoms) throw new PrivacyFlowError("Not enough USDC in your main wallet.", "insufficient");
  }
  const ixs = transferIxs(main, burner, asset, atoms);
  const { tx, lastValidBlockHeight } = await legacyTx(main, ixs, asset === "SOL" ? 30_000 : 80_000, asset === "SOL" ? [main, burner] : [main, usdcAta(id.burner)]);
  await simulateOrThrow(conn, tx);
  const signature = await bridge.sendLegacy(tx, conn);
  await confirmLegacy(signature, lastValidBlockHeight);
  return { signature };
}

/** Burner → main wallet (escape hatch), signed locally by the burner key. */
export async function sweepToMain(id: Identity, asset: PrivateAsset, ui: number): Promise<{ signature: string }> {
  const atoms = toAtoms(ui, asset);
  if (atoms <= 0n) throw new PrivacyFlowError("Enter an amount.", "no_amount");
  const burner = new PublicKey(id.burner);
  const main = new PublicKey(id.main);
  const sig = await sendFromBurner(id, transferIxs(burner, main, asset, atoms), asset === "SOL" ? 30_000 : 80_000, asset === "SOL" ? [burner, main] : [burner, usdcAta(id.main)]);
  return { signature: sig };
}

/** The largest SOL the burner can sweep to the main wallet (keeps the network fee). */
export function maxSweepLamports(sol: bigint): bigint {
  const fee = 25_000n; // base fee + capped priority fee for a 30k CU transfer
  return sol > fee ? sol - fee : 0n;
}

async function assertFeeBudget(id: Identity, extraLamports = 0n) {
  const sol = BigInt(await legacyConnection().getBalance(new PublicKey(id.burner), "confirmed"));
  if (sol < 200_000n + extraLamports) {
    throw new PrivacyFlowError("Your private wallet needs a little SOL for network fees first. Fund it with SOL from your main wallet.", "needs_sol");
  }
}

export async function register(id: Identity): Promise<string | null> {
  const client = await getClient();
  const tx = await buildRegistrationTransaction({ client, owner: kitAddress(id.burner), address: id.keypair.shieldedAddress() });
  if (!tx) return null; // already registered with these keys
  await assertFeeBudget(id, 1_600_000n);
  return (await signAndSend(tx, id)).signature;
}

/** Burner public balance into its private balance. The amount of this step is public on-chain. */
export async function shield(id: Identity, asset: PrivateAsset, ui: number) {
  const client = await getClient();
  const owner = kitAddress(id.burner);
  const amount = toAtoms(ui, asset);
  await assertFeeBudget(id, asset === "SOL" ? amount : 0n);
  const tx =
    asset === "SOL"
      ? await buildDepositTransaction({ client, feePayer: owner, depositor: owner, recipient: id.keypair.shieldedAddress(), amount })
      : await buildDepositTransaction({
          client,
          feePayer: owner,
          depositor: owner,
          recipient: id.keypair.shieldedAddress(),
          asset: mintOf(asset),
          splTokenAccount: kitAddress(usdcAta(id.burner).toBase58()),
          amount,
        });
  const r = await signAndSend(tx, id);
  return { ...r, balances: await syncBalances(id, r.slot) };
}

/** Private balance back to the burner's public address. The amount of this step is public on-chain. */
export async function unshield(id: Identity, asset: PrivateAsset, ui: number) {
  const client = await getClient();
  const owner = kitAddress(id.burner);
  await assertFeeBudget(id);
  if (asset === "USDC") {
    // The withdrawal pays into the burner's USDC token account: create it first if it doesn't exist (burner pays).
    const ata = usdcAta(id.burner);
    const info = await legacyConnection().getAccountInfo(ata, "confirmed");
    if (!info) {
      const burner = new PublicKey(id.burner);
      await sendFromBurner(id, [createAssociatedTokenAccountIdempotentInstruction(burner, ata, burner, new PublicKey(mintOf("USDC")), TOKEN_PROGRAM_ID)], 40_000, [burner, ata]);
    }
  }
  const tx = await buildWithdrawalTransaction({
    client,
    wallet: id.wallet,
    keys: id.keys,
    feePayer: owner,
    recipient: owner,
    ...(asset === "SOL" ? {} : { asset: mintOf(asset) }),
    amount: toAtoms(ui, asset),
  });
  const r = await signAndSend(tx, id);
  return { ...r, balances: await syncBalances(id, r.slot) };
}

/** Confidential transfer from the burner's private balance to Sealed custody. The amount is hidden on-chain. */
export async function sendPrivateToCompany(id: Identity, companyShieldedAddress: string, asset: PrivateAsset, ui: number) {
  const recipient = companyRecipient(companyShieldedAddress);
  const client = await getClient();
  await assertFeeBudget(id);
  const tx = await buildTransferTransaction({
    client,
    wallet: id.wallet,
    keys: id.keys,
    feePayer: kitAddress(id.burner),
    recipient,
    ...(asset === "SOL" ? {} : { asset: mintOf(asset) }),
    amount: toAtoms(ui, asset),
  });
  const r = await signAndSend(tx, id);
  return { ...r, balances: await syncBalances(id, r.slot) };
}

/** SDK error codes to plain sentences (no secrets, no amounts). */
export function describeSprError(e: unknown): string | null {
  const code = (e as { code?: string; causeCode?: string })?.code;
  const cause = (e as { causeCodes?: readonly string[] })?.causeCodes ?? [];
  const all = [code, ...cause].filter(Boolean).join(" ");
  if (/INSUFFICIENT_BALANCE/.test(all)) return "Not enough in your private balance for that amount.";
  if (/RECIPIENT_NOT_REGISTERED/.test(all)) return "Sealed's private deposit address isn't registered yet. Private deposits will open once it is.";
  if (/TOO_MANY_INPUTS/.test(all)) return "Your private balance is split across too many notes for one transfer. Send a smaller amount first.";
  if (/USER_RECORD_KEYS_MISMATCH|REGISTERED_KEYPAIR_MISMATCH/.test(all)) return "This private wallet is registered with different Privacy Ring keys.";
  if (/MISSING_SPL_TOKEN_ACCOUNT/.test(all)) return "Your private wallet has no USDC token account yet. Fund it with USDC first.";
  if (/CLIENT_PROVER|PROVER|TEE|ATTEST/.test(all)) return "The Helius prover could not be reached or attested. Nothing was sent; try again shortly.";
  if (/INDEXER|WALLET_SYNC/.test(all)) return "The Privacy Ring indexer is not answering right now. Try again shortly.";
  const msg = (e as Error)?.message ?? "";
  if (/insufficient (funds|lamports)|0x1\b/i.test(msg)) return "Your private wallet doesn't have enough SOL for this step. Fund it with a little more SOL.";
  return null;
}
