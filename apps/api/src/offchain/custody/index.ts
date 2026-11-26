import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../../config.js";
import { AuthService } from "../auth/siws.js";
import { ata, custodyAssets, type CustodyAsset } from "./chain.js";
import { loadCustodyConfig, type CustodyConfig } from "./config.js";
import { DepositService, DepositWatcher } from "./deposits.js";
import type { CustodyLedger } from "./ledgerPort.js";
import { loadCompanySigner, PayoutWorker, type CompanySigner } from "./payout.js";
import { MemoryCustodyRepo, type CustodyRepo } from "./repo.js";
import { ReservesService } from "./reserves.js";
import { HttpSolanaRpc, type SolanaRpc } from "./rpc.js";
import { WithdrawalService } from "./withdrawals.js";

export interface CustodyDeps {
  /** Override parsed custody env (tests). */
  config?: Partial<CustodyConfig>;
  env?: Record<string, string | undefined>;
  repo?: CustodyRepo;
  rpc?: SolanaRpc | null;
  ledger?: CustodyLedger | null;
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

  const auth = new AuthService(repo, config.siwsDomain);
  const deposits = new DepositService(config, repo, ledgerPort, rpc, assets, log);
  const withdrawals = new WithdrawalService(config, repo, ledgerPort, assets, log);
  const reserves = new ReservesService(config, ledgerPort, rpc, assets, log);
  const addresses = [config.companyWallet, ...assets.filter((a) => a.mint).map((a) => ata(config.companyWallet, a.mint!).toBase58())];
  const watcher = rpc ? new DepositWatcher(deposits, rpc, addresses, config.depositPollMs, log) : null;
  const payouts = rpc && ledgerPort && signer.signer ? new PayoutWorker(repo, ledgerPort, rpc, signer.signer, assets, withdrawals, log) : null;

  return {
    config, repo, rpc, ledger: ledgerPort, assets, auth, deposits, withdrawals, reserves, signer, watcher, payouts,
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
