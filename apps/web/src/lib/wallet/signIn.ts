// Owned by signin-web-agent. "Sign in to Sealed" for every Solana wallet: capability detection, method fallback,
// signature normalisation and friendly errors. Framework free (no React, no app config) so it can be exercised
// against mocked wallets; lib/custody/auth.ts wires it to the Sealed API and the session store.
//
// Proofs (POST /api/auth/verify, see the backend contract):
//   (a) signMessage   → { signature }                                     base58, over the exact server `message` bytes
//   (b) signIn (SIWS) → { signature, signedMessage, address, signatureType } signature base58, signedMessage base64
//   (c) memo tx       → { signedTransaction }                              base64; signed only, NEVER broadcast
// Order: Wallet Standard `solana:signIn` with the server's signInInput → signMessage → memo transaction (Ledger and
// wallets without message signing). Format/unsupported errors fall through to the next method automatically; an
// explicit user rejection never retries. Timestamps always come from the server (no client clock involved).
import bs58 from "bs58";
import { AUTH_LOGIN_MEMO_PREFIX } from "@sealed/shared";
import type { Adapter } from "@solana/wallet-adapter-base";
import type { Transaction } from "@solana/web3.js";

/* ------------------------------------------------------------------------------------------ types */

export type SignInMethod = "signIn" | "signMessage" | "signTransaction";

/** Server-built SIWS fields (never computed client side, so clock skew cannot break them). */
export interface ServerSignInInput {
  domain?: string;
  address?: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

export interface SignInNonce {
  nonce: string;
  message: string;
  expiresTs: number;
  /** Absent on older API builds: then the SIWS `signIn` method is skipped. */
  signInInput?: ServerSignInInput | null;
}

export type SignInProof =
  | { signature: string }
  | { signature: string; signedMessage: string; address: string; signatureType?: "ed25519" }
  | { signedTransaction: string };

export interface SignInBackend<T> {
  nonce(wallet: string): Promise<SignInNonce>;
  verify(body: { wallet: string; nonce: string } & SignInProof): Promise<T>;
  /** Recent blockhash for the memo transaction (our RPC proxy). Only called on the transaction path. */
  latestBlockhash(): Promise<string>;
}

export interface SignInOutputBytes {
  address: string;
  signedMessage: Uint8Array;
  signature: Uint8Array;
}

/** What the flow needs from a wallet. Build one with `signerFromAdapter` (or a mock in checks). */
export interface SignInSigner {
  /** Wallet display name, e.g. "Phantom". */
  name: string;
  /** Address the app believes is connected. */
  address: string;
  /** The account the wallet would sign with right now (null if unknown). Detects account switches in the extension. */
  currentAddress(): string | null;
  /** False once the wallet disconnected. */
  isConnected(): boolean;
  /** Prefer signMessage over signIn (Mobile Wallet Adapter: signIn would re-authorize and switch apps twice). */
  preferMessage?: boolean;
  signIn?(input: ServerSignInInput): Promise<SignInOutputBytes>;
  /** Sign with the account `address` (Wallet Standard picks that exact account; adapters use their own key). */
  signMessage?(message: Uint8Array, address: string): Promise<Uint8Array>;
  /** Sign (only) a transaction and return its wire bytes. Must never send it. */
  signTransaction?(tx: Transaction, address: string): Promise<Uint8Array>;
}

export type SignInPhase = "idle" | "preparing" | "wallet" | "verifying";
export interface SignInStatus {
  phase: SignInPhase;
  method: SignInMethod | null;
  walletName: string;
  /** True when this is a second wallet prompt (expired request, fallback method). */
  retry: boolean;
}

export type SignInErrorKind =
  | "rejected"
  | "locked"
  | "unsupported"
  | "account_changed"
  | "disconnected"
  | "aborted"
  | "timeout"
  | "not_ready"
  | "bad_message"
  | "server"
  | "network"
  | "wallet";

export class SignInError extends Error {
  constructor(
    public readonly kind: SignInErrorKind,
    message: string,
    public readonly opts: { code?: string; status?: number; method?: SignInMethod | null; detail?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "SignInError";
  }
  get code(): string | undefined {
    return this.opts.code;
  }
  /** Quiet errors (user cancelled / aborted on purpose) are shown muted, not in the error colour. */
  get quiet(): boolean {
    return this.kind === "rejected" || this.kind === "aborted";
  }
}

/* --------------------------------------------------------------------------------- error parsing */

function errorText(e: unknown, depth = 0): string {
  if (!e || depth > 4) return "";
  if (typeof e === "string") return e;
  const err = e as { message?: unknown; name?: unknown; error?: unknown; cause?: unknown; code?: unknown; data?: unknown };
  const parts = [err.name, err.message, typeof err.code === "string" ? err.code : ""].filter((x) => typeof x === "string") as string[];
  return [parts.join(" "), errorText(err.error, depth + 1), errorText(err.cause, depth + 1)].filter(Boolean).join(" | ");
}
function errorCodes(e: unknown, depth = 0): number[] {
  if (!e || typeof e !== "object" || depth > 4) return [];
  const err = e as { code?: unknown; error?: unknown; cause?: unknown };
  return [...(typeof err.code === "number" ? [err.code] : []), ...errorCodes(err.error, depth + 1), ...errorCodes(err.cause, depth + 1)];
}

/** Classify a wallet error. Rejections must never be retried; format/unsupported errors fall back to the next method. */
export function classifyWalletError(e: unknown): "rejected" | "locked" | "unsupported" | "format" | "disconnected" | "other" {
  const m = errorText(e);
  const codes = errorCodes(e);
  if (codes.includes(4001) || /user rejected|rejected the request|request (was )?rejected|user denied|denied by (the )?user|user declined|declined|cancell?ed|user canceled|approval denied|user closed|closed by (the )?user|popup.*closed|window closed|aborted by user/i.test(m)) {
    return "rejected";
  }
  if (/\blocked\b|unlock/i.test(m)) return "locked";
  if (
    codes.includes(-32601) ||
    codes.includes(4200) ||
    /not supported|unsupported|not implemented|isn'?t supported|does ?n[o']t support|method not found|no such method|not available for|only supports? transactions|cannot sign (off.?chain )?messages|ledger|0x6a8[01]|WalletConfigError|WalletAccountError/i.test(m)
  ) {
    return "unsupported";
  }
  if (/invalid formatting|cannot be shown|formatting|malformed|could not be parsed|failed to parse|invalid (sign.?in|siws|message)|siws|unexpected token/i.test(m)) {
    return "format";
  }
  if (/disconnected|not connected|WalletNotConnectedError/i.test(m)) return "disconnected";
  return "other";
}

/* ----------------------------------------------------------------------------------- byte coercion */

function isBytesLike(x: unknown): x is ArrayLike<number> {
  return x instanceof Uint8Array || Array.isArray(x) || (typeof x === "object" && x !== null && ArrayBuffer.isView(x));
}

function decodeString(s: string): Uint8Array | null {
  try {
    const b = bs58.decode(s);
    if (b.length === 64) return b;
  } catch {
    /* not base58 */
  }
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Wallets return signatures as Uint8Array, Buffer, number[], ArrayBuffer, `{ signature }`, `{ data }` or strings. */
export function toBytes(x: unknown, what = "signature"): Uint8Array {
  if (x instanceof Uint8Array) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength).slice();
  if (x instanceof ArrayBuffer) return new Uint8Array(x.slice(0));
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength).slice();
  if (Array.isArray(x) && x.every((n) => typeof n === "number")) return Uint8Array.from(x);
  if (typeof x === "string") {
    const b = decodeString(x);
    if (b) return b;
  }
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    for (const k of what === "signature" ? ["signature", "data", "signedMessage"] : ["signedTransaction", "transaction", "data"]) {
      if (k in o && (isBytesLike(o[k]) || typeof o[k] === "string" || o[k] instanceof ArrayBuffer)) return toBytes(o[k], what);
    }
    // Buffer JSON form { type: "Buffer", data: [...] } handled above via `data`.
  }
  throw new SignInError("wallet", "The wallet returned a response Sealed couldn't read. Try again.", { detail: `unreadable ${what}` });
}

function signatureBytes(x: unknown): Uint8Array {
  const b = toBytes(x, "signature");
  if (b.length !== 64) throw new SignInError("wallet", "The wallet returned a response Sealed couldn't read. Try again.", { detail: `signature length ${b.length}` });
  return b;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Local ed25519 check (tweetnacl, loaded lazily). Used to detect that the wallet signed with another account. */
export async function verifyEd25519(message: Uint8Array, signature: Uint8Array, address: string): Promise<boolean> {
  try {
    const nacl = (await import("tweetnacl")).default;
    return nacl.sign.detached.verify(message, signature, bs58.decode(address));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------------ wallet adapters */

const SIGN_IN = "solana:signIn";
const SIGN_MESSAGE = "solana:signMessage";
const SIGN_TRANSACTION = "solana:signTransaction";
const MWA_NAMES = /mobile wallet adapter/i;

interface StdAccount { address: string; publicKey?: Uint8Array; chains?: readonly string[]; features?: readonly string[] }
interface StdWallet {
  name: string;
  accounts: readonly StdAccount[];
  features: Record<string, unknown>;
}
type StdSignIn = { signIn: (...inputs: ServerSignInInput[]) => Promise<readonly { account: StdAccount; signedMessage: unknown; signature: unknown }[]> };
type StdSignMessage = { signMessage: (...inputs: { account: StdAccount; message: Uint8Array }[]) => Promise<readonly unknown[]> };
type StdSignTransaction = {
  signTransaction: (...inputs: { account: StdAccount; transaction: Uint8Array; chain?: string }[]) => Promise<readonly unknown[]>;
};

function standardWalletOf(adapter: Adapter): StdWallet | null {
  const a = adapter as Adapter & { standard?: boolean; wallet?: unknown };
  if (!a.standard || !a.wallet || typeof a.wallet !== "object") return null;
  const w = a.wallet as StdWallet;
  return w.features && Array.isArray(w.accounts) ? w : null;
}

/** Remove null / undefined / empty fields: several wallets reject a SIWS input with `null` values. */
export function cleanSignInInput(input: ServerSignInInput): ServerSignInInput {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as ServerSignInInput;
}

/**
 * Build a signer for a connected wallet-adapter wallet. Wallet Standard wallets (Phantom, Solflare, Backpack,
 * Coinbase, Trust, Glow, Magic Eden, OKX, Exodus, …) are called through their features directly: that lets us pick
 * the exact account, keeps adapter error events (and their raw toasts) out of the sign-in flow, and sees account
 * switches immediately. Other adapters (Mobile Wallet Adapter, legacy Phantom/Solflare adapters) use the adapter API.
 */
export function signerFromAdapter(adapter: Adapter, address: string, opts: { chain?: string } = {}): SignInSigner {
  const std = standardWalletOf(adapter);
  const name = adapter.name;
  const chain = opts.chain ?? "solana:mainnet";
  const isConnected = () => adapter.connected && !!adapter.publicKey;
  const adapterAddress = () => adapter.publicKey?.toBase58() ?? null;

  if (std) {
    const account = (addr: string = address): StdAccount | null => std.accounts.find((a) => a.address === addr) ?? null;
    const has = (f: string, acc: StdAccount | null) => f in std.features && (!acc?.features || acc.features.includes(f));
    const signer: SignInSigner = {
      name,
      address,
      isConnected,
      // The wallet's first account is the one it treats as active; fall back to the adapter's key.
      currentAddress: () => std.accounts[0]?.address ?? adapterAddress(),
    };
    if (SIGN_IN in std.features) {
      signer.signIn = async (input) => {
        const feature = std.features[SIGN_IN] as StdSignIn;
        const [out] = await feature.signIn(cleanSignInInput(input));
        if (!out) throw new SignInError("wallet", `${name} didn't return a sign-in result. Try again.`);
        return { address: out.account.address, signedMessage: toBytes(out.signedMessage, "message"), signature: signatureBytes(out.signature) };
      };
    }
    if (has(SIGN_MESSAGE, account())) {
      signer.signMessage = async (message, addr) => {
        const acc = account(addr);
        if (!acc) throw new SignInError("account_changed", "Your wallet switched accounts.");
        const feature = std.features[SIGN_MESSAGE] as StdSignMessage;
        const [out] = await feature.signMessage({ account: acc, message });
        return signatureBytes(out);
      };
    }
    if (has(SIGN_TRANSACTION, account())) {
      signer.signTransaction = async (tx, addr) => {
        const acc = account(addr);
        if (!acc) throw new SignInError("account_changed", "Your wallet switched accounts.");
        const feature = std.features[SIGN_TRANSACTION] as StdSignTransaction;
        const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        const chainOk = !acc.chains || acc.chains.length === 0 || acc.chains.includes(chain);
        const [out] = await feature.signTransaction({ account: acc, transaction: new Uint8Array(bytes), ...(chainOk ? { chain } : {}) });
        return toBytes(out, "transaction");
      };
    }
    return signer;
  }

  // Classic adapter API (Mobile Wallet Adapter on Android Chrome, legacy injected adapters, Solflare web wallet).
  const a = adapter as Adapter & {
    signIn?: (input?: ServerSignInInput) => Promise<{ account: StdAccount; signedMessage: unknown; signature: unknown }>;
    signMessage?: (m: Uint8Array) => Promise<unknown>;
    signTransaction?: (tx: Transaction) => Promise<Transaction>;
  };
  const signer: SignInSigner = {
    name,
    address,
    isConnected,
    currentAddress: adapterAddress,
    preferMessage: MWA_NAMES.test(name),
  };
  if (typeof a.signIn === "function") {
    signer.signIn = async (input) => {
      const out = await a.signIn!(cleanSignInInput(input));
      const acc = out.account as StdAccount & { publicKey?: Uint8Array };
      const addr = acc.address && !/[=+/]/.test(acc.address) ? acc.address : acc.publicKey ? bs58.encode(acc.publicKey) : acc.address;
      return { address: addr, signedMessage: toBytes(out.signedMessage, "message"), signature: signatureBytes(out.signature) };
    };
  }
  if (typeof a.signMessage === "function") signer.signMessage = async (m) => signatureBytes(await a.signMessage!(m));
  if (typeof a.signTransaction === "function") {
    signer.signTransaction = async (tx) => {
      const signed = await a.signTransaction!(tx);
      const raw = (signed as Transaction).serialize ? (signed as Transaction).serialize({ requireAllSignatures: false, verifySignatures: false }) : signed;
      return toBytes(raw, "transaction");
    };
  }
  return signer;
}

/** Which sign-in methods a connected wallet offers (for UI: can this wallet sign in at all?). */
export function signInCapabilities(adapter: Adapter | null | undefined): { signIn: boolean; signMessage: boolean; signTransaction: boolean; any: boolean } {
  if (!adapter) return { signIn: false, signMessage: false, signTransaction: false, any: false };
  const std = standardWalletOf(adapter);
  const f = std?.features ?? {};
  const a = adapter as unknown as Record<string, unknown>;
  const signIn = SIGN_IN in f || typeof a.signIn === "function";
  const signMessage = SIGN_MESSAGE in f || typeof a.signMessage === "function";
  const signTransaction = SIGN_TRANSACTION in f || typeof a.signTransaction === "function";
  return { signIn, signMessage, signTransaction, any: signIn || signMessage || signTransaction };
}

/* -------------------------------------------------------------------------------- memo transaction */

export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const loginMemo = (nonce: string) => `${AUTH_LOGIN_MEMO_PREFIX}${nonce}`;

/**
 * Legacy transaction: fee payer = wallet, one SPL Memo `sealed-login:<nonce>`. Signed only; never sent by us or
 * the server. It carries a real recent blockhash because several wallets refuse (or fail simulation on) a fake one.
 * Theoretical risk, documented on purpose: a signed tx with a live blockhash could be broadcast by whoever holds it
 * for ~60-90 s; its only effect would be a memo plus the ~5000 lamport network fee. It moves no funds and grants
 * no authority, and the server discards it after verifying.
 */
export async function buildLoginTransaction(wallet: string, nonce: string, recentBlockhash: string): Promise<Transaction> {
  const { PublicKey, Transaction, TransactionInstruction } = await import("@solana/web3.js");
  const raw = new TextEncoder().encode(loginMemo(nonce));
  const B = (globalThis as { Buffer?: { from(x: Uint8Array): Uint8Array } }).Buffer;
  const data = (B ? B.from(raw) : raw) as unknown as Buffer;
  const tx = new Transaction({ feePayer: new PublicKey(wallet), recentBlockhash });
  tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data }));
  return tx;
}

/* ------------------------------------------------------------------------------------- the flow */

export interface ServerErrorLike {
  code?: string;
  status?: number;
  message?: string;
}

export interface RunSignInOptions<T> {
  signer: SignInSigner;
  backend: SignInBackend<T>;
  onStatus?: (s: SignInStatus) => void;
  /** Abort (cancel button, wallet switched / disconnected). The wallet prompt can't be closed, but the flow stops. */
  signal?: AbortSignal;
  /** Per wallet prompt; releases the single-flight lock if a wallet never answers. Default 5 minutes. */
  walletTimeoutMs?: number;
  /** Map a backend error to its `{ code, status }`. Default reads `.code` / `.status`. */
  serverError?: (e: unknown) => ServerErrorLike | null;
}

export interface RunSignInResult<T> {
  result: T;
  /** The address that signed in (may differ from signer.address if the wallet switched accounts). */
  address: string;
  method: SignInMethod;
}

const DEFAULT_WALLET_TIMEOUT = 5 * 60_000;

function defaultServerError(e: unknown): ServerErrorLike | null {
  if (!e || typeof e !== "object") return null;
  const x = e as { code?: unknown; status?: unknown; message?: unknown };
  if (typeof x.status !== "number" && typeof x.code !== "string") return null;
  return { code: typeof x.code === "string" ? x.code : undefined, status: typeof x.status === "number" ? x.status : undefined, message: typeof x.message === "string" ? x.message : undefined };
}

const SERVER_TEXT: Record<string, string> = {
  invalid_signature: "Sealed couldn't verify that signature. Try again.",
  expired: "The sign-in request expired. Try again.",
  domain_mismatch: "This sign-in request was made for a different site. Reload the page and try again.",
  nonce_used: "That sign-in request was already used. Try again.",
  wallet_mismatch: "The signature came from a different account than the one connected. Switch back and try again.",
  malformed: "Sealed couldn't read the wallet's sign-in response. Try again.",
  nonce_mismatch: "That signature was for an older sign-in request. Try again.",
  invalid_transaction: "The wallet changed the sign-in transaction, so Sealed can't accept it. Try again.",
  rate_limited: "Too many sign-in attempts. Wait a moment and try again.",
  unauthorized: "Your Sealed session ended. Sign in again.",
  auth_unavailable: "Sign-in is temporarily unavailable. Try again in a moment.",
};

export function friendlyServerText(code: string | undefined, status: number | undefined, fallback?: string): string {
  if (code && SERVER_TEXT[code]) return SERVER_TEXT[code];
  if (code === "network" || status === 0) return code === "timeout" ? "The Sealed API timed out. Try again." : "Can't reach Sealed right now. Check your connection and try again.";
  if (code === "timeout") return "The Sealed API timed out. Try again.";
  if (status === 429) return "Too many sign-in attempts. Wait a moment and try again.";
  if (status && status >= 500) return "Sealed is having trouble right now. Try again in a moment.";
  return fallback && fallback.length < 120 && !/[{}<>]|\bat\s+\w+\s*\(/.test(fallback) ? fallback : "Sign-in failed. Try again.";
}

function abortError(signal?: AbortSignal): SignInError {
  const r = signal?.reason;
  if (r instanceof SignInError) return r;
  return new SignInError("aborted", "Sign-in cancelled.");
}

function race<T>(p: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number, onTimeout: () => SignInError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => reject(onTimeout()), timeoutMs);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Run the full sign-in: nonce → best wallet method (with fallbacks) → verify. Bounded retries:
 *  - one transparent fresh nonce if the request expired / was already used while the user waited;
 *  - one restart with the wallet's current account if it switched accounts;
 *  - method fallback (signIn → signMessage → memo transaction) on format / unsupported errors.
 */
export async function runSignIn<T>(opts: RunSignInOptions<T>): Promise<RunSignInResult<T>> {
  const { signer, backend, onStatus, signal } = opts;
  const timeoutMs = opts.walletTimeoutMs ?? DEFAULT_WALLET_TIMEOUT;
  const serverError = opts.serverError ?? defaultServerError;
  const name = signer.name || "your wallet";

  const check = () => {
    if (signal?.aborted) throw abortError(signal);
    if (!signer.isConnected()) throw new SignInError("disconnected", "Wallet disconnected. Connect it again to sign in.");
  };

  const disabled = new Set<SignInMethod>();
  // If the user switched accounts inside the extension, ask for a nonce for the account the wallet will sign with.
  let address = signer.currentAddress() ?? signer.address;
  let nonceRefreshes = 0;
  let accountRestarts = 0;
  let prompts = 0;
  let lastWalletError: unknown = null;

  const order = (hasInput: boolean): SignInMethod[] => {
    const m: SignInMethod[] = [];
    const si = !!signer.signIn && hasInput;
    if (signer.preferMessage) {
      if (signer.signMessage) m.push("signMessage");
      if (si) m.push("signIn");
    } else {
      if (si) m.push("signIn");
      if (signer.signMessage) m.push("signMessage");
    }
    if (signer.signTransaction) m.push("signTransaction");
    return m.filter((x) => !disabled.has(x));
  };

  if (!signer.signIn && !signer.signMessage && !signer.signTransaction) {
    throw new SignInError("unsupported", "This wallet can't sign in yet. Try Phantom, Solflare or Backpack.");
  }

  // Each loop iteration: one fresh nonce. Bounded: at most a handful of nonces per click.
  for (let round = 0; round < 6; round++) {
    check();
    onStatus?.({ phase: "preparing", method: null, walletName: name, retry: prompts > 0 });
    let n: SignInNonce;
    try {
      n = await race(backend.nonce(address), signal, 30_000, () => new SignInError("network", "The Sealed API timed out. Try again.", { code: "timeout" }));
    } catch (e) {
      if (e instanceof SignInError) throw e;
      const se = serverError(e);
      throw new SignInError(se?.status === 0 || !se ? "network" : "server", friendlyServerText(se?.code, se?.status, se?.message), { code: se?.code, status: se?.status, cause: e });
    }
    check();
    // Sign exactly what the server issued, and refuse anything that isn't a Sealed sign-in for this account.
    if (!n?.nonce || typeof n.message !== "string" || !n.message.includes(address) || !n.message.includes(n.nonce)) {
      throw new SignInError("bad_message", "Sealed sent an unexpected sign-in request. Reload the page and try again.", { code: "bad_message" });
    }
    const input = n.signInInput && typeof n.signInInput === "object" ? n.signInInput : null;
    const inputOk = !!input && (!input.address || input.address === address) && (!input.nonce || input.nonce === n.nonce);
    const methods = order(inputOk);
    if (methods.length === 0) {
      throw new SignInError("unsupported", "This wallet can't sign in yet. Try Phantom, Solflare or Backpack.", { detail: errorText(lastWalletError) });
    }

    let restart = false;
    for (const method of methods) {
      check();
      onStatus?.({ phase: "wallet", method, walletName: name, retry: prompts > 0 });
      prompts++;
      let proof: SignInProof;
      let signedBy = address;
      try {
        const timeout = () => new SignInError("timeout", `No answer from ${name}. Open your wallet and try again.`, { method });
        if (method === "signIn") {
          const out = await race(signer.signIn!({ ...input!, address, nonce: n.nonce }), signal, timeoutMs, timeout);
          signedBy = out.address || address;
          proof = { signature: bs58.encode(out.signature), signedMessage: toBase64(out.signedMessage), address: signedBy, signatureType: "ed25519" };
        } else if (method === "signMessage") {
          const msg = new TextEncoder().encode(n.message);
          const sig = await race(signer.signMessage!(msg, address), signal, timeoutMs, timeout);
          if (!(await verifyEd25519(msg, sig, address))) {
            const current = signer.currentAddress();
            if (current && current !== address && (await verifyEd25519(msg, sig, current))) signedBy = current;
          }
          proof = { signature: bs58.encode(sig) };
        } else {
          const blockhash = await race(backend.latestBlockhash(), signal, 30_000, () => new SignInError("network", "Can't reach Sealed right now. Check your connection and try again.", { code: "timeout" }));
          check();
          const tx = await buildLoginTransaction(address, n.nonce, blockhash);
          const bytes = await race(signer.signTransaction!(tx, address), signal, timeoutMs, timeout);
          proof = { signedTransaction: toBase64(bytes) };
        }
      } catch (e) {
        if (e instanceof SignInError) {
          if (e.kind === "account_changed") {
            const current = signer.currentAddress();
            if (current && current !== address && accountRestarts < 1) {
              accountRestarts++;
              address = current;
              restart = true;
              break;
            }
          }
          throw e;
        }
        lastWalletError = e;
        const kind = classifyWalletError(e);
        if (kind === "rejected") throw new SignInError("rejected", "Sign-in cancelled.", { method, cause: e });
        if (kind === "locked") throw new SignInError("locked", "Unlock your wallet and try again.", { method, cause: e });
        if (kind === "disconnected") throw new SignInError("disconnected", "Wallet disconnected. Connect it again to sign in.", { method, cause: e });
        if (kind === "unsupported" || kind === "format") {
          disabled.add(method);
          continue; // next method, same nonce (nothing was sent to the server)
        }
        // Unknown wallet error: try the next method once, but only if it differs in kind (signIn → signMessage).
        if (method === "signIn") {
          disabled.add(method);
          continue;
        }
        throw new SignInError("wallet", `${name} couldn't complete the sign-in. Try again.`, { method, cause: e, detail: errorText(e) });
      }

      check();
      if (signedBy !== address) {
        // The wallet signed with a different account than the nonce was issued for: get a nonce for that account.
        if (accountRestarts < 1) {
          accountRestarts++;
          address = signedBy;
          restart = true;
          break;
        }
        throw new SignInError("account_changed", "Your wallet switched accounts. Pick the account you want in the wallet and try again.", { method });
      }

      onStatus?.({ phase: "verifying", method, walletName: name, retry: prompts > 1 });
      try {
        const result = await race(backend.verify({ wallet: address, nonce: n.nonce, ...proof }), signal, 30_000, () => new SignInError("network", "The Sealed API timed out. Try again.", { code: "timeout" }));
        return { result, address, method };
      } catch (e) {
        if (e instanceof SignInError) throw e;
        const se = serverError(e) ?? {};
        const code = se.code;
        if ((code === "expired" || code === "nonce_used" || code === "nonce_mismatch") && nonceRefreshes < 1) {
          nonceRefreshes++;
          restart = true; // fresh nonce, same method first
          break;
        }
        if (code === "wallet_mismatch" && accountRestarts < 1) {
          const current = signer.currentAddress();
          if (current && current !== address) {
            accountRestarts++;
            address = current;
            restart = true;
            break;
          }
        }
        if ((code === "invalid_signature" || code === "malformed") && method === "signIn" && signer.signMessage) {
          // The wallet built a SIWS message the server didn't accept: fall back to signing the server's exact text.
          disabled.add("signIn");
          restart = true;
          break;
        }
        const kind: SignInErrorKind = !se.status || se.status === 0 ? (code ? "server" : "network") : "server";
        throw new SignInError(kind, friendlyServerText(code, se.status, se.message), { code, status: se.status, method, cause: e });
      }
    }
    if (!restart) {
      throw new SignInError("unsupported", "This wallet can't sign in yet. Try Phantom, Solflare or Backpack.", { detail: errorText(lastWalletError) });
    }
  }
  throw new SignInError("wallet", "Sign-in didn't complete. Try again.");
}

/* ------------------------------------------------------------------------------------- UI text */

export function methodLabel(method: SignInMethod | null): string {
  if (method === "signTransaction") return "sign-in transaction";
  return "sign-in request";
}

/** "Approve the sign-in request in Phantom" etc. */
export function statusText(s: SignInStatus | null): string | null {
  if (!s || s.phase === "idle") return null;
  const name = s.walletName || "your wallet";
  if (s.phase === "preparing") return s.retry ? "Preparing a fresh sign-in request…" : "Preparing sign-in…";
  if (s.phase === "verifying") return "Verifying signature…";
  if (s.method === "signTransaction") return `Approve the sign-in in ${name}. It's a signature only: never sent, no fee.`;
  return s.retry ? `Approve the new sign-in request in ${name}` : `Approve the sign-in request in ${name}`;
}

/* ------------------------------------------------------------------------- active flow (toasts) */

let activeFlows = 0;
/** True while a sign-in is talking to the wallet: global wallet error toasts stay quiet (the sign-in UI explains). */
export function isWalletSignInActive(): boolean {
  return activeFlows > 0;
}
export function markSignInActive(): () => void {
  activeFlows++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    // Adapter error events fire synchronously before the promise settles; release on the next tick.
    setTimeout(() => (activeFlows = Math.max(0, activeFlows - 1)), 0);
  };
}
