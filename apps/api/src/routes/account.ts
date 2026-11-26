import type { FastifyInstance } from "fastify";
import {
  COMPANY_WALLET,
  DepositClaimSchema,
  QUOTE_ASSETS,
  WithdrawRequestSchema,
  isQuoteAssetSymbol,
  quoteAssetDisabledReason,
  type AccountResponse,
  type BalanceRow,
} from "@sealed/shared";
import { sendError, zodDetails, type AppContext } from "../context.js";
import { RateLimiter } from "../offchain/auth/rateLimit.js";
import { requireAuth } from "../offchain/auth/requireAuth.js";
import { fromAtoms } from "../offchain/custody/chain.js";
import { depositToDto } from "../offchain/custody/deposits.js";
import type { CustodyRuntime } from "../offchain/custody/index.js";
import { redact } from "../offchain/custody/rpc.js";
import { CustodyError } from "../offchain/custody/withdrawals.js";

const SMALL_BODY = 4 * 1024;

export async function accountRoutes(app: FastifyInstance, ctx: AppContext, custody: CustodyRuntime) {
  const claimLimit = new RateLimiter(10);
  const withdrawLimit = new RateLimiter(10);

  async function balancesFor(wallet: string): Promise<BalanceRow[]> {
    const engine = ctx.offchain?.engine;
    if (engine) return engine.accountBalances(wallet);
    if (!custody.ledger) return [];
    return (await custody.ledger.balances(wallet)).map((b) => {
      const d = isQuoteAssetSymbol(b.asset) ? QUOTE_ASSETS[b.asset].decimals : 6;
      return { asset: b.asset as BalanceRow["asset"], symbol: b.asset, available: fromAtoms(b.available, d), locked: fromAtoms(b.locked, d) };
    });
  }

  app.get("/api/account", { preHandler: requireAuth }, async (req): Promise<AccountResponse> => {
    const wallet = req.wallet!;
    const user = await custody.repo.ensureUser(wallet);
    return {
      wallet,
      balances: await balancesFor(wallet),
      depositRef: user.depositRef,
      companyWallet: custody.config.companyWallet ?? COMPANY_WALLET,
      network: custody.config.network,
      sniperFlags: (await ctx.offchain?.engine.sniperFlags(wallet)) ?? [],
    };
  });

  app.get<{ Params: { asset: string } }>("/api/account/deposit/:asset", { preHandler: requireAuth }, async (req, reply) => {
    const { asset } = req.params;
    if (!isQuoteAssetSymbol(asset)) return sendError(reply, 400, `unknown asset ${asset}`);
    const user = await custody.repo.ensureUser(req.wallet!);
    const ins = custody.deposits.instructions(asset, user.depositRef);
    if (!ins) return sendError(reply, 400, `${asset} deposits are not supported on ${custody.config.network}: ${quoteAssetDisabledReason(asset, custody.config.network) ?? "not configured for custody"}`);
    return ins;
  });

  app.get("/api/account/deposits", { preHandler: requireAuth }, async (req) => ({
    deposits: (await custody.repo.listDepositsByWallet(req.wallet!, 100)).map(depositToDto),
  }));

  /** Nudge detection of a specific signature (e.g. right after the user sent it). */
  app.post("/api/account/deposits", { bodyLimit: SMALL_BODY, preHandler: requireAuth }, async (req, reply) => {
    const p = DepositClaimSchema.safeParse(req.body ?? {});
    if (!p.success) return sendError(reply, 400, "invalid deposit claim", zodDetails(p.error));
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(p.data.signature)) return sendError(reply, 400, "signature must be base58");
    if (!claimLimit.hit(req.wallet!)) return sendError(reply, 429, "too many deposit claims, slow down");
    if (!custody.rpc) return sendError(reply, 503, "deposit detection unavailable (no RPC configured)");
    let out;
    try {
      out = await custody.deposits.processSignature(p.data.signature);
    } catch (err) {
      req.log.warn({ err: redact((err as Error).message) }, "custody: deposit claim rpc failure");
      return sendError(reply, 503, "RPC unavailable, try again shortly");
    }
    if (out.kind === "not_found") {
      return reply.code(202).send({ id: p.data.signature, signature: p.data.signature, asset: "SOL", amount: 0, status: "detected", ts: Math.floor(Date.now() / 1000), reason: "not yet finalized (or not found); it will be picked up automatically" });
    }
    if (out.kind === "failed_tx") return sendError(reply, 400, "transaction failed on-chain");
    const mine = out.records.filter((r) => r.wallet === req.wallet);
    if (mine.length === 0) return sendError(reply, 404, "no deposit for your account in this transaction (check the memo)");
    return depositToDto(mine[0]!);
  });

  app.get("/api/account/withdrawals", { preHandler: requireAuth }, async (req) => ({
    withdrawals: (await custody.repo.listWithdrawalsByWallet(req.wallet!, 100)).map((w) => custody.withdrawals.dto(w)),
  }));

  app.post("/api/account/withdrawals", { bodyLimit: SMALL_BODY, preHandler: requireAuth }, async (req, reply) => {
    const p = WithdrawRequestSchema.safeParse(req.body ?? {});
    if (!p.success) return sendError(reply, 400, "invalid withdrawal request", zodDetails(p.error));
    if (!withdrawLimit.hit(req.wallet!)) return sendError(reply, 429, "too many withdrawal requests, slow down");
    try {
      const w = await custody.withdrawals.request(req.wallet!, p.data);
      return reply.code(201).send(custody.withdrawals.dto(w));
    } catch (e) {
      if (e instanceof CustodyError) return sendError(reply, e.statusCode, e.message);
      throw e;
    }
  });
}
