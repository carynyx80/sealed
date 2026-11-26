import type { FastifyBaseLogger } from "fastify";
import type { FeePayerHealth } from "@sealed/shared";
import type { AppConfig } from "../../config.js";
import { AuthService } from "../auth/siws.js";
import { ata, custodyAssets, type CustodyAsset } from "./chain.js";
import { loadCustodyConfig, type CustodyConfig } from "./config.js";
import { DepositService, DepositWatcher } from "./deposits.js";
import type { CustodyLedger } from "./ledgerPort.js";
import { FEE_PAYER_REASON, loadCompanySigner, PayoutWorker, type CompanySigner } from "./payout.js";
import { MemoryCustodyRepo, type CustodyRepo } from "./repo.js";
import { ReservesService } from "./reserves.js";
import { createPriceService, type PriceService } from "./prices.js";
import { HttpSolanaRpc, type SolanaRpc } from "./rpc.js";
import { WithdrawalService } from "./withdrawals.js";

export interface CustodyDeps {
  /** Override parsed custody env (tests). */
  config?: Partial<CustodyConfig>;
  env?: Record<string, string | undefined>;
  repo?: CustodyRepo;
  rpc?: SolanaRpc | null;
  ledger?: CustodyLedger | null;
  /** USD price source for withdrawal limits (tests: mocked). Default: live on mainnet, demo prices elsewhere. */
  prices?: PriceService;
}

export interface PayoutStatus {
  enabled: boolean;
  reason: string | null;
  feePayer?: FeePayerHealth;
}

export interface CustodyRuntime {
  config: CustodyConfig;
  repo: CustodyRepo;
  rpc: SolanaRpc | null;
  ledger: CustodyLedger | null;
  assets: CustodyAsset[];
  auth: AuthService;
  deposits: DepositService;
  withdrawals: WithdrawalService;
  reserves: ReservesService;
  signer: CompanySigner;
  watcher: DepositWatcher | null;
  payouts: PayoutWorker | null;
  prices: PriceService;
  /** Payouts usable right now: worker configured AND company wallet can pay fees (for /api/custody/info). */
  payoutStatus(): Promise<PayoutStatus>;
  /** Start background workers (deposit watcher + payout worker); returns a stop fn. */
  start(): () => void;
  close(): Promise<void>;
}

export async function buildCustody(app: AppConfig, ledger: CustodyLedger | null, log: FastifyBaseLogger, deps: CustodyDeps = {}): Promise<CustodyRuntime> {
  const config = loadCustodyConfig(app, deps.env ?? process.env, deps.config);
  let repo = deps.repo;
  if (!repo && app.databaseUrl) {
    try {
      const { PrismaCustodyRepo } = await import("./prismaRepo.js");
      const r = new PrismaCustodyRepo(app.databaseUrl);
      await r.init();
      repo = r;
    } catch (err) {
      log.error({ err: { message: (err as Error).message } }, "custody: postgres unavailable, using in-memory custody store (sessions/deposits will NOT persist)");
    }
  }
  repo ??= new MemoryCustodyRepo();
  const rpc = deps.rpc !== undefined ? deps.rpc : config.rpcUrl ? new HttpSolanaRpc(config.rpcUrl) : null;
  const ledgerPort = deps.ledger !== undefined ? deps.ledger : ledger;
  const assets = custodyAssets(config.network, deps.env ?? process.env);
  const signer = loadCompanySigner(config.companySecretKey, config.companyWallet, log);
  if (!signer.payoutsEnabled) log.warn({ reason: signer.reason }, "custody: payouts disabled");
  if (!config.adminToken) log.warn("custody: ADMIN_TOKEN not set — admin routes disabled");
  if (!rpc) log.warn("custody: no RPC configured (HELIUS_API_KEY / SOLANA_RPC_URL) — deposit detection and payouts disabled");
  if (!ledgerPort) log.warn("custody: offchain ledger unavailable — crediting/withdrawals disabled");

  if (config.network === "mainnet" && !config.adminToken) {
    log.error("custody: MAINNET without ADMIN_TOKEN — admin routes DISABLED and EVERY withdrawal will be held as pending_approval (no auto-payouts). Set ADMIN_TOKEN.");
  }
  if (config.network === "mainnet") {
    for (const k of Object.keys(deps.env ?? process.env)) {
      if (/^(NEXT_PUBLIC_)?QUOTE_MINT_.+_MAINNET$/.test(k)) log.warn({ envVar: k }, "custody: QUOTE_MINT_*_MAINNET overrides are ignored on mainnet (verified allowlist in @sealed/shared QUOTE_ASSET_MAINNET)");
    }
  }
  const prices = deps.prices ?? createPriceService(config.network, {
    jupiterPriceApiUrl: app.jupiterPriceApiUrl, jupiterApiKey: app.jupiterApiKey, heliusRpcUrl: config.rpcUrl, log,
  });
  if (prices.live) log.info("custody: withdrawal limits use LIVE USD prices (Jupiter Price API v3, Helius fallback); no fresh price → pending_approval");

  const auth = new AuthService(repo, config.siwsDomain);
  const deposits = new DepositService(config, repo, ledgerPort, rpc, assets, log);
  const withdrawals = new WithdrawalService(config, repo, ledgerPort, assets, log, undefined, prices);
  const reserves = new ReservesService(config, ledgerPort, rpc, assets, log);
  const addresses = [config.companyWallet, ...assets.filter((a) => a.mint).map((a) => ata(config.companyWallet, a.mint!).toBase58())];
  const watcher = rpc ? new DepositWatcher(deposits, rpc, addresses, config.depositPollMs, log) : null;
  const payouts = rpc && ledgerPort && signer.signer ? new PayoutWorker(repo, ledgerPort, rpc, signer.signer, assets, withdrawals, log) : null;

  return {
    config, repo, rpc, ledger: ledgerPort, assets, auth, deposits, withdrawals, reserves, signer, watcher, payouts, prices,
    async payoutStatus(): Promise<PayoutStatus> {
      if (!payouts) {
        const reason = signer.reason ?? (!rpc ? "no RPC configured (HELIUS_API_KEY / SOLANA_RPC_URL)" : !ledgerPort ? "ledger unavailable" : "payouts disabled");
        return { enabled: false, reason };
      }
      const h = await payouts.health();
      if (!h) return { enabled: false, reason: "company wallet balance unavailable (RPC)" };
      return h.ok ? { enabled: true, reason: null, feePayer: h } : { enabled: false, reason: FEE_PAYER_REASON, feePayer: h };
    },
    start() {
      const stops: Array<() => void> = [];
      if (watcher && ledgerPort) stops.push(watcher.start());
      if (payouts) stops.push(payouts.start(config.payoutPollMs));
      return () => stops.forEach((s) => s());
    },
    async close() {
      await repo!.close?.().catch(() => undefined);
    },
  };
}

export type { CustodyConfig } from "./config.js";
export type { CustodyLedger } from "./ledgerPort.js";
