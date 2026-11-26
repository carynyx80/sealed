import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { FastifyBaseLogger } from "fastify";
import type { FeePayerHealth } from "@sealed/shared";
import { keypairFromSecret } from "../../services/solana.js";
import { ata, createAtaIdempotentIx, memoIx, transferCheckedIx, type CustodyAsset } from "./chain.js";
import type { CustodyLedger } from "./ledgerPort.js";
import type { CustodyRepo, WithdrawalRec } from "./repo.js";
import { redact, type SolanaRpc } from "./rpc.js";
import type { WithdrawalService } from "./withdrawals.js";

export const MAX_PAYOUT_ATTEMPTS = 3;

/** Network fee headroom per payout (1 signature = 5,000 lamports base; ×4 for safety). */
export const PAYOUT_FEE_BUFFER_LAMPORTS = 20_000n;
/** Rent for a recipient's associated token account (165 bytes) when the payout must create it. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;
/** Kept in the company wallet so it always stays rent-exempt (0-byte system account). */
export const FEE_PAYER_RESERVE_LAMPORTS = 890_880n;
export const FEE_PAYER_REASON = "company wallet needs SOL for fees";
export const FEE_HEALTH_TTL_MS = 30_000;
const LAMPORTS = 1_000_000_000;
/** Extra finalized blocks past lastValidBlockHeight before we treat an unlanded tx as dead (RPC-node skew). */
export const EXPIRY_MARGIN_BLOCKS = 32;

export interface CompanySigner {
  signer: Keypair | null;
  payoutsEnabled: boolean;
  reason: string | null;
}

/**
 * Load COMPANY_WALLET_SECRET_KEY and verify it controls COMPANY_WALLET. The key is never logged; on a mismatch or
 * parse failure payouts are refused and only the derived pubkey (public) is reported.
 */
export function loadCompanySigner(secret: string | undefined, companyWallet: string, log?: FastifyBaseLogger): CompanySigner {
  if (!secret) return { signer: null, payoutsEnabled: false, reason: "COMPANY_WALLET_SECRET_KEY not configured: withdrawals stay queued" };
  const kp = keypairFromSecret(secret);
  if (!kp) {
    log?.error("custody: COMPANY_WALLET_SECRET_KEY could not be parsed (expected base58 or JSON byte array) — payouts disabled");
    return { signer: null, payoutsEnabled: false, reason: "COMPANY_WALLET_SECRET_KEY invalid" };
  }
  if (kp.publicKey.toBase58() !== companyWallet) {
    log?.error({ derivedPubkey: kp.publicKey.toBase58(), companyWallet }, "custody: COMPANY_WALLET_SECRET_KEY does not match COMPANY_WALLET — payouts disabled");
    return { signer: null, payoutsEnabled: false, reason: "COMPANY_WALLET_SECRET_KEY does not match COMPANY_WALLET" };
  }
  return { signer: kp, payoutsEnabled: true, reason: null };
}

/** Build + sign the payout tx (SOL transfer, or create-ATA-idempotent + transferChecked) with a withdrawal memo. */
export function buildPayoutTx(w: WithdrawalRec, asset: CustodyAsset, signer: Keypair, blockhash: string, lastValidBlockHeight: number): Transaction {
  const company = signer.publicKey;
  const dest = new PublicKey(w.destination);
  const tx = new Transaction({ feePayer: company, blockhash, lastValidBlockHeight });
  if (asset.mint === null) {
    tx.add(SystemProgram.transfer({ fromPubkey: company, toPubkey: dest, lamports: w.amountAtoms }));
  } else {
    const mint = new PublicKey(asset.mint);
    tx.add(createAtaIdempotentIx(company, dest, mint));
    tx.add(transferCheckedIx(ata(company, mint), mint, ata(dest, mint), company, w.amountAtoms, asset.decimals));
  }
  tx.add(memoIx(`sealed:wd:${w.id}`, company));
  tx.sign(signer);
  return tx;
}

/**
 * Sends `queued` withdrawals from the company wallet. Never double-sends:
 *  1. build + sign with a fresh blockhash, then PERSIST {signature, rawTx, blockhash, lastValidBlockHeight} and move
 *     the row queued → sending (compare-and-set) BEFORE broadcasting;
 *  2. each tick reconciles `sending` rows by signature (getSignatureStatuses w/ history):
 *     finalized ok → settle ledger (user_locked → company_custody) + `sent`;  landed with error → `failed` + unlock;
 *     not found & blockhash still valid → rebroadcast the SAME signed bytes (same signature, idempotent);
 *     not found & blockhash expired (finalized height > lastValidBlockHeight) → it can never land: re-queue for a new
 *     attempt, or `failed` + unlock after MAX_PAYOUT_ATTEMPTS.
 */
export class PayoutWorker {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Lamports committed to fees/rent by sends earlier in the current tick (balance reads may lag broadcasts). */
  private tickSpend = 0n;
  private healthCache: { at: number; h: FeePayerHealth } | null = null;
  private healthInflight: Promise<FeePayerHealth | null> | null = null;

  constructor(
    private readonly repo: CustodyRepo,
    private readonly ledger: CustodyLedger,
    private readonly rpc: SolanaRpc,
    private readonly signer: Keypair,
    private readonly assets: CustodyAsset[],
    private readonly withdrawals: WithdrawalService,
    private readonly log: FastifyBaseLogger,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * SOL that is NOT owed to users (onchain SOL − SOL liabilities) must cover the payout's fee (+ recipient ATA rent
   * when it has to be created) while keeping the wallet rent-exempt; fees are never paid out of user funds.
   * Token payouts also need the company ATA to hold the amount. Returns a hold reason, or null to proceed.
   * Throws on RPC/ledger failure (the caller retries later; nothing is sent).
   */
  async payoutHold(w: WithdrawalRec, asset: CustodyAsset): Promise<{ reason: string | null; costLamports: bigint }> {
    const company = this.signer.publicKey.toBase58();
    let cost = PAYOUT_FEE_BUFFER_LAMPORTS;
    if (asset.mint !== null) {
      const destAta = ata(w.destination, asset.mint).toBase58();
      if (!(await this.rpc.getAccountExists(destAta, "confirmed"))) cost += TOKEN_ACCOUNT_RENT_LAMPORTS;
      const held = (await this.rpc.getTokenAccountBalance(ata(company, asset.mint).toBase58(), "confirmed")) ?? 0n;
      if (held < w.amountAtoms) return { reason: `company wallet ${asset.symbol} balance below payout amount`, costLamports: cost };
    }
    const [balance, solLiab] = await Promise.all([this.rpc.getBalance(company, "confirmed"), this.ledger.liabilities("SOL")]);
    const surplus = balance - solLiab;
    const required = cost + FEE_PAYER_RESERVE_LAMPORTS + this.tickSpend;
    if (surplus < required) {
      this.log.error(
        { withdrawalId: w.id, surplusSol: Number(surplus) / LAMPORTS, requiredSol: Number(required) / LAMPORTS },
        "custody: company wallet needs SOL for fees — payout held (fund the company wallet with SOL that is not owed to users)",
      );
      return { reason: FEE_PAYER_REASON, costLamports: cost };
    }
    return { reason: null, costLamports: cost };
  }

  /** Fee-payer health for /api/custody/info (cached 30s; last known value on RPC failure, null if never known). */
  async health(): Promise<FeePayerHealth | null> {
    if (this.healthCache && this.now() - this.healthCache.at < FEE_HEALTH_TTL_MS) return this.healthCache.h;
    if (!this.healthInflight) {
      this.healthInflight = (async () => {
        try {
          const [balance, solLiab] = await Promise.all([this.rpc.getBalance(this.signer.publicKey.toBase58(), "confirmed"), this.ledger.liabilities("SOL")]);
          const required = PAYOUT_FEE_BUFFER_LAMPORTS + TOKEN_ACCOUNT_RENT_LAMPORTS + FEE_PAYER_RESERVE_LAMPORTS;
          const surplus = balance - solLiab;
          const h: FeePayerHealth = {
            ok: surplus >= required,
            solBalance: Number(balance) / LAMPORTS,
            solLiabilities: Number(solLiab) / LAMPORTS,
            surplusSol: Number(surplus) / LAMPORTS,
            requiredSol: Number(required) / LAMPORTS,
            asOfTs: Math.floor(this.now() / 1000),
          };
          this.healthCache = { at: this.now(), h };
          return h;
        } catch (err) {
          this.log.warn({ err: redact((err as Error).message) }, "custody: fee-payer health check failed");
          return this.healthCache?.h ?? null;
        } finally {
          this.healthInflight = null;
        }
      })();
    }
    return this.healthInflight;
  }

  start(pollMs: number): () => void {
    let failures = 0;
    const loop = async () => {
      if (this.stopped) return;
      const ok = await this.tick();
      failures = ok ? 0 : failures + 1;
      if (!this.stopped) this.timer = setTimeout(loop, ok ? pollMs : Math.min(pollMs * 2 ** failures, 5 * 60_000));
    };
    this.timer = setTimeout(loop, 2_000);
    return () => {
      this.stopped = true;
      if (this.timer) clearTimeout(this.timer);
    };
  }

  async tick(): Promise<boolean> {
    if (this.running) return true;
    this.running = true;
    this.tickSpend = 0n;
    let ok = true;
    try {
      for (const w of await this.repo.listWithdrawalsByStatus(["sending"], 50)) ok = (await this.safe(() => this.reconcile(w), w)) && ok;
      for (const w of await this.repo.listWithdrawalsByStatus(["queued"], 10)) ok = (await this.safe(() => this.send(w), w)) && ok;
    } catch (err) {
      ok = false;
      this.log.warn({ err: redact((err as Error).message) }, "custody: payout tick failed");
    } finally {
      this.running = false;
    }
    return ok;
  }

  private async safe(fn: () => Promise<void>, w: WithdrawalRec): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      this.log.warn({ withdrawalId: w.id, err: redact((err as Error).message) }, "custody: payout step failed (will retry)");
      return false;
    }
  }

  async send(w: WithdrawalRec): Promise<void> {
    const asset = this.assets.find((a) => a.symbol === w.asset);
    if (!asset) {
      const f = await this.repo.transitionWithdrawal(w.id, ["queued"], { status: "failed", reason: "asset not configured on this network" });
      if (f) await this.withdrawals.release(f, "asset not configured");
      return;
    }
    // Fee-payer / balance health BEFORE signing anything: hold (stay queued, with a reason) instead of failing.
    const hold = await this.payoutHold(w, asset);
    if (hold.reason) {
      if (w.reason !== hold.reason) await this.repo.transitionWithdrawal(w.id, ["queued"], { reason: hold.reason });
      return;
    }
    const { blockhash, lastValidBlockHeight } = await this.rpc.getLatestBlockhash("confirmed");
    const tx = buildPayoutTx(w, asset, this.signer, blockhash, lastValidBlockHeight);
    const signature = bs58.encode(tx.signature!);
    const rawTx = tx.serialize().toString("base64");
    const claimed = await this.repo.transitionWithdrawal(w.id, ["queued"], {
      status: "sending", signature, rawTx, blockhash, lastValidBlockHeight, attempts: w.attempts + 1, reason: null,
    });
    if (!claimed) return; // rejected by admin / taken by another worker meanwhile
    this.tickSpend += hold.costLamports;
    this.log.info({ withdrawalId: w.id, signature, attempt: claimed.attempts }, "custody: payout broadcasting");
    try {
      await this.rpc.sendRawTransaction(rawTx);
    } catch (err) {
      // Ambiguous (may or may not have been forwarded): reconcile by signature decides, never a blind resend.
      this.log.warn({ withdrawalId: w.id, signature, err: redact((err as Error).message) }, "custody: payout send error (reconciling by signature)");
    }
  }

  async reconcile(w: WithdrawalRec): Promise<void> {
    if (!w.signature || !w.rawTx || w.lastValidBlockHeight == null) {
      // Should not happen (persisted atomically with the status) — treat as never broadcast.
      await this.repo.transitionWithdrawal(w.id, ["sending"], { status: "queued", signature: null, rawTx: null, blockhash: null, lastValidBlockHeight: null });
      return;
    }
    const [st] = await this.rpc.getSignatureStatuses([w.signature]);
    if (st) {
      if (st.err != null) {
        const f = await this.repo.transitionWithdrawal(w.id, ["sending"], { status: "failed", reason: `transaction failed on-chain: ${JSON.stringify(st.err).slice(0, 160)}` });
        if (f) await this.withdrawals.release(f, "payout failed on-chain");
        this.log.error({ withdrawalId: w.id, signature: w.signature }, "custody: payout failed on-chain, funds unlocked");
        return;
      }
      if (st.confirmationStatus === "finalized") {
        await this.ledger.settleWithdrawal(w.wallet, w.asset, w.amountAtoms, `wd:${w.id}:settle`, {
          type: "withdrawal_settle", withdrawalId: w.id, signature: w.signature, destination: w.destination,
        });
        await this.repo.transitionWithdrawal(w.id, ["sending"], { status: "sent", sentAt: new Date() });
        this.log.info({ withdrawalId: w.id, signature: w.signature }, "custody: payout finalized");
      }
      return; // processed/confirmed: wait for finality
    }
    const height = await this.rpc.getBlockHeight("finalized");
    if (height <= w.lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS) {
      await this.rpc.sendRawTransaction(w.rawTx).catch(() => undefined); // same bytes → same signature
      return;
    }
    // Blockhash expired and the signature never landed: this exact tx can never execute.
    if (w.attempts >= MAX_PAYOUT_ATTEMPTS) {
      const f = await this.repo.transitionWithdrawal(w.id, ["sending"], { status: "failed", reason: `not landed after ${w.attempts} attempts` });
      if (f) await this.withdrawals.release(f, "payout expired");
      this.log.error({ withdrawalId: w.id }, "custody: payout expired after max attempts, funds unlocked");
      return;
    }
    await this.repo.transitionWithdrawal(w.id, ["sending"], { status: "queued", signature: null, rawTx: null, blockhash: null, lastValidBlockHeight: null });
    this.log.warn({ withdrawalId: w.id, attempt: w.attempts }, "custody: payout blockhash expired unlanded — re-queued");
  }
}
