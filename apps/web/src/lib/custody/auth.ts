"use client";
// Owned by web-offchain-agent. Sign-In-With-Solana: POST nonce → wallet.signMessage(server message) → POST verify.
// The user signs a plain-text message in their own wallet; no transaction, no fee, no key ever leaves the wallet.
import bs58 from "bs58";
import { CUSTODY_ROUTES, type AuthNonceResponse, type AuthVerifyResponse } from "@sealed/shared";
import { CustodyError, custodyFetch, getSession, setSession, type CustodySession } from "./client";

const inflight = new Map<string, Promise<CustodySession>>();

export async function signInWithSolana(wallet: string, signMessage: (m: Uint8Array) => Promise<Uint8Array>): Promise<CustodySession> {
  const existing = getSession(wallet);
  if (existing) return existing;
  let p = inflight.get(wallet);
  if (!p) {
    p = (async () => {
      const n = await custodyFetch<AuthNonceResponse>(CUSTODY_ROUTES.nonce, { method: "POST", body: { wallet } });
      // Sign exactly the server's message; refuse anything that doesn't look like a Sealed sign-in.
      if (!n.message.includes(wallet) || !n.message.includes(n.nonce)) {
        throw new CustodyError("Unexpected sign-in message from the server", 0, "bad_message");
      }
      const sig = await signMessage(new TextEncoder().encode(n.message));
      const v = await custodyFetch<AuthVerifyResponse>(CUSTODY_ROUTES.verify, {
        method: "POST",
        body: { wallet, nonce: n.nonce, signature: bs58.encode(sig) },
      });
      const session: CustodySession = { token: v.token, wallet: v.wallet, expiresTs: v.expiresTs };
      setSession(session);
      return session;
    })();
    inflight.set(wallet, p);
    p.finally(() => inflight.delete(wallet)).catch(() => undefined);
  }
  return p;
}
