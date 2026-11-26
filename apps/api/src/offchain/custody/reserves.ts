import type { FastifyBaseLogger } from "fastify";
import type { CustodyInfoResponse } from "@sealed/shared";
import { ata, fromAtoms, type CustodyAsset } from "./chain.js";
import type { CustodyConfig } from "./config.js";
import type { CustodyLedger } from "./ledgerPort.js";
import { redact, type SolanaRpc } from "./rpc.js";

export const RESERVES_TTL_MS = 30_000;
type Row = CustodyInfoResponse["proofOfReserves"][number];

/**
 * Proof of reserves: on-chain company wallet holdings (finalized) vs ledger liabilities per asset, cached 30s.
 * ratio = onchain / liabilities (1 when nothing is owed). On RPC failure the last good on-chain value is kept.
 */
export class ReservesService {
  private cache: { at: number; rows: Row[] } | null = null;
  private lastOnchain = new Map<string, bigint>();
  private inflight: Promise<Row[]> | null = null;
  /** Company holdings outside the public wallet (Privacy Ring shielded balance), added to `onchain`. */
  private extraHoldings: (symbol: string) => bigint = () => 0n;

  setExtraHoldings(fn: (symbol: string) => bigint): void {
    this.extraHoldings = fn;
    this.cache = null;
  }

  constructor(
    private readonly cfg: CustodyConfig,
    private readonly ledger: CustodyLedger | null,
    private readonly rpc: SolanaRpc | null,
    private readonly assets: CustodyAsset[],
    private readonly log: FastifyBaseLogger,
    private readonly now: () => number = Date.now,
  ) {}

  async proofOfReserves(): Promise<Row[]> {
    if (this.cache && this.now() - this.cache.at < RESERVES_TTL_MS) return this.cache.rows;
    if (!this.inflight) {
      this.inflight = this.compute()
        .then((rows) => {
          this.cache = { at: this.now(), rows };
          return rows;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private async compute(): Promise<Row[]> {
    const asOfTs = Math.floor(this.now() / 1000);
    return Promise.all(
      this.assets.map(async (a): Promise<Row> => {
        let onchain = this.lastOnchain.get(a.symbol) ?? 0n;
        if (this.rpc) {
          try {
            onchain = a.mint === null
              ? await this.rpc.getBalance(this.cfg.companyWallet, "finalized")
              : (await this.rpc.getTokenAccountBalance(ata(this.cfg.companyWallet, a.mint).toBase58(), "finalized")) ?? 0n;
            this.lastOnchain.set(a.symbol, onchain);
          } catch (err) {
            this.log.warn({ asset: a.symbol, err: redact((err as Error).message) }, "custody: reserves balance fetch failed (using last known)");
          }
        }
        let liab = 0n;
        if (this.ledger) {
          try {
            liab = await this.ledger.liabilities(a.symbol);
          } catch (err) {
            this.log.warn({ asset: a.symbol, err: (err as Error).message }, "custody: liabilities query failed");
          }
        }
        let extra = 0n;
        try {
          extra = this.extraHoldings(a.symbol);
        } catch {
          extra = 0n;
        }
        onchain += extra;
        const on = fromAtoms(onchain, a.decimals);
        const li = fromAtoms(liab, a.decimals);
        return { asset: a.symbol, onchain: on, liabilities: li, ratio: liab === 0n ? 1 : Number((onchain * 1_000_000n) / liab) / 1_000_000, asOfTs };
      }),
    );
  }
}
