"use client";
// Transaction helpers shared by every wallet-signed flow. The browser RPC is the Sealed API's HTTP JSON-RPC proxy
// (no websocket), so confirmation is done by polling getSignatureStatuses, never by signature subscriptions.
import { ComputeBudgetProgram, type Connection, type PublicKey, type Transaction, type TransactionInstruction, type TransactionError } from "@solana/web3.js";

export const PRIORITY_FEE = {
  /** Floor in micro-lamports per CU (keeps simple transfers landing when the fee market is idle). */
  minMicroLamports: 5_000,
  /** Hard cap in micro-lamports per CU: with the CU limits we set, this bounds the fee at well under 0.001 SOL. */
  maxMicroLamports: 500_000,
} as const;

/** Median of recent prioritization fees for the given writable accounts, clamped to [min, max]. */
export async function priorityFeeMicroLamports(connection: Connection, writable: PublicKey[] = []): Promise<number> {
  try {
    const fees = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: writable.slice(0, 128) });
    const xs = fees.map((f) => f.prioritizationFee).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    if (!xs.length) return PRIORITY_FEE.minMicroLamports;
    const mid = Math.floor(xs.length / 2);
    const median = xs.length % 2 ? xs[mid]! : Math.round((xs[mid - 1]! + xs[mid]!) / 2);
    return Math.max(PRIORITY_FEE.minMicroLamports, Math.min(PRIORITY_FEE.maxMicroLamports, median));
  } catch {
    return PRIORITY_FEE.minMicroLamports;
  }
}

export function computeBudgetIxs(units: number, microLamports: number): TransactionInstruction[] {
  return [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports })];
}

/** Lamports a priority fee adds on top of the base 5000/signature fee. */
export function priorityFeeLamports(units: number, microLamports: number): number {
  return Math.ceil((units * microLamports) / 1_000_000);
}

export class SimulationError extends Error {
  constructor(message: string, public readonly logs: string[] = []) {
    super(message);
    this.name = "SimulationError";
  }
}

/** Simulate a (not yet signed) legacy transaction; throws SimulationError with a readable reason on failure. */
export async function simulateOrThrow(connection: Connection, tx: Transaction): Promise<{ unitsConsumed?: number }> {
  const res = await connection.simulateTransaction(tx);
  const { err, logs, unitsConsumed } = res.value;
  if (err) {
    const l = logs ?? [];
    const hint =
      l.find((x) => /insufficient (funds|lamports)/i.test(x)) ??
      l.find((x) => /Error|failed/i.test(x)) ??
      (typeof err === "string" ? err : JSON.stringify(err));
    throw new SimulationError(/insufficient/i.test(hint) ? "Not enough balance in your wallet to cover the amount plus network fees" : `Simulation failed: ${hint}`, l);
  }
  return { unitsConsumed };
}

export class ConfirmationTimeoutError extends Error {
  constructor(public readonly signature: string) {
    super("The network did not confirm the transaction in time. It may still land; check the explorer before retrying.");
    this.name = "ConfirmationTimeoutError";
  }
}

/**
 * Poll getSignatureStatuses until the signature reaches `commitment`, fails, or the blockhash expires.
 * Resolves `{ err }` (null on success) so callers can mirror `confirmTransaction(...).value.err`.
 */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  opts: { lastValidBlockHeight?: number; commitment?: "confirmed" | "finalized"; timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ err: TransactionError | null; slot?: number }> {
  const commitment = opts.commitment ?? "confirmed";
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const interval = opts.intervalMs ?? 1_500;
  let polls = 0;
  while (Date.now() < deadline) {
    try {
      const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: polls > 0 && polls % 10 === 0 });
      const st = value[0];
      if (st) {
        if (st.err) return { err: st.err, slot: st.slot };
        const level = st.confirmationStatus;
        if (level === "finalized" || (commitment === "confirmed" && level === "confirmed")) return { err: null, slot: st.slot };
      } else if (opts.lastValidBlockHeight !== undefined && polls % 4 === 3) {
        const height = await connection.getBlockHeight("confirmed").catch(() => 0);
        if (height > opts.lastValidBlockHeight) {
          // One last look: it may have landed right at the edge.
          const last = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }).catch(() => null))?.value[0];
          if (last?.err) return { err: last.err, slot: last.slot };
          if (last?.confirmationStatus) return { err: null, slot: last.slot };
          throw new Error("The transaction expired before it was confirmed. No funds moved; try again.");
        }
      }
    } catch (e) {
      if (e instanceof Error && /expired/.test(e.message)) throw e;
      /* transient RPC error: keep polling */
    }
    polls++;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new ConfirmationTimeoutError(signature);
}
