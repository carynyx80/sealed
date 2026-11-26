import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import { INSTRUCTIONS, PROGRAM_ID, pdas, type InstructionName } from "@sealed/shared";

/**
 * Instruction builders for the `sealed_launchpad` Anchor program, built against the names in
 * @sealed/shared program.ts.
 *
 * IDL: injectable. Resolution order: `opts.idl` → `registerIdl()` → on-chain IDL account (`anchor idl init`).
 * The canonical file is programs/sealed-launchpad/idl/sealed_launchpad.json (written by the contracts build);
 * web apps can `import idl from ".../sealed_launchpad.json"` and pass it, or call `registerIdl(idl)` once.
 *
 * Accounts: every builder passes PDAs/ATAs explicitly through `accountsPartial` (with a few naming aliases so the
 * builder works whichever reasonable Rust account name the program uses); Anchor ≥0.30 ignores keys the IDL does
 * not declare and auto-resolves the rest (PDAs with IDL seeds, known programs, signer).
 */

/* ----------------------------------------------------------------------------------------- IDL registry */

let registeredIdl: Idl | null = null;

export function registerIdl(idl: Idl): void {
  registeredIdl = idl;
}

export function getRegisteredIdl(): Idl | null {
  return registeredIdl;
}

export class IdlUnavailableError extends Error {
  constructor(programId: string) {
    super(
      `sealed_launchpad IDL not available for ${programId}. Pass { idl } or call registerIdl(idl) ` +
        `(programs/sealed-launchpad/idl/sealed_launchpad.json), or publish it on-chain with \`anchor idl init\`.`,
    );
    this.name = "IdlUnavailableError";
  }
}

/** Wallet shape accepted by the client (wallet-adapter compatible). Only publicKey is needed to build ixs. */
export interface ClientWallet {
  publicKey: PublicKey;
  signTransaction?: <T extends Transaction>(tx: T) => Promise<T>;
  signAllTransactions?: <T extends Transaction>(txs: T[]) => Promise<T[]>;
}

export interface SealedClientOptions {
  connection: Connection;
  wallet?: ClientWallet | null;
  idl?: Idl | null;
  programId?: PublicKey | string;
  /** Try fetching the IDL from chain when none is injected/registered. Default true. */
  fetchOnChainIdl?: boolean;
}

const READONLY_WALLET = (pk: PublicKey) => ({
  publicKey: pk,
  signTransaction: async () => {
    throw new Error("read-only client wallet cannot sign");
  },
  signAllTransactions: async () => {
    throw new Error("read-only client wallet cannot sign");
  },
});

export async function resolveIdl(opts: SealedClientOptions): Promise<Idl> {
  const pid = new PublicKey(opts.programId ?? PROGRAM_ID);
  const base = opts.idl ?? registeredIdl;
  if (base) return { ...base, address: pid.toBase58() };
  if (opts.fetchOnChainIdl !== false) {
    const provider = new AnchorProvider(opts.connection, READONLY_WALLET(opts.wallet?.publicKey ?? PublicKey.default) as never, {
      commitment: "confirmed",
    });
    try {
      const onChain = await Program.fetchIdl(pid, provider);
      if (onChain) return { ...onChain, address: pid.toBase58() };
    } catch {
      /* fall through */
    }
  }
  throw new IdlUnavailableError(pid.toBase58());
}

/* ---------------------------------------------------------------------------------------- context types */

export interface LaunchKeys {
  /** Launch PDA (LaunchSummary.id). If omitted it is derived from tokenMint. */
  launch?: PublicKey | string;
  tokenMint: PublicKey | string;
  quoteMint: PublicKey | string;
  /** Token program owning the quote mint (Token-2022 for xStocks on mainnet). */
  quoteTokenProgram?: PublicKey;
}

interface Resolved {
  launch: PublicKey;
  tokenMint: PublicKey;
  quoteMint: PublicKey;
  quoteTokenProgram: PublicKey;
}

const pk = (k: PublicKey | string) => (typeof k === "string" ? new PublicKey(k) : k);
const bn = (v: bigint | number) => new BN(v.toString());

/** Fluent Anchor builder (typed loosely because the IDL is injected at runtime). */
interface LooseMethodBuilder {
  accountsPartial(a: Record<string, PublicKey>): LooseMethodBuilder;
  instruction(): Promise<TransactionInstruction>;
}

export class SealedLaunchpadClient {
  readonly programId: PublicKey;
  private constructor(
    readonly program: Program,
    readonly connection: Connection,
  ) {
    this.programId = program.programId;
  }

  static async create(opts: SealedClientOptions): Promise<SealedLaunchpadClient> {
    const idl = await resolveIdl(opts);
    return SealedLaunchpadClient.fromIdl(idl, opts);
  }

  /** Synchronous constructor when the IDL is in hand. */
  static fromIdl(idl: Idl, opts: Omit<SealedClientOptions, "idl">): SealedLaunchpadClient {
    const pid = new PublicKey(opts.programId ?? PROGRAM_ID);
    const wallet = opts.wallet?.signTransaction ? opts.wallet : READONLY_WALLET(opts.wallet?.publicKey ?? PublicKey.default);
    const provider = new AnchorProvider(opts.connection, wallet as never, { commitment: "confirmed" });
    const program = new Program({ ...idl, address: pid.toBase58() } as Idl, provider);
    for (const name of Object.keys(INSTRUCTIONS) as InstructionName[]) {
      if (!(name in program.methods)) {
        // Not fatal: lets the client run against a partial IDL during development.
        console.warn(`[sealed/defi] IDL missing instruction ${name}`);
      }
    }
    return new SealedLaunchpadClient(program, opts.connection);
  }

  private resolve(k: LaunchKeys): Resolved {
    const tokenMint = pk(k.tokenMint);
    return {
      tokenMint,
      quoteMint: pk(k.quoteMint),
      launch: k.launch ? pk(k.launch) : pdas.launch(tokenMint, this.programId)[0],
      quoteTokenProgram: k.quoteTokenProgram ?? TOKEN_PROGRAM_ID,
    };
  }

  private m(name: InstructionName, ...args: unknown[]): LooseMethodBuilder {
    const fn = (this.program.methods as unknown as Record<string, (...a: unknown[]) => LooseMethodBuilder>)[name];
    if (!fn) throw new Error(`IDL has no instruction "${name}"`);
    return fn(...args);
  }

  /** Common accounts for a launch, with naming aliases. */
  private launchAccounts(r: Resolved, user: PublicKey): Record<string, PublicKey> {
    const P = this.programId;
    const [protocol] = pdas.protocol(P);
    const [escrow] = pdas.escrow(r.launch, P);
    const [vault] = pdas.vault(r.launch, P);
    const [feeCollector] = pdas.feeCollector(r.launch, P);
    const [pool] = pdas.pool(r.launch, P);
    const [poolQuote] = pdas.poolQuote(r.launch, P);
    const [poolToken] = pdas.poolToken(r.launch, P);
    const [rewardsVault] = pdas.rewardsVault(r.launch, P);
    const [mintAuthority] = pdas.mintAuthority(r.launch, P);
    const [creditPool] = pdas.creditPool(r.quoteMint, P);
    const userQuote = getAssociatedTokenAddressSync(r.quoteMint, user, true, r.quoteTokenProgram);
    const userToken = getAssociatedTokenAddressSync(r.tokenMint, user, true, TOKEN_PROGRAM_ID);
    return {
      protocol, protocolConfig: protocol, config: protocol,
      launch: r.launch, launchAccount: r.launch,
      tokenMint: r.tokenMint, mint: r.tokenMint,
      quoteMint: r.quoteMint,
      escrow, escrowVault: escrow, bidEscrow: escrow,
      vault, buybackVault: vault,
      feeCollector,
      pool, poolQuote, poolQuoteVault: poolQuote, poolToken, poolTokenVault: poolToken,
      rewardsVault, mintAuthority, creditPool,
      tokenProgram: TOKEN_PROGRAM_ID,
      quoteTokenProgram: r.quoteTokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
      // user-side token accounts
      userQuote, userQuoteAccount: userQuote, userQuoteAta: userQuote,
      userToken, userTokenAccount: userToken, userTokenAta: userToken,
    };
  }

  /* --------------------------------------------------------------------------------------- bidding */

  async commitBidIx(k: LaunchKeys, bidder: PublicKey, commitment: Uint8Array, deposit: bigint): Promise<TransactionInstruction> {
    if (commitment.length !== 32) throw new Error("commitment must be 32 bytes");
    const r = this.resolve(k);
    const base = this.launchAccounts(r, bidder);
    const [bid] = pdas.bid(r.launch, bidder, this.programId);
    return this.m("commitBid", Array.from(commitment), bn(deposit))
      .accountsPartial({
        ...base,
        bidder, signer: bidder, payer: bidder,
        bid, sealedBid: bid,
        bidderQuote: base.userQuote!, bidderQuoteAccount: base.userQuote!, bidderQuoteAta: base.userQuote!, bidderTokenAccount: base.userQuote!,
      })
      .instruction();
  }

  /** `reveal_bid` is permissionless; `payer` defaults to the bidder (relayer passes its own key). */
  async revealBidIx(k: LaunchKeys, bidder: PublicKey, maxPrice: bigint, bidAmount: bigint, salt: Uint8Array, payer: PublicKey = bidder): Promise<TransactionInstruction> {
    const r = this.resolve(k);
    const [bid] = pdas.bid(r.launch, bidder, this.programId);
    return this.m("revealBid", bn(maxPrice), bn(bidAmount), Array.from(salt))
      .accountsPartial({ ...this.launchAccounts(r, bidder), bid, sealedBid: bid, bidder, revealer: payer, signer: payer, payer })
      .instruction();
  }

  async claimOrRefundIx(k: LaunchKeys, bidder: PublicKey, stake: boolean): Promise<TransactionInstruction> {
    const r = this.resolve(k);
    const base = this.launchAccounts(r, bidder);
    const [bid] = pdas.bid(r.launch, bidder, this.programId);
    const [position] = pdas.position(r.launch, bidder, this.programId);
    return this.m("claimOrRefund", stake)
      .accountsPartial({
        ...base, bid, sealedBid: bid, bidder, signer: bidder, payer: bidder, position, holderPosition: position,
        bidderQuote: base.userQuote!, bidderQuoteAccount: base.userQuote!, bidderQuoteAta: base.userQuote!,
        bidderToken: base.userToken!, bidderTokenAccount: base.userToken!, bidderTokenAta: base.userToken!,
      })
      .instruction();
  }

  /* --------------------------------------------------------------------------------- permissionless */

  async clearAuctionIx(k: LaunchKeys, caller: PublicKey): Promise<TransactionInstruction> {
    const r = this.resolve(k);
    return this.m("clearAuction").accountsPartial({ ...this.launchAccounts(r, caller), caller, signer: caller, payer: caller }).instruction();
  }

  async graduateIx(k: LaunchKeys, caller: PublicKey): Promise<TransactionInstruction> {
    const r = this.resolve(k);
    const base = this.launchAccounts(r, caller);
    return this.m("graduateAndOpenCredit")
      .accountsPartial({ ...base, caller, signer: caller, payer: caller })
      .instruction();
  }

  async executeBuybackDripIx(k: LaunchKeys, caller: PublicKey): Promise<TransactionInstruction> {
    const r = this.resolve(k);
    return this.m("executeBuybackDrip").accountsPartial({ ...this.launchAccounts(r, caller), caller, keeper: caller, signer: caller, payer: caller }).instruction();
  }

  async distributeFeesIx(k: LaunchKeys, caller: PublicKey, extra: Record<string, PublicKey> = {}): Promise<TransactionInstruction> {
    const r = this.resolve(k);
    return this.m("distributeFees")
      .accountsPartial({ ...this.launchAccounts(r, caller), caller, signer: caller, payer: caller, ...extra })
      .instruction();
  }

  /* ------------------------------------------------------------------------------------- trading */

  async swapIx(k: LaunchKeys, user: PublicKey, amountIn: bigint, minAmountOut: bigint, isBuy: boolean): Promise<TransactionInstruction> {
    const r = this.resolve(k);
    const [antiSnipe] = pdas.antiSnipe(r.launch, user, this.programId);
    return this.m("swap", bn(amountIn), bn(minAmountOut), isBuy)
      .accountsPartial({ ...this.launchAccounts(r, user), user, trader: user, signer: user, payer: user, antiSnipe, antiSnipeEntry: antiSnipe })
      .instruction();
  }

  async stakeIx(k: LaunchKeys, owner: PublicKey, amount: bigint): Promise<TransactionInstruction> {
    return this.positionIx("stake", k, owner, [bn(amount)]);
  }

  async unstakeIx(k: LaunchKeys, owner: PublicKey, amount: bigint): Promise<TransactionInstruction> {
    return this.positionIx("unstake", k, owner, [bn(amount)]);
  }

  async claimRewardsIx(k: LaunchKeys, owner: PublicKey): Promise<TransactionInstruction> {
    return this.positionIx("claimRewards", k, owner, []);
  }

  private async positionIx(name: "stake" | "unstake" | "claimRewards", k: LaunchKeys, owner: PublicKey, args: unknown[]): Promise<TransactionInstruction> {
    const r = this.resolve(k);
    const [position] = pdas.position(r.launch, owner, this.programId);
    const [antiSnipe] = pdas.antiSnipe(r.launch, owner, this.programId);
    return this.m(name, ...args)
      .accountsPartial({
        ...this.launchAccounts(r, owner),
        owner, holder: owner, signer: owner, payer: owner,
        position, holderPosition: position, antiSnipe, antiSnipeEntry: antiSnipe,
      })
      .instruction();
  }
}

/* ------------------------------------------------------------------------------------- tx helpers */

export function quoteTokenProgramId(kind: "spl-token" | "token-2022"): PublicKey {
  return kind === "token-2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/** Ensure `owner` has an ATA for `mint` (idempotent create). */
export function ensureAtaIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): { ata: PublicKey; ix: TransactionInstruction } {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  return { ata, ix: createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint, tokenProgram) };
}

/** When the quote asset is SOL (wSOL), wrap `lamports` into the owner's wSOL ATA before the program ix. */
export function wrapSolIxs(owner: PublicKey, lamports: bigint): TransactionInstruction[] {
  const { ata, ix } = ensureAtaIx(owner, owner, NATIVE_MINT);
  return [ix, SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports }), createSyncNativeInstruction(ata)];
}

/** Close the wSOL ATA back to native SOL after the program ix (e.g. after sells / refunds). */
export function unwrapSolIx(owner: PublicKey): TransactionInstruction {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
  return createCloseAccountInstruction(ata, owner, owner);
}

export const isWsol = (mint: PublicKey | string) => pk(mint).equals(NATIVE_MINT);

/** Assemble a legacy transaction ready for wallet-adapter `sendTransaction`. */
export async function buildTransaction(
  connection: Connection,
  feePayer: PublicKey,
  ixs: TransactionInstruction[],
  opts: { computeUnitLimit?: number; priorityMicroLamports?: number } = {},
): Promise<{ tx: Transaction; blockhash: string; lastValidBlockHeight: number }> {
  const pre: TransactionInstruction[] = [];
  if (opts.computeUnitLimit) pre.push(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit }));
  if (opts.priorityMicroLamports) pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.priorityMicroLamports }));
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight }).add(...pre, ...ixs);
  return { tx, blockhash, lastValidBlockHeight };
}

/** Map an Anchor/Program error to one of PROGRAM_ERRORS (for UX copy), or null. */
export function programErrorName(e: unknown): string | null {
  const err = e as { error?: { errorCode?: { code?: string } }; logs?: string[]; message?: string };
  if (err?.error?.errorCode?.code) return err.error.errorCode.code;
  const text = [err?.message ?? "", ...(err?.logs ?? [])].join("\n");
  const m = /Error Code: (\w+)/.exec(text);
  return m?.[1] ?? null;
}
