import type { FastifyBaseLogger } from "fastify";
import { DEPOSIT_MEMO_PREFIX, QUOTE_ASSETS, type DepositInstructions, type DepositRecord, type QuoteAssetSymbol } from "@sealed/shared";
import { ata, fromAtoms, type CustodyAsset } from "./chain.js";
import type { CustodyConfig } from "./config.js";
import { parseDepositTransaction } from "./depositParser.js";
import type { CustodyLedger } from "./ledgerPort.js";
import type { CustodyRepo, DepositRec } from "./repo.js";
import { redact, type Commitment, type SolanaRpc } from "./rpc.js";

export type ProcessOutcome =
  | { kind: "not_found" } // not visible at the required commitment yet (or never existed)
  | { kind: "failed_tx" } // transaction failed on-chain: nothing to credit
  | { kind: "processed"; records: DepositRec[] };

export function depositToDto(d: DepositRec): DepositRecord {
  const decimals = d.asset ? assetDecimalsSafe(d.asset) : 0;
  return {
    id: d.key,
    signature: d.signature,
    asset: (d.asset ?? "UNKNOWN") as QuoteAssetSymbol, // unknown mint → reason explains
    amount: fromAtoms(d.amountAtoms, decimals),
    status: d.status,
    ts: d.blockTime ?? Math.floor(d.createdAt.getTime() / 1000),
    ...(d.reason ? { reason: d.reason } : {}),
  };
}
function assetDecimalsSafe(s: QuoteAssetSymbol) {
  return QUOTE_ASSETS[s]?.decimals ?? 0;
}

/**
 * Deposit detection + exactly-once crediting.
 *
 * Exactly-once: every inbound transfer is keyed `${signature}:${ixIndex}`. The row is inserted (insert-if-absent)
 * as `confirmed` BEFORE the ledger credit, and the credit uses idempotency key `dep:<key>`; a crash between the two
 * is healed by re-running the credit for `confirmed` rows (the ledger replays the same key as a no-op).
 * Rejected rows (unknown ref, wrong mint, missing memo, token-2022) are recorded and never credited.
 */
export class DepositService {
  constructor(
    private readonly cfg: CustodyConfig,
    private readonly repo: CustodyRepo,
    private readonly ledger: CustodyLedger | null,
    private readonly rpc: SolanaRpc | null,
    private readonly assets: CustodyAsset[],
    private readonly log: FastifyBaseLogger,
  ) {}

  get fetchCommitment(): Commitment {
    return this.cfg.depositConfirmations === "finalized" ? "finalized" : "confirmed";
  }

  instructions(asset: QuoteAssetSymbol, depositRef: string): DepositInstructions | null {
    const a = this.assets.find((x) => x.symbol === asset);
    if (!a) return null;
    const conf = this.cfg.depositConfirmations;
    return {
      companyWallet: this.cfg.companyWallet,
      memo: `${DEPOSIT_MEMO_PREFIX}${depositRef}`,
      asset,
      mint: a.mint,
      minConfirmations: conf === "finalized" ? 32 : conf,
      note:
        (a.mint
          ? `Send ${asset} (SPL mint ${a.mint}) to the company wallet ${this.cfg.companyWallet} (its associated token account ${ata(this.cfg.companyWallet, a.mint).toBase58()}).`
          : `Send native SOL to the company wallet ${this.cfg.companyWallet}.`) +
        ` The transaction MUST include an SPL Memo instruction with exactly "${DEPOSIT_MEMO_PREFIX}${depositRef}". ` +
        `Credited after ${conf === "finalized" ? "finalization" : `${conf} confirmations`}. Transfers without the memo, with another memo, or of other tokens are not credited.`,
    };
  }

  /** Fetch + parse + record + credit one signature. Throws only on RPC failure (caller decides retry). */
  async processSignature(signature: string): Promise<ProcessOutcome> {
    const existing = await this.repo.listDepositsBySignature(signature);
    if (existing.length > 0 && existing.every((d) => d.status === "credited" || d.status === "rejected")) {
      return { kind: "processed", records: existing };
    }
    if (!this.rpc) throw new Error("custody RPC not configured");
    const tx = await this.rpc.getTransaction(signature, this.fetchCommitment);
    if (!tx) return { kind: "not_found" };
    if (tx.transaction.signatures[0] !== signature) return { kind: "not_found" };

    let final = true;
    if (this.cfg.depositConfirmations !== "finalized") {
      const slot = await this.rpc.getSlot("confirmed");
      final = slot - tx.slot >= this.cfg.depositConfirmations;
    }
    const parsed = parseDepositTransaction(tx, this.cfg.companyWallet, this.assets);
    if (parsed.failed) return { kind: "failed_tx" };

    const records: DepositRec[] = [];
    for (const c of parsed.candidates) {
      let rec = await this.repo.getDeposit(c.key);
      if (!rec) {
        const user = c.depositRef ? await this.repo.getUserByDepositRef(c.depositRef) : null;
        const reason = c.reject ?? (user ? null : `unknown deposit reference "${c.depositRef}"`);
        const fresh: DepositRec = {
          key: c.key, signature, ixIndex: c.ixIndex, wallet: user?.wallet ?? null, depositRef: c.depositRef,
          asset: c.asset, mint: c.mint, amountAtoms: c.amountAtoms, sender: c.sender,
          status: reason ? "rejected" : final ? "confirmed" : "detected", reason,
          slot: c.slot, blockTime: c.blockTime, createdAt: new Date(), creditedAt: null,
        };
        const inserted = await this.repo.insertDeposit(fresh);
        rec = inserted ? fresh : await this.repo.getDeposit(c.key);
        if (!rec) continue;
        if (inserted && fresh.status === "rejected") this.log.warn({ signature, ix: c.ixIndex, reason }, "custody: deposit rejected (not credited)");
      }
      if (rec.status === "detected" && final) {
        await this.repo.updateDeposit(rec.key, { status: "confirmed" });
        rec = { ...rec, status: "confirmed" };
      }
      if (rec.status === "confirmed") rec = await this.creditRow(rec);
      records.push(rec);
    }
    return { kind: "processed", records };
  }

  /** Credit a confirmed row (idempotent). Leaves the row `confirmed` on ledger failure for a later retry. */
  async creditRow(rec: DepositRec): Promise<DepositRec> {
    if (rec.status !== "confirmed" || !rec.wallet || !rec.asset) return rec;
    if (!this.ledger) return rec;
    try {
      await this.ledger.credit(rec.wallet, rec.asset, rec.amountAtoms, `dep:${rec.key}`, {
        type: "deposit", signature: rec.signature, ix: rec.ixIndex, mint: rec.mint, sender: rec.sender,
      });
      const creditedAt = new Date();
      await this.repo.updateDeposit(rec.key, { status: "credited", creditedAt });
      this.log.info({ signature: rec.signature, ix: rec.ixIndex, asset: rec.asset, atoms: rec.amountAtoms.toString() }, "custody: deposit credited");
      return { ...rec, status: "credited", creditedAt };
    } catch (err) {
      this.log.error({ err: { message: (err as Error).message }, signature: rec.signature }, "custody: deposit credit failed (will retry)");
      return rec;
    }
  }

  /** Re-drive rows stuck in detected/confirmed (crash recovery, confirmation depth). */
  async retryPending(): Promise<void> {
    const pending = await this.repo.listDepositsByStatus(["detected", "confirmed"], 200);
    const sigs = [...new Set(pending.map((p) => p.signature))];
    for (const s of sigs) {
      try {
        await this.processSignature(s);
      } catch (err) {
        this.log.warn({ signature: s, err: redact((err as Error).message) }, "custody: pending deposit retry failed");
      }
    }
  }
}

/**
 * Polls getSignaturesForAddress on the company wallet and its ATA for each configured mint, oldest → newest,
 * and feeds each signature to DepositService. RPC failures back off exponentially; the worker never throws.
 * Cursors are in-memory: after a restart the last page is rescanned, which is safe (idempotent on key).
 */
export class DepositWatcher {
  private cursors = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private failures = 0;

  constructor(
    private readonly service: DepositService,
    private readonly rpc: SolanaRpc,
    private readonly addresses: string[],
    private readonly pollMs: number,
    private readonly log: FastifyBaseLogger,
    private readonly maxPages = 10,
  ) {}

  start(): () => void {
    const loop = async () => {
      if (this.stopped) return;
      const ok = await this.tick();
      this.failures = ok ? 0 : this.failures + 1;
      const delay = ok ? this.pollMs : Math.min(this.pollMs * 2 ** this.failures, 5 * 60_000);
      if (!this.stopped) this.timer = setTimeout(loop, delay);
    };
    this.timer = setTimeout(loop, 1_000);
    return () => {
      this.stopped = true;
      if (this.timer) clearTimeout(this.timer);
    };
  }

  /** One polling pass. Returns false if any RPC call failed. */
  async tick(): Promise<boolean> {
    if (this.running) return true;
    this.running = true;
    let ok = true;
    try {
      for (const addr of this.addresses) ok = (await this.scanAddress(addr)) && ok;
      await this.service.retryPending();
    } catch (err) {
      ok = false;
      this.log.warn({ err: redact((err as Error).message) }, "custody: deposit watcher tick failed");
    } finally {
      this.running = false;
    }
    return ok;
  }

  private async scanAddress(addr: string): Promise<boolean> {
    const until = this.cursors.get(addr);
    const sigs: { signature: string; err: unknown }[] = [];
    let before: string | undefined;
    try {
      for (let page = 0; page < this.maxPages; page++) {
        const res = await this.rpc.getSignaturesForAddress(addr, { limit: 100, before, until, commitment: this.service.fetchCommitment });
        sigs.push(...res);
        if (res.length < 100) break;
        before = res[res.length - 1]!.signature;
      }
    } catch (err) {
      this.log.warn({ address: addr, err: redact((err as Error).message) }, "custody: getSignaturesForAddress failed");
      return false;
    }
    // RPC returns newest first; process oldest first and advance the cursor only past successes.
    for (const s of sigs.reverse()) {
      if (s.err == null) {
        try {
          const r = await this.service.processSignature(s.signature);
          if (r.kind === "not_found") break; // not yet visible at our commitment — retry next tick
        } catch (err) {
          this.log.warn({ signature: s.signature, err: redact((err as Error).message) }, "custody: deposit processing failed");
          return false;
        }
      }
      this.cursors.set(addr, s.signature);
    }
    return true;
  }
}
