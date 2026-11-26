/**
 * Helius Privacy Ring smoke test for Sealed custody (OPERATOR script, tiny amounts). Entry: scripts/privacy-smoke.ts
 *
 *   HELIUS_API_KEY=… node --import tsx scripts/privacy-smoke.ts \
 *     --api https://<api> --keypair ~/.config/solana/privacy-smoke.json --network devnet
 *   # mainnet additionally requires --i-understand-mainnet (REAL FUNDS; max 0.01 SOL)
 *
 * Steps: (1) API privacy status + company registration, (2) SIWS sign-in with the operator keypair,
 * (3) register the operator's shielded address if needed, (4) shield --amount SOL (default 0.001) from the operator
 * wallet, (5) confidential transfer of that amount to the company shielded owner, (6) poll the API until credited,
 * (7) request a private withdrawal of the same amount back to the operator's shielded address and poll its status.
 * The operator keypair file is read locally and never printed; the API key is only sent to Helius.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import {
  LocalKeys,
  ShieldedKeypair,
  SigningKey,
  Wallet,
  buildDepositTransaction,
  buildRegistrationTransaction,
  buildTransferTransaction,
  createSprClient,
  initializePoseidon,
  syncWallet,
  type Address,
  type Bytes32,
} from "@heliuslabs/spr";
import { SignedTeePolicy, type SprClient } from "@heliuslabs/spr/client";
import { getBase64EncodedWireTransaction, getSignatureFromTransaction, signTransactionWithSigners, type Transaction, type TransactionPartialSigner } from "@solana/kit";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

const MAX_SOL = 0.01;
const { values: a } = parseArgs({
  options: {
    api: { type: "string" },
    keypair: { type: "string" },
    network: { type: "string", default: "devnet" },
    amount: { type: "string", default: "0.001" },
    "i-understand-mainnet": { type: "boolean", default: false },
    "skip-withdraw": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (a.help || !a.api || !a.keypair) {
  console.log("usage: node --import tsx scripts/privacy-smoke.ts --api <url> --keypair <file.json> [--network devnet|mainnet] [--amount 0.001] [--i-understand-mainnet] [--skip-withdraw]\n  env: HELIUS_API_KEY");
  process.exit(a.help ? 0 : 2);
}
const network = a.network as "mainnet" | "devnet";
if (network !== "mainnet" && network !== "devnet") throw new Error("--network must be devnet or mainnet");
if (network === "mainnet" && !a["i-understand-mainnet"]) {
  console.error("Refusing to run on MAINNET without --i-understand-mainnet (this moves real SOL).");
  process.exit(2);
}
const amountSol = Number(a.amount);
if (!(amountSol >= 0.001 && amountSol <= MAX_SOL)) throw new Error(`--amount must be between 0.001 and ${MAX_SOL} SOL`);
const lamports = BigInt(Math.round(amountSol * 1e9));
const apiKey = process.env.HELIUS_API_KEY;
if (!apiKey) throw new Error("HELIUS_API_KEY env is required");
const api = a.api.replace(/\/$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: T }> {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}

async function submit(client: SprClient, signer: TransactionPartialSigner, tx: Transaction): Promise<{ signature: string; slot: bigint }> {
  const signed = await signTransactionWithSigners([signer], tx);
  const signature = getSignatureFromTransaction(signed);
  await client.solanaRpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
  const slot = await client.confirmTransaction(signature);
  return { signature, slot };
}

async function main() {
  // 1. API status.
  const st = await http<{ enabled?: boolean; reason?: string; companyShieldedAddress?: string; companyRegistered?: boolean; network?: string }>("GET", "/api/privacy/status");
  console.log("status:", { enabled: st.json.enabled, network: st.json.network, companyRegistered: st.json.companyRegistered, reason: st.json.reason });
  if (st.json.network !== network) throw new Error(`API runs on ${st.json.network}, not ${network}`);
  if (!st.json.enabled || !st.json.companyShieldedAddress) throw new Error(`private flows not enabled on the API: ${st.json.reason ?? "unknown"}`);

  // 2. Operator keypair + SIWS.
  const file = a.keypair!.replace(/^~(?=\/)/, homedir());
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]));
  const wallet = kp.publicKey.toBase58();
  const n = await http<{ nonce: string; message: string }>("POST", "/api/auth/nonce", { wallet });
  const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(n.json.message), kp.secretKey));
  const v = await http<{ token: string }>("POST", "/api/auth/verify", { wallet, nonce: n.json.nonce, signature: sig });
  if (v.status !== 200) throw new Error(`sign-in failed (${v.status})`);
  const token = v.json.token;
  const info = await http<{ companyShieldedAddress: string; reference: string; minAmount: { SOL: number } }>("GET", "/api/privacy/deposit-info", undefined, token);
  if (info.status !== 200) throw new Error(`deposit-info failed (${info.status})`);
  if (amountSol < info.json.minAmount.SOL) throw new Error(`amount below the API minimum (${info.json.minAmount.SOL} SOL)`);
  console.log("operator:", wallet, "→ company:", info.json.companyShieldedAddress);

  // 3. SDK client + operator shielded identity (same owner seed as the Solana signer, per the SDK README).
  await initializePoseidon();
  const client = await createSprClient({ solanaRpcUrl: `https://${network}.helius-rpc.com/?api-key=${encodeURIComponent(apiKey!)}`, proverTee: SignedTeePolicy.forNetwork(network), commitment: "confirmed" });
  const seed = kp.secretKey.slice(0, 32);
  const shielded = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as Bytes32));
  seed.fill(0);
  const signer = shielded.toSolanaSigner();
  const keys = LocalKeys.fromKeypair(shielded, client.proofService);
  const w = new Wallet({ identity: shielded.shieldedAddress() });
  const reg = await buildRegistrationTransaction({ client, owner: wallet as Address, address: shielded.shieldedAddress() });
  if (reg) console.log("operator registration:", (await submit(client, signer, reg)).signature);

  // 4. Shield.
  const dep = await submit(client, signer, await buildDepositTransaction({ client, feePayer: wallet as Address, recipient: shielded.shieldedAddress(), amount: lamports }));
  console.log("shielded", amountSol, "SOL:", dep.signature);
  await syncWallet({ client, wallet: w, keys, config: { requireSlot: dep.slot } });

  // 5. Confidential transfer to the company (attributed by the sending wallet = this signed-in operator).
  const tr = await submit(client, signer, await buildTransferTransaction({ client, wallet: w, keys, feePayer: wallet as Address, recipient: info.json.companyShieldedAddress as Address, amount: lamports }));
  console.log("confidential transfer:", tr.signature);

  // 6. Poll the API until credited (finalization ≈ 15-30 s).
  let credited = false;
  for (let i = 0; i < 40 && !credited; i++) {
    const c = await http<{ status: string; reason?: string }>("POST", "/api/privacy/deposits/claim", { signature: tr.signature }, token);
    console.log(`claim[${i}]:`, c.json.status, c.json.reason ?? "");
    if (c.json.status === "rejected") throw new Error("deposit rejected by the API (see reason)");
    credited = c.json.status === "credited";
    if (!credited) await sleep(6_000);
  }
  if (!credited) throw new Error("not credited in time (it may still be credited later; check GET /api/privacy/deposits)");
  if (a["skip-withdraw"]) return;

  // 7. Private withdrawal back to the operator's registered shielded address.
  const wd = await http<{ id: string; status: string; reason?: string }>("POST", "/api/account/withdrawals", { asset: "SOL", amount: amountSol, destination: wallet, privateTo: wallet }, token);
  console.log("private withdrawal:", wd.status, wd.json.status, wd.json.reason ?? "");
  if (wd.status !== 201) throw new Error("private withdrawal request failed");
  for (let i = 0; i < 40; i++) {
    const list = await http<{ withdrawals: { id: string; status: string; reason?: string; signature?: string }[] }>("GET", "/api/account/withdrawals", undefined, token);
    const row = list.json.withdrawals.find((x) => x.id === wd.json.id);
    console.log(`withdrawal[${i}]:`, row?.status, row?.reason ?? "", row?.signature ?? "");
    if (row && ["sent", "failed", "rejected", "pending_approval"].includes(row.status)) break;
    await sleep(6_000);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("privacy smoke FAILED:", String((e as Error).message ?? e).replace(/api-key=[^&\s"']+/gi, "api-key=***"));
    process.exit(1);
  },
);
