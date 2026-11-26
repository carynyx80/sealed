import type { FastifyBaseLogger } from "fastify";
import type { PrivacyAsset, PrivateDepositClaimResponse, PrivateDepositInfo, PrivateDepositRecord, QuoteAssetSymbol } from "@sealed/shared";
import type { AppConfig } from "../../config.js";
import { fromAtoms, toAtoms, type CustodyAsset } from "../custody/chain.js";
import { depositToDto } from "../custody/deposits.js";
import type { CustodyRuntime } from "../custody/index.js";
import { FEE_PAYER_RESERVE_LAMPORTS, PAYOUT_FEE_BUFFER_LAMPORTS, type PrivatePayoutHandler } from "../custody/payout.js";
import type { DepositRec, WithdrawalRec } from "../custody/repo.js";
import { redact } from "../custody/rpc.js";
import { loadPrivacyConfig, type PrivacyConfig } from "./config.js";
import type { HeliusSprPortOptions } from "./heliusSpr.js";
import {
  PRIVATE_DEPOSIT_KEY_PREFIX,
  SPR_SOL_MINT,
  shortErr,
  privateRecipientOf,
  type InboundNote,
  type RecipientCheck,
  type SignedPrivateTx,
  type SprPort,
} from "./port.js";

/** SOL the company wallet must hold (not owed to users) to submit its User Registry record (rent + fee). */
export const REGISTRATION_MIN_LAMPORTS = 5_000_000n;
const LAMPORTS = 1_000_000_000;
const PRIVACY_ASSETS: PrivacyAsset[] = ["SOL", "USDC"];

/** User-facing reasons (no env names, no internals). */
export const REASONS = {
  off: "Private deposits and withdrawals are turned off on this deployment.",
  unsupportedNetwork: "Privacy Rings are not available on this network.",
  demo: "Demo mode uses the simulated Privacy Ring (no real funds).",
  noIdentity: "Private deposits and withdrawals are not configured yet.",
  unavailable: "The Privacy Ring is currently unavailable on this network.",
  unregistered: "The company private address is not registered yet.",
  mismatch: "The company private address record does not match; private flows are paused.",
  payoutUnavailable: "Private payouts are temporarily unavailable; your withdrawal stays queued.",
  liquidity: "Private payout liquidity is being topped up; your withdrawal stays queued and is sent automatically.",
  recipient: "The recipient private address is not registered; contact support or cancel the withdrawal.",
} as const;

export interface PrivacyDeps {
  /** Override parsed privacy env (tests). */
  config?: Partial<PrivacyConfig>;
  env?: Record<string, string | undefined>;
  /** Inject the SDK boundary (tests: mock, no network). null forces "no identity". */
  port?: SprPort | null;
  /** Upstream fetch for the /api/privacy/spr passthrough (tests: mocked Helius). */
  fetch?: typeof fetch;
}

type Attribution = { wallet: string; depositRef: string | null } | { reject: string; depositRef: string | null };

/**
 * Custodial Helius Privacy Ring integration (docs/PRIVACY.md §7).
 *
 * Deposits: users send a confidential transfer (or a ring deposit) to the company's registered shielded owner. The
 * company wallet syncs its encrypted state with its own viewing key (`syncWallet`), and every inbound output is
 * attributed to a Sealed account and credited EXACTLY ONCE, keyed `spr:<signature>:<leafIndex>` (DepositRec.key +
 * ledger idempotency `dep:<key>`), only once the transaction is FINALIZED.
 *
 * Attribution (the SDK's transfer builders carry no memo — only `buildDepositTransaction({memo})` does):
 *   1. note memo == the user's depositRef ("<ref>" or "sealed:<ref>") → that user (unless a different Sealed account
 *      signed the transaction → rejected as conflicting);
 *   2. otherwise the transaction's Solana signers (public in the Default Ring) → exactly one Sealed account
 *      (users are keyed by their sign-in wallet) → that account;
 *   3. anything else (unknown ref, unknown sender, several accounts, unsupported asset, below minimum) is recorded as
 *      `rejected` for manual resolution and NEVER credited. Transactions signed by the company wallet itself (treasury
 *      top-ups, change of our own payouts) are internal and ignored.
 */
export class PrivacyRuntime {
  readonly config: PrivacyConfig;
  /** Upstream fetch used by the SPR passthrough route. */
  sprFetch: typeof fetch = (...args) => fetch(...args);
  private initialized = false;
  private initError: string | null = null;
  private probeOk = false;
  private probeReason: string | null = null;
  private reg: "registered" | "unregistered" | "mismatch" | null = null;
  private lastRefresh = 0;
  private refreshing: Promise<void> | null = null;
  private scanning: Promise<boolean> | null = null;
  private synced = false;
  /** Signatures seen on the ring but not finalized yet (claim → "detected"). */
  private detected = new Set<string>();
  /** Keys already final (credited / rejected) or internal signatures: skipped on later scans (memory only). */
  private done = new Set<string>();
  private registering = false;
  private autoRegisterAttempted = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly app: Pick<AppConfig, "network" | "heliusApiKey" | "isDemo">,
    private readonly custody: CustodyRuntime,
    private port: SprPort | null,
    private readonly log: FastifyBaseLogger,
    config: PrivacyConfig,
    private readonly now: () => number = Date.now,
    /** Real SDK port, constructed lazily in boot() so the SDK is never loaded while the flag is off. */
    private readonly sdkOptions: HeliusSprPortOptions | null = null,
  ) {
    this.config = config;
  }

  static create(app: AppConfig, custody: CustodyRuntime, log: FastifyBaseLogger, deps: PrivacyDeps = {}): PrivacyRuntime {
    const config = loadPrivacyConfig(app.network, deps.env ?? process.env, deps.config);
    let port: SprPort | null = null;
    let sdk: HeliusSprPortOptions | null = null;
    if (deps.port !== undefined) port = deps.port;
    else if (config.enabled && (app.network === "mainnet" || app.network === "devnet") && app.heliusApiKey && custody.signer.signer && custody.config.companySecretKey) {
      sdk = {
        network: app.network,
        solanaRpcUrl: `https://${app.network}.helius-rpc.com/?api-key=${encodeURIComponent(app.heliusApiKey)}`,
        indexerUrl: config.indexerUrl,
        proverUrl: config.proverUrl,
        companySecretKey: custody.config.companySecretKey,
        companyWallet: custody.config.companyWallet,
        priorityFeeLamports: config.priorityFeeLamports,
      };
    }
    const rt = new PrivacyRuntime(app, custody, port, log, config, Date.now, sdk);
    if (deps.fetch) rt.sprFetch = deps.fetch;
    return rt;
  }

  /* ------------------------------------------------------------------------------- availability */

  /** Reason the feature is unusable, or null when live. Never touches the network. */
  get reason(): string | null {
    if (!this.config.enabled) return REASONS.off;
    if (this.app.network !== "mainnet" && this.app.network !== "devnet") return REASONS.unsupportedNetwork;
    if (this.app.isDemo) return REASONS.demo;
    if ((!this.port && !this.sdkOptions) || !this.custody.ledger || !this.custody.rpc) return REASONS.noIdentity;
    if (!this.initialized) return this.initError ? REASONS.noIdentity : REASONS.unavailable;
    if (!this.probeOk) return REASONS.unavailable;
    if (this.reg === "mismatch") return REASONS.mismatch;
    if (this.reg !== "registered") return REASONS.unregistered;
    return null;
  }
  get enabled(): boolean {
    return this.reason === null;
  }
  /** Port usable for admin registration (identity derived, ring reachable) even before registration. */
  private get portReady(): boolean {
    return this.config.enabled && !!this.port && this.initialized;
  }

  /** Boot: derive the identity and probe the ring. Never spends; never throws. No-op when the flag is off. */
  async boot(): Promise<void> {
    if (!this.config.enabled) return;
    if (!this.port && this.sdkOptions) {
      try {
        const { HeliusSprPort } = await import("./heliusSpr.js");
        this.port = new HeliusSprPort(this.sdkOptions);
      } catch (e) {
        this.initError = shortErr(e);
        this.log.error({ err: redact(this.initError) }, "privacy: SDK failed to load — private flows disabled");
        return;
      }
    }
    if (this.reason === REASONS.unsupportedNetwork || this.reason === REASONS.demo || !this.port) {
      this.log.warn({ reason: this.reason }, "privacy: PRIVACY_RING_ENABLED but prerequisites missing (HELIUS_API_KEY, COMPANY_WALLET_SECRET_KEY, RPC, ledger) — private flows disabled");
      return;
    }
    try {
      await this.port.init();
      this.initialized = true;
      this.initError = null;
    } catch (e) {
      this.initError = shortErr(e);
      this.log.error({ err: redact(this.initError) }, "privacy: company shielded identity unavailable — private flows disabled");
      return;
    }
    await this.refresh();
  }

  /** Re-probe the ring + registration (single flight). */
  async refresh(): Promise<void> {
    if (!this.port || !this.initialized) return;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const p = await this.port!.probe();
          this.probeOk = p.ok;
          this.probeReason = p.ok ? null : p.reason ?? "probe failed";
          if (p.ok) this.reg = await this.port!.registration();
          if (p.ok && this.reg === "unregistered" && this.config.enabled && this.config.autoRegister && !this.autoRegisterAttempted) {
            this.autoRegisterAttempted = true; // at most once per process: never loops or retries spending
            void this.register().then((r) => this.log.info({ code: r.code, body: r.body }, "privacy: auto-registration result"));
          }
          if (!p.ok) this.log.warn({ network: this.app.network, reason: this.probeReason }, "privacy: ring unavailable on this network — private flows disabled (mainnet guard)");
          else if (this.reg !== "registered") this.log.warn({ registration: this.reg }, "privacy: company shielded address not registered — POST /api/admin/privacy/register");
        } catch (e) {
          this.probeOk = false;
          this.probeReason = shortErr(e);
          this.log.warn({ err: redact(this.probeReason) }, "privacy: availability check failed");
        } finally {
          this.lastRefresh = this.now();
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  maybeRefresh(): void {
    if (this.portReady && this.now() - this.lastRefresh > Math.min(this.config.reprobeMs, this.enabled ? this.config.reprobeMs : 60_000)) void this.refresh();
  }

  statusFields(): { enabled: boolean; simulated: false; companyShieldedAddress?: string; companyShieldedAddressBytes?: string; companyRegistered?: boolean; reason?: string } {
    const r = this.reason;
    const id = this.initialized && this.port ? this.port.companyIdentity() : null;
    return {
      enabled: r === null,
      simulated: false,
      ...(id ? { companyShieldedAddress: id.owner, companyShieldedAddressBytes: id.shieldedAddressBytes, companyRegistered: this.reg === "registered" } : {}),
      ...(r ? { reason: r } : {}),
    };
  }

  /** Operator-only detail (admin route): includes probe failures. */
  adminStatus() {
    return { ...this.statusFields(), probeOk: this.probeOk, probeReason: this.probeReason, registration: this.reg, initError: this.initError ? "identity unavailable" : null };
  }

  /* ------------------------------------------------------------------------------------ assets */

  assets(): CustodyAsset[] {
    return this.custody.assets.filter((a) => (PRIVACY_ASSETS as string[]).includes(a.symbol));
  }
  supports(symbol: QuoteAssetSymbol): boolean {
    return this.assets().some((a) => a.symbol === symbol);
  }
  private mintOf(a: CustodyAsset): string {
    return a.mint ?? SPR_SOL_MINT;
  }
  private assetOfMint(mint: string): CustodyAsset | null {
    return this.assets().find((a) => this.mintOf(a) === mint) ?? null;
  }
  /** Last synced company shielded holdings (atoms) for proof of reserves / fee surplus. 0 when unknown. */
  shieldedHoldings(symbol: string): bigint {
    if (!this.enabled || !this.synced || !this.port) return 0n;
    const a = this.assets().find((x) => x.symbol === symbol);
    return a ? this.port.balance(this.mintOf(a)) : 0n;
  }

  /* ---------------------------------------------------------------------------------- deposits */

  async depositInfo(wallet: string): Promise<PrivateDepositInfo> {
    const user = await this.custody.repo.ensureUser(wallet);
    const id = this.initialized && this.port ? this.port.companyIdentity() : null;
    const r = this.reason;
    const assets = this.assets().map((a) => a.symbol as PrivacyAsset);
    return {
      enabled: r === null,
      ...(r ? { reason: r } : {}),
      companyShieldedAddress: id?.owner ?? "",
      ...(id ? { companyShieldedAddressBytes: id.shieldedAddressBytes } : {}),
      reference: user.depositRef,
      assets,
      network: this.app.network,
      minAmount: { ...this.config.minAmount },
    };
  }

  async listDeposits(wallet: string): Promise<PrivateDepositRecord[]> {
    return (await this.custody.repo.listDepositsByWallet(wallet, 200)).filter((d) => d.key.startsWith(PRIVATE_DEPOSIT_KEY_PREFIX)).map(depositToDto);
  }

  /** One watcher pass (single flight): sync the company wallet and process every inbound note. */
  async scan(): Promise<boolean> {
    if (!this.enabled || !this.port) return false;
    if (!this.scanning) {
      this.scanning = (async () => {
        try {
          await this.port!.sync();
          this.synced = true;
          let ok = true;
          for (const n of this.port!.inbound()) {
            try {
              await this.processNote(n);
            } catch (e) {
              ok = false;
              this.log.warn({ signature: n.signature, err: redact(shortErr(e)) }, "privacy: private deposit processing failed (will retry)");
            }
          }
          return ok;
        } catch (e) {
          this.log.warn({ err: redact(shortErr(e)) }, "privacy: company wallet sync failed");
          return false;
        } finally {
          this.scanning = null;
        }
      })();
    }
    return this.scanning;
  }

  /** Exactly-once: insert-if-absent on `spr:<sig>:<leafIndex>`, then idempotent ledger credit (`dep:<key>`). */
  async processNote(n: InboundNote): Promise<DepositRec | null> {
    const repo = this.custody.repo;
    const key = `${PRIVATE_DEPOSIT_KEY_PREFIX}${n.signature}:${n.index.toString()}`;
    if (this.done.has(key) || this.done.has(`internal:${n.signature}`)) return null;
    const existing = await repo.getDeposit(key);
    if (existing) {
      const row = existing.status === "confirmed" ? await this.custody.deposits.creditRow(existing) : existing;
      if (row.status === "credited" || row.status === "rejected") this.done.add(key);
      return row;
    }
    const rpc = this.custody.rpc!;
    const tx = await rpc.getTransaction(n.signature, "finalized");
    if (!tx) {
      this.detected.add(n.signature); // seen on the ring, not finalized yet
      return null;
    }
    this.detected.delete(n.signature);
    if (tx.meta?.err != null) return null; // a failed tx carries no ring output; defensive
    const signers = tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey);
    if (signers.includes(this.custody.config.companyWallet)) {
      this.done.add(`internal:${n.signature}`); // internal (treasury top-up / change of our own payouts)
      return null;
    }

    const asset = this.assetOfMint(n.mint);
    const att = await this.attribute(n, signers);
    let reason: string | null = "reject" in att ? att.reject : null;
    if (!reason && !asset) reason = "unsupported private asset";
    if (!reason && asset) {
      const min = toAtoms(this.config.minAmount[asset.symbol as PrivacyAsset] ?? 0, asset.decimals);
      if (n.amount < min) reason = `below the minimum private deposit (${fromAtoms(min, asset.decimals)} ${asset.symbol})`;
    }
    if (n.amount <= 0n && !reason) reason = "empty output";
    const wallet = "wallet" in att ? att.wallet : null;
    const rec: DepositRec = {
      key, signature: n.signature, ixIndex: `${PRIVATE_DEPOSIT_KEY_PREFIX}${n.index.toString()}`,
      // A rejected row stays visible to the attributed owner (if any) so they can contact support.
      wallet, depositRef: att.depositRef,
      asset: (asset?.symbol ?? null) as QuoteAssetSymbol | null, mint: asset?.mint ?? (asset ? null : n.mint),
      amountAtoms: n.amount, sender: signers[0] ?? null,
      status: reason ? "rejected" : "confirmed", reason,
      slot: tx.slot, blockTime: tx.blockTime, createdAt: new Date(this.now()), creditedAt: null,
    };
    const inserted = await repo.insertDeposit(rec);
    const row = inserted ? rec : await repo.getDeposit(key);
    if (!row) return null;
    if (inserted && reason) this.log.warn({ signature: n.signature, index: n.index.toString(), reason }, "privacy: private deposit rejected (not credited, manual resolution)");
    const out = row.status === "confirmed" ? await this.custody.deposits.creditRow(row) : row;
    if (out.status === "credited" || out.status === "rejected") this.done.add(key);
    return out;
  }

  private async attribute(n: InboundNote, signers: string[]): Promise<Attribution> {
    const repo = this.custody.repo;
    const signerUsers = new Set<string>();
    for (const s of signers) if (await repo.getUser(s)) signerUsers.add(s);
    const memo = n.memo?.trim() || null;
    if (memo) {
      const ref = memo.startsWith("sealed:") ? memo.slice(7) : memo;
      const u = await repo.getUserByDepositRef(ref);
      if (!u) return { reject: `unknown deposit reference "${ref.slice(0, 40)}"`, depositRef: ref.slice(0, 40) };
      if (signerUsers.size > 0 && !signerUsers.has(u.wallet)) return { reject: "reference and sender belong to different accounts", depositRef: u.depositRef };
      return { wallet: u.wallet, depositRef: u.depositRef };
    }
    if (signerUsers.size === 1) {
      const w = [...signerUsers][0]!;
      return { wallet: w, depositRef: (await repo.getUser(w))?.depositRef ?? null };
    }
    if (signerUsers.size > 1) return { reject: "several Sealed accounts signed this transfer", depositRef: null };
    return { reject: "sender is not a Sealed account (send from your signed-in wallet)", depositRef: null };
  }

  /** POST /api/privacy/deposits/claim. Nudges a scan; never reveals another account's deposit. */
  async claim(wallet: string, signature: string): Promise<PrivateDepositClaimResponse> {
    const mine = async () => (await this.custody.repo.listDepositsBySignature(signature)).filter((d) => d.key.startsWith(PRIVATE_DEPOSIT_KEY_PREFIX));
    let rows = await mine();
    if (rows.length === 0 || rows.some((r) => r.status === "confirmed" || r.status === "detected")) {
      await this.scan();
      rows = await mine();
    }
    const own = rows.filter((r) => r.wallet === wallet);
    if (own.some((r) => r.status === "credited")) return { status: "credited" };
    if (own.length > 0) {
      const r = own[0]!;
      return r.status === "rejected" ? { status: "rejected", reason: r.reason ?? "not credited" } : { status: "pending", reason: "crediting in progress" };
    }
    if (rows.length > 0) return { status: "rejected", reason: "this transfer is not attributed to your account (contact support)" };
    if (this.detected.has(signature)) return { status: "detected", reason: "seen on the Privacy Ring; credited after finalization" };
    return { status: "pending", reason: "not found on the Privacy Ring yet; it is picked up automatically" };
  }

  /** Watcher loop (flag on + custody workers on). Re-probes availability; scans only while enabled. */
  start(): () => void {
    const loop = async () => {
      if (this.stopped) return;
      this.maybeRefresh();
      const ok = this.enabled ? await this.scan() : true;
      if (!this.stopped) this.timer = setTimeout(loop, ok ? this.config.pollMs : Math.min(this.config.pollMs * 4, 5 * 60_000));
    };
    this.timer = setTimeout(loop, 3_000);
    return () => {
      this.stopped = true;
      if (this.timer) clearTimeout(this.timer);
    };
  }

  /* ----------------------------------------------------------------------------------- payouts */

  async checkRecipient(privateTo: string): Promise<RecipientCheck> {
    if (!this.port || !this.enabled) return { ok: false, reason: this.reason ?? REASONS.payoutUnavailable };
    if (privateTo === this.custody.config.companyWallet || privateTo === this.port.companyIdentity().shieldedAddressBytes) {
      return { ok: false, reason: "privateTo cannot be the company address" };
    }
    return this.port.checkRecipient(privateTo);
  }

  /** The PayoutWorker branch for `privateTo` withdrawals. */
  payoutHandler(): PrivatePayoutHandler {
    return {
      costLamports: PAYOUT_FEE_BUFFER_LAMPORTS + (this.config.priorityFeeLamports ?? 0n),
      hold: async (w: WithdrawalRec, asset: CustodyAsset) => {
        if (!this.enabled || !this.port) return REASONS.payoutUnavailable;
        const to = privateRecipientOf(w.destination);
        if (!to) return REASONS.payoutUnavailable;
        const chk = await this.port.checkRecipient(to);
        if (!chk.ok) return REASONS.recipient;
        await this.port.sync(); // never build a spend before syncing past the previous one (SDK rule)
        this.synced = true;
        if (this.port.balance(this.mintOf(asset)) < w.amountAtoms) {
          this.log.error({ withdrawalId: w.id, asset: asset.symbol }, "privacy: company shielded balance below private payout amount — payout held (top up the shielded balance)");
          return REASONS.liquidity;
        }
        return null;
      },
      build: async (w: WithdrawalRec, asset: CustodyAsset): Promise<SignedPrivateTx> => {
        const to = privateRecipientOf(w.destination)!;
        try {
          return await this.port!.buildPrivatePayout({ recipient: to, mint: this.mintOf(asset), amount: w.amountAtoms });
        } catch (e) {
          this.port!.reset(); // drop any note reservation the failed build left behind
          throw e;
        }
      },
      settled: (outcome: "finalized" | "failed" | "expired" | "discarded") => {
        // Finalized: the next sync observes the spend. Otherwise the wallet may hold a stale reservation: rebuild.
        if (outcome !== "finalized") this.port?.reset();
      },
    };
  }

  /* -------------------------------------------------------------------------------- admin */

  /** POST /api/admin/privacy/register. Spends company SOL only on explicit admin request. */
  async register(): Promise<{ code: number; body: Record<string, unknown> }> {
    if (!this.config.enabled) return { code: 503, body: { enabled: false, reason: REASONS.off } };
    if (!this.portReady || !this.custody.rpc || !this.custody.ledger) return { code: 503, body: { enabled: false, reason: this.reason ?? REASONS.noIdentity } };
    if (this.registering) return { code: 409, body: { error: "registration already in progress" } };
    this.registering = true;
    try {
      const status = await this.port!.registration();
      this.reg = status;
      if (status === "registered") return { code: 200, body: { registered: true, alreadyRegistered: true } };
      if (status === "mismatch") return { code: 409, body: { error: "the company owner record holds other keys; it is never overwritten automatically" } };
      const company = this.custody.config.companyWallet;
      const [balance, solLiab] = await Promise.all([this.custody.rpc.getBalance(company, "confirmed"), this.custody.ledger.liabilities("SOL")]);
      const surplus = balance + this.shieldedHoldings("SOL") - solLiab;
      const required = REGISTRATION_MIN_LAMPORTS + FEE_PAYER_RESERVE_LAMPORTS;
      if (surplus < required) {
        return { code: 409, body: { error: "company wallet needs SOL (not owed to users) to register its private address", requiredSol: Number(required) / LAMPORTS, surplusSol: Number(surplus) / LAMPORTS } };
      }
      const signed = await this.port!.buildRegistration();
      if (!signed) {
        this.reg = "registered";
        return { code: 200, body: { registered: true, alreadyRegistered: true } };
      }
      await this.custody.rpc.sendRawTransaction(signed.rawTx);
      this.log.info({ signature: signed.signature }, "privacy: company registration submitted");
      this.lastRefresh = 0; // re-check soon
      return { code: 202, body: { registered: false, status: "submitted", signature: signed.signature } };
    } catch (e) {
      this.log.error({ err: redact(shortErr(e)) }, "privacy: registration failed");
      return { code: 502, body: { error: `registration failed: ${redact(shortErr(e))}` } };
    } finally {
      this.registering = false;
    }
  }
}
