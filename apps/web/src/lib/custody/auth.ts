"use client";
// Owned by signin-web-agent. "Sign in to Sealed": POST /api/auth/nonce → the best proof the wallet can give
// (Wallet Standard signIn with the server's SIWS input, signMessage of the exact server message, or a signed but
// never-sent memo transaction for Ledger) → POST /api/auth/verify. The method logic lives in lib/wallet/signIn.ts;
// this file wires it to the API, the session store, a single-flight lock and a shared, observable flow state so
// every "Sign in" button on the page shows the same progress and error.
import { CUSTODY_ROUTES, type AuthNonceResponse, type AuthVerifyRequest, type AuthVerifyResponse } from "@sealed/shared";
import { RPC_ENDPOINT } from "../config";
import {
  SignInError,
  markSignInActive,
  runSignIn,
  toBytes,
  type SignInBackend,
  type SignInMethod,
  type SignInNonce,
  type SignInSigner,
  type SignInStatus,
} from "../wallet/signIn";
import { CustodyError, custodyFetch, getSession, setSession, type CustodySession } from "./client";

/** The domain a SIWS message is issued for (first line: "<domain> wants you to sign in with your Solana account:"). */
export function siwsDomain(message: string): string | null {
  const first = /^\s*([^\s]+) wants you to sign in with your Solana account:/m.exec(message)?.[1];
  const field = /^Domain:\s*(\S+)\s*$/m.exec(message)?.[1];
  return first ?? field ?? null;
}

/* ---------------------------------------------------------------------------------- flow state */

export interface SignInFlowError {
  message: string;
  kind: SignInError["kind"];
  quiet: boolean;
  code?: string;
  detail?: string;
}
export interface SignInFlowState {
  /** Wallet the current / last flow was for. */
  wallet: string | null;
  status: SignInStatus | null;
  /** Domain named by the request being signed (shown under the button). */
  domain: string | null;
  error: SignInFlowError | null;
  /** Method of the last successful or attempted proof. */
  method: SignInMethod | null;
}

let flow: SignInFlowState = { wallet: null, status: null, domain: null, error: null, method: null };
const flowListeners = new Set<() => void>();
function setFlow(next: Partial<SignInFlowState>) {
  flow = { ...flow, ...next };
  for (const l of flowListeners) l();
}
export function getSignInFlow(): SignInFlowState {
  return flow;
}
export function subscribeSignInFlow(fn: () => void): () => void {
  flowListeners.add(fn);
  return () => flowListeners.delete(fn);
}
/** Forget a stale error (e.g. the wallet changed). */
export function clearSignInError(wallet?: string | null) {
  if (flow.error && (!wallet || flow.wallet === wallet)) setFlow({ error: null });
}

/* ----------------------------------------------------------------------------------- backend */

function rpcEndpoint(): string {
  return RPC_ENDPOINT;
}

const backend: SignInBackend<AuthVerifyResponse> = {
  // Older API builds omit signInInput; the flow then skips the SIWS signIn method.
  nonce: (wallet) => custodyFetch<AuthNonceResponse | SignInNonce>(CUSTODY_ROUTES.nonce, { method: "POST", body: { wallet } }),
  verify: (body) => custodyFetch<AuthVerifyResponse>(CUSTODY_ROUTES.verify, { method: "POST", body: body satisfies AuthVerifyRequest }),
  async latestBlockhash() {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(rpcEndpoint(), {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }),
      });
      const json = (await res.json().catch(() => null)) as { result?: { value?: { blockhash?: string } } } | null;
      const hash = json?.result?.value?.blockhash;
      if (!res.ok || !hash) throw new CustodyError("RPC unavailable", res.status || 0, "network");
      return hash;
    } catch (e) {
      if (e instanceof CustodyError) throw e;
      throw new CustodyError("RPC unavailable", 0, "network");
    } finally {
      clearTimeout(t);
    }
  },
};

/* ------------------------------------------------------------------------------- single flight */

interface Active {
  wallet: string;
  promise: Promise<CustodySession>;
  ctrl: AbortController;
}
let active: Active | null = null;

/** Stop the in-flight sign-in (cancel button, wallet switched or disconnected). The wallet prompt may stay open. */
export function cancelSignIn(wallet?: string | null, reason?: SignInError) {
  if (!active || (wallet && active.wallet !== wallet)) return;
  active.ctrl.abort(reason ?? new SignInError("aborted", "Sign-in cancelled."));
}

export function isSigningIn(wallet?: string | null): boolean {
  return !!active && (!wallet || active.wallet === wallet);
}

export interface SignInOptions {
  /** Called with the domain the request names, before the wallet prompt. */
  onMessage?: (info: { domain: string | null; message: string }) => void;
}

/**
 * Sign the wallet in (or return its existing session). One flow at a time: a second click for the same wallet
 * joins the running flow; a flow for another wallet aborts the old one.
 */
export function signInWithSigner(signer: SignInSigner, opts: SignInOptions = {}): Promise<CustodySession> {
  const wallet = signer.address;
  const existing = getSession(wallet);
  if (existing) return Promise.resolve(existing);
  if (active && active.wallet === wallet) return active.promise;
  if (active) active.ctrl.abort(new SignInError("aborted", "Sign-in cancelled."));

  const ctrl = new AbortController();
  const release = markSignInActive();
  setFlow({ wallet, status: { phase: "preparing", method: null, walletName: signer.name, retry: false }, error: null, domain: null });

  const wrapped: SignInBackend<AuthVerifyResponse> = {
    ...backend,
    async nonce(w) {
      const n = await backend.nonce(w);
      const domain = n?.signInInput?.domain ?? (typeof n?.message === "string" ? siwsDomain(n.message) : null);
      if (active?.ctrl === ctrl) setFlow({ domain });
      opts.onMessage?.({ domain, message: n?.message ?? "" });
      return n;
    },
  };

  const promise = (async () => {
    try {
      const { result, address, method } = await runSignIn({
        signer,
        backend: wrapped,
        signal: ctrl.signal,
        onStatus: (status) => active?.ctrl === ctrl && setFlow({ status, method: status.method ?? flow.method }),
      });
      if (!result?.token) throw new SignInError("server", "Sign-in failed. Try again.", { code: "malformed" });
      const session: CustodySession = { token: result.token, wallet: result.wallet || address, expiresTs: result.expiresTs };
      setSession(session);
      if (active?.ctrl === ctrl) setFlow({ status: null, error: null, method });
      return session;
    } catch (e) {
      // A double submit can make the second verify fail with nonce_used although the first one signed us in.
      const late = getSession(signer.currentAddress() ?? wallet) ?? getSession(wallet);
      if (late && (e as SignInError)?.code === "nonce_used") {
        if (active?.ctrl === ctrl) setFlow({ status: null, error: null });
        return late;
      }
      const err =
        e instanceof SignInError
          ? e
          : new SignInError("wallet", `${signer.name || "The wallet"} couldn't complete the sign-in. Try again.`, { cause: e });
      if (active?.ctrl === ctrl || !active) {
        setFlow({
          status: null,
          error: { message: err.message, kind: err.kind, quiet: err.quiet, code: err.code, detail: err.opts.detail },
        });
      }
      // Keep the CustodyError shape callers already handle (message + status + code).
      throw Object.assign(new CustodyError(err.message, err.opts.status ?? 0, err.code ?? err.kind), { signInKind: err.kind, quiet: err.quiet, cause: err });
    } finally {
      release();
      if (active?.ctrl === ctrl) active = null;
    }
  })();
  active = { wallet, promise, ctrl };
  promise.catch(() => undefined);
  return promise;
}

/**
 * Back-compat entry point (onchain paths call it with just signMessage). Gets the same nonce handling, retries,
 * signature normalisation and friendly errors; signIn / memo-transaction methods need a full signer.
 */
export async function signInWithSolana(
  wallet: string,
  signerOrSignMessage: SignInSigner | ((m: Uint8Array) => Promise<Uint8Array | unknown>),
  opts: SignInOptions = {},
): Promise<CustodySession> {
  const signer: SignInSigner =
    typeof signerOrSignMessage === "function"
      ? {
          name: "your wallet",
          address: wallet,
          currentAddress: () => wallet,
          isConnected: () => true,
          signMessage: async (m) => toBytes(await signerOrSignMessage(m)),
        }
      : signerOrSignMessage;
  return signInWithSigner(signer, opts);
}

/** True if a thrown sign-in error was the user cancelling (show it quietly). */
export function isQuietSignInError(e: unknown): boolean {
  return !!(e as { quiet?: boolean })?.quiet;
}
