import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { WITHDRAWAL_LIMITS, type QuoteAssetSymbol, type WithdrawalRecord } from "@sealed/shared";
import { fromAtoms, isValidDestination, toAtoms, type CustodyAsset } from "./chain.js";
import type { CustodyConfig } from "./config.js";
import { ledgerErrorCode, type CustodyLedger } from "./ledgerPort.js";
import { StaticPriceService, type PriceQuote, type PriceService } from "./prices.js";
import type { CustodyRepo, WithdrawalRec } from "./repo.js";

/** Smallest SOL payout: keeps new destination accounts above the rent-exempt minimum (890,880 lamports). */
export const MIN_SOL_WITHDRAWAL_LAMPORTS = 1_000_000n;
const DAY_MS = 86_400_000;

export class CustodyError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export function withdrawalToDto(w: WithdrawalRec, decimals: number): WithdrawalRecord {
  return {
    id: w.id,
    asset: w.asset,
    amount: fromAtoms(w.amountAtoms, decimals),
    destination: w.destination,
    status: w.status,
    ...(w.signature && (w.status === "sent" || w.status === "sending") ? { signature: w.signature } : {}),
    ts: Math.floor(w.createdAt.getTime() / 1000),
    ...(w.reason ? { reason: w.reason } : {}),
  };
}

export class WithdrawalService {
  constructor(
    private readonly cfg: CustodyConfig,
    private readonly repo: CustodyRepo,
    private readonly ledger: CustodyLedger | null,
    private readonly assets: CustodyAsset[],
    private readonly log: FastifyBaseLogger,
    private readonly now: () => Date = () => new Date(),
    private readonly prices: PriceService = new StaticPriceService(),
  ) {}

  asset(symbol: QuoteAssetSymbol): CustodyAsset | undefined {
    return this.assets.find((a) => a.symbol === symbol);
  }
  dto(w: WithdrawalRec): WithdrawalRecord {
    return withdrawalToDto(w, this.asset(w.asset)?.decimals ?? 0);
  }

  /**
   * Validate → reserve funds in the ledger (user_available → user_locked) → record.
   * Auto-approved (status `queued`) if ≤ autoApproveMaxUsd and within the 24h per-wallet cap, else `pending_approval`.
   * `queued` rows are sent by the PayoutWorker only when payouts are enabled; otherwise they wait.
   */
  async request(wallet: string, input: { asset: QuoteAssetSymbol; amount: number; destination: string }): Promise<WithdrawalRec> {
    // Serialize per wallet (in-process) so concurrent requests cannot both slip under the daily cap.
    const prev = this.walletQueue.get(wallet) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.requestInner(wallet, input));
    const tail = run.catch(() => undefined);
    this.walletQueue.set(wallet, tail);
    void tail.then(() => {
      if (this.walletQueue.get(wallet) === tail) this.walletQueue.delete(wallet);
    });
    return run;
  }
  private walletQueue = new Map<string, Promise<unknown>>();

  private async requestInner(wallet: string, input: { asset: QuoteAssetSymbol; amount: number; destination: string }): Promise<WithdrawalRec> {
    if (!this.ledger) throw new CustodyError(503, "ledger unavailable");
    const a = this.asset(input.asset);
    if (!a) throw new CustodyError(400, `${input.asset} is not withdrawable on ${this.cfg.network}`);
    if (!isValidDestination(input.destination)) throw new CustodyError(400, "destination must be a valid on-curve Solana wallet address");
    if (input.destination === this.cfg.companyWallet) throw new CustodyError(400, "destination cannot be the company wallet");
    let atoms: bigint;
    try {
      atoms = toAtoms(input.amount, a.decimals);
    } catch {
      throw new CustodyError(400, "invalid amount");
    }
    if (atoms <= 0n) throw new CustodyError(400, "amount is below the asset's smallest unit");
    if (atoms > 0xffff_ffff_ffff_ffffn) throw new CustodyError(400, "amount too large");
    if (a.mint === null && atoms < MIN_SOL_WITHDRAWAL_LAMPORTS) throw new CustodyError(400, "minimum SOL withdrawal is 0.001 SOL");

    let quote: PriceQuote | null = null;
    try {
      quote = await this.prices.usdPrice(a.symbol);
    } catch {
      quote = null;
    }
    // Recorded usdValue (feeds the 24h cap): the fresh price, else the last known one, else the demo reference.
    const approxPrice = quote?.usd ?? this.prices.lastKnown(a.symbol)?.usd ?? a.usdPrice;
    const usdValue = fromAtoms(atoms, a.decimals) * approxPrice;
    const now = this.now();
    const usedToday = await this.repo.withdrawnUsdSince(wallet, new Date(now.getTime() - DAY_MS));
    const { autoApproveMaxUsd, dailyPerWalletUsd } = WITHDRAWAL_LIMITS;
    let reason: string | null = null;
    if (this.cfg.manualApprovalOnly) reason = "manual approval required (ADMIN_TOKEN not configured on mainnet)";
    else if (!quote) reason = `no fresh ${a.symbol} USD price: manual approval required`;
    else if (usdValue > autoApproveMaxUsd) reason = `above auto-approve limit ($${autoApproveMaxUsd})`;
    else if (usedToday + usdValue > dailyPerWalletUsd) reason = `daily limit ($${dailyPerWalletUsd}) exceeded`;
    const needsApproval = reason !== null;
    const id = randomUUID();

    try {
      await this.ledger.debitForWithdrawal(wallet, a.symbol, atoms, `wd:${id}:lock`, { type: "withdrawal_lock", withdrawalId: id, destination: input.destination });
    } catch (e) {
      if (ledgerErrorCode(e) === "INSUFFICIENT_FUNDS") throw new CustodyError(400, "insufficient available balance");
      throw e;
    }
    const rec: WithdrawalRec = {
      id, wallet, asset: a.symbol, mint: a.mint, amountAtoms: atoms, destination: input.destination, usdValue,
      status: needsApproval ? "pending_approval" : "queued",
      reason,
      signature: null, rawTx: null, blockhash: null, lastValidBlockHeight: null, attempts: 0, approvedBy: null,
      createdAt: now, updatedAt: now, sentAt: null,
    };
    try {
      await this.repo.insertWithdrawal(rec);
    } catch (e) {
      await this.ledger.unlock(wallet, a.symbol, atoms, `wd:${id}:unlock`, { type: "withdrawal_unlock", withdrawalId: id, reason: "record failed" }).catch(() => undefined);
      throw e;
    }
    this.log.info({ withdrawalId: id, wallet, asset: a.symbol, atoms: atoms.toString(), status: rec.status, usd: Math.round(usdValue * 100) / 100, priceSource: quote?.source ?? null }, "custody: withdrawal requested");
    return rec;
  }

  async approve(id: string, approvedBy = "admin"): Promise<WithdrawalRec> {
    const w = await this.repo.transitionWithdrawal(id, ["pending_approval"], { status: "queued", approvedBy, reason: null });
    if (!w) throw new CustodyError(409, "withdrawal is not pending approval");
    this.log.info({ withdrawalId: id }, "custody: withdrawal approved");
    return w;
  }

  /** Reject a not-yet-sent withdrawal and release the reserved funds. */
  async reject(id: string, reason: string): Promise<WithdrawalRec> {
    const w = await this.repo.transitionWithdrawal(id, ["pending_approval", "queued"], { status: "rejected", reason });
    if (!w) throw new CustodyError(409, "withdrawal cannot be rejected in its current state");
    await this.release(w, reason);
    this.log.info({ withdrawalId: id }, "custody: withdrawal rejected");
    return w;
  }

  /** user_locked → user_available. Idempotent (same key for reject/fail; only one terminal state is reachable). */
  async release(w: WithdrawalRec, reason: string): Promise<void> {
    if (!this.ledger) return;
    await this.ledger.unlock(w.wallet, w.asset, w.amountAtoms, `wd:${w.id}:unlock`, { type: "withdrawal_unlock", withdrawalId: w.id, reason: reason.slice(0, 200) });
  }
}
