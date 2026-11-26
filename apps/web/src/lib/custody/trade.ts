"use client";
// Owned by web-offchain-agent. Thin typed wrappers over the custody trade routes. Every call is authenticated
// with the signed-in wallet's session and refreshes that wallet's balances afterwards.
import { CUSTODY_ROUTES, type OffchainSwapResponse } from "@sealed/shared";
import { custodyFetch } from "./client";
import { invalidateCustody } from "./hooks";

async function post<T>(wallet: string, path: string, body?: unknown): Promise<T> {
  try {
    return await custodyFetch<T>(path, { method: "POST", wallet, body: body ?? {} });
  } finally {
    invalidateCustody(wallet);
  }
}

export const custodyTrade = {
  commitBid: (wallet: string, b: { launchId: string; commitment: string; deposit: number; sealedReveal?: unknown }) =>
    post<{ bidId: string; bidCount: number }>(wallet, CUSTODY_ROUTES.commitBid, b),
  reveal: (wallet: string, b: { launchId: string; maxPrice: string; bidAmount: string; salt: string }) =>
    post<{ revealed: true }>(wallet, CUSTODY_ROUTES.reveal, b),
  swap: (wallet: string, b: { launchId: string; side: "buy" | "sell"; amountIn: number; minAmountOut: number }) =>
    post<OffchainSwapResponse>(wallet, CUSTODY_ROUTES.swap, b),
  claim: (wallet: string, launchId: string) => post<{ tokens: number; refund: number }>(wallet, CUSTODY_ROUTES.claim(launchId)),
  stake: (wallet: string, launchId: string, amount: number) => post<unknown>(wallet, CUSTODY_ROUTES.stake, { launchId, amount }),
  claimRewards: (wallet: string, launchId: string) => post<{ amount: number }>(wallet, CUSTODY_ROUTES.claimRewards(launchId)),
};
