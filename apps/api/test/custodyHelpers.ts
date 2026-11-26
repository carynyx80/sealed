import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { loadConfig } from "../src/config.js";
import type { CustodyConfig } from "../src/offchain/custody/config.js";
import type { ParsedTransaction, SignatureInfo, SignatureStatus, SolanaRpc, Commitment } from "../src/offchain/custody/rpc.js";
import { buildServer, type App } from "../src/server.js";

export const fixtures = JSON.parse(readFileSync(new URL("./fixtures/deposits.json", import.meta.url), "utf8")) as Record<string, unknown> & {
  companyWallet: string;
  user: string;
};

/** Fixture tx with the `{{REF}}` placeholder replaced. */
export function fixtureTx(name: string, ref: string): ParsedTransaction {
  return JSON.parse(JSON.stringify(fixtures[name]).split("{{REF}}").join(ref)) as ParsedTransaction;
}
export const sigOf = (tx: ParsedTransaction) => tx.transaction.signatures[0]!;

/** In-memory mock of the custody RPC surface. No network. */
export class MockRpc implements SolanaRpc {
  txs = new Map<string, ParsedTransaction>();
  sigsByAddress = new Map<string, SignatureInfo[]>(); // newest first
  slot = 400_000_000;
  blockHeight = 300_000_000;
  balances = new Map<string, bigint>();
  statuses = new Map<string, SignatureStatus>();
  sent: string[] = [];
  sendError: Error | null = null;
  fail: Error | null = null; // make every call throw
  blockhashN = 0;
  calls: string[] = [];

  private guard(m: string) {
    this.calls.push(m);
    if (this.fail) throw this.fail;
  }
  addTx(tx: ParsedTransaction, address?: string) {
    this.txs.set(sigOf(tx), tx);
    if (address) {
      const l = this.sigsByAddress.get(address) ?? [];
      l.unshift({ signature: sigOf(tx), slot: tx.slot, err: null, memo: null, blockTime: tx.blockTime, confirmationStatus: "finalized" });
      this.sigsByAddress.set(address, l);
    }
  }
  async getSignaturesForAddress(address: string, opts: { until?: string }) {
    this.guard("getSignaturesForAddress");
    const all = this.sigsByAddress.get(address) ?? [];
    const idx = opts.until ? all.findIndex((s) => s.signature === opts.until) : -1;
    return idx >= 0 ? all.slice(0, idx) : all;
  }
  async getTransaction(signature: string, _c: Commitment) {
    this.guard("getTransaction");
    return this.txs.get(signature) ?? null;
  }
  async getSlot() {
    this.guard("getSlot");
    return this.slot;
  }
  async getBalance(address: string) {
    this.guard("getBalance");
    return this.balances.get(address) ?? 0n;
  }
  async getTokenAccountBalance(address: string) {
    this.guard("getTokenAccountBalance");
    return this.balances.get(address) ?? null;
  }
  async getAccountExists(address: string) {
    return this.balances.has(address);
  }
  async getLatestBlockhash() {
    this.guard("getLatestBlockhash");
    this.blockhashN++;
    return { blockhash: bs58.encode(Buffer.alloc(32, this.blockhashN)), lastValidBlockHeight: this.blockHeight + 150 };
  }
  async getBlockHeight() {
    this.guard("getBlockHeight");
    return this.blockHeight;
  }
  async sendRawTransaction(raw: string) {
    this.guard("sendRawTransaction");
    this.sent.push(raw);
    if (this.sendError) throw this.sendError;
    return "ok";
  }
  async getSignatureStatuses(sigs: string[]) {
    this.guard("getSignatureStatuses");
    return sigs.map((s) => this.statuses.get(s) ?? null);
  }
}

export async function makeCustodyApp(custody: Partial<CustodyConfig> = {}, rpc: SolanaRpc | null = new MockRpc()): Promise<App> {
  const config = loadConfig({ NODE_ENV: "test" });
  const app = await buildServer({ config, logger: false, workers: false, custody: { env: {}, rpc, config: { workers: false, ...custody } } });
  await app.ready();
  return app;
}

/** Full SIWS sign-in against the app; returns the bearer token. */
export async function signIn(app: App, kp = Keypair.generate()): Promise<{ token: string; wallet: string; kp: Keypair }> {
  const wallet = kp.publicKey.toBase58();
  const n = await app.inject({ method: "POST", url: "/api/auth/nonce", payload: { wallet } });
  if (n.statusCode !== 200) throw new Error(n.body);
  const { nonce, message } = n.json<{ nonce: string; message: string }>();
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
  const v = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { wallet, nonce, signature } });
  if (v.statusCode !== 200) throw new Error(v.body);
  return { token: v.json<{ token: string }>().token, wallet, kp };
}
