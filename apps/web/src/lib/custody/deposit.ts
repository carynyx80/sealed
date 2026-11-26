"use client";
// Owned by web-offchain-agent. Builds the one-click deposit transaction the USER signs in their own wallet:
//   native SOL → SystemProgram.transfer(user → company wallet)
//   SPL       → idempotent create of the company wallet's ATA (user pays rent only if it doesn't exist yet)
//               + transferChecked(user ATA → company ATA)
// plus an SPL Memo `sealed:<depositRef>` so the backend can attribute the deposit, and a ComputeBudget priority
// fee (median of getRecentPrioritizationFees, clamped). The transaction is simulated before the wallet is asked to
// sign, and confirmed by polling getSignatureStatuses (lib/solana/tx.ts).
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction, type Connection, type Transaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { COMPANY_WALLET, DEPOSIT_MEMO_PREFIX, QUOTE_ASSETS, type DepositInstructions } from "@sealed/shared";
import { buildTransaction, uiToAtoms } from "@sealed/defi";
import { IS_MAINNET } from "../config";
import { pinnedMainnetMint, quoteAssetOffered } from "../quoteAssets";
import { computeBudgetIxs, priorityFeeLamports, priorityFeeMicroLamports, simulateOrThrow } from "../solana/tx";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** CU limits: generous for the instruction set (transfer + memo, or ATA-create + transferChecked + memo). */
const CU_SOL = 30_000;
const CU_SPL = 80_000;
const BASE_FEE_LAMPORTS = 5_000;

export function memoIx(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: new TextEncoder().encode(memo) as unknown as Buffer,
  });
}

/** Solana Pay transfer-request URL (wallet apps scan it from the QR code). */
export function solanaPayUrl(ins: DepositInstructions, amount?: number): string {
  const p = new URLSearchParams();
  if (amount && amount > 0) p.set("amount", String(amount));
  if (ins.mint) p.set("spl-token", ins.mint);
  p.set("memo", ins.memo);
  p.set("label", "Sealed deposit");
  return `solana:${ins.companyWallet}?${p.toString()}`;
}

/** Everything the confirmation step shows before the wallet is asked to sign. */
export interface PreparedDeposit {
  tx: Transaction;
  lastValidBlockHeight: number;
  asset: DepositInstructions["asset"];
  amount: number;
  atoms: bigint;
  /** Owner wallet that receives the funds (always the pinned company wallet). */
  destination: string;
  /** Token account credited (SPL only). */
  destinationTokenAccount: string | null;
  mint: string | null;
  memo: string;
  /** Network fee estimate in SOL (base + priority). */
  feeSol: number;
  /** Rent the user pays to create the company's token account (SPL, first deposit of that asset only). */
  rentSol: number;
  priorityMicroLamports: number;
}

/** Validate the server's deposit instructions against the pinned contract; throws with a user-facing reason. */
export function assertSafeInstructions(ins: DepositInstructions) {
  if (!ins.memo.startsWith(DEPOSIT_MEMO_PREFIX) || ins.memo.length > 120) throw new Error("Deposit memo is malformed; refresh and try again");
  // The company wallet is pinned in the shared contract; never send to an address the server hands back otherwise.
  if (ins.companyWallet !== COMPANY_WALLET) throw new Error("Deposit address mismatch; refusing to build the transfer");
  if (!quoteAssetOffered(ins.asset)) throw new Error(`${ins.asset} deposits are not enabled on this network`);
  if (QUOTE_ASSETS[ins.asset].kind === "native") {
    if (ins.mint) throw new Error("Unexpected mint for a native SOL deposit");
  } else if (IS_MAINNET) {
    const pinned = pinnedMainnetMint(ins.asset);
    if (!pinned || ins.mint !== pinned) throw new Error(`${ins.asset} mint mismatch; refusing to build the transfer`);
  } else if (!ins.mint) {
    throw new Error(`${ins.asset} has no mint on this network`);
  }
}

export async function prepareDepositTransaction(connection: Connection, user: PublicKey, ins: DepositInstructions, amountUi: number): Promise<PreparedDeposit> {
  if (!(amountUi > 0)) throw new Error("Enter an amount to deposit");
  assertSafeInstructions(ins);
  const company = new PublicKey(ins.companyWallet);
  const decimals = QUOTE_ASSETS[ins.asset].decimals;
  const atoms = uiToAtoms(amountUi, decimals);
  if (atoms <= 0n) throw new Error("Amount is below the smallest unit");
  const ixs: TransactionInstruction[] = [];
  let dstAta: PublicKey | null = null;
  let rentLamports = 0;
  const units = ins.mint ? CU_SPL : CU_SOL;

  if (!ins.mint) {
    ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: company, lamports: atoms }));
  } else {
    const mint = new PublicKey(ins.mint);
    const mintInfo = await connection.getAccountInfo(mint, "confirmed");
    if (!mintInfo) throw new Error(`${ins.asset} mint not found on this network`);
    const tokenProgram = mintInfo.owner;
    if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !(tokenProgram.equals(TOKEN_2022_PROGRAM_ID) && !IS_MAINNET)) {
      throw new Error(`${ins.asset} uses an unsupported token program`);
    }
    const src = getAssociatedTokenAddressSync(mint, user, true, tokenProgram);
    dstAta = getAssociatedTokenAddressSync(mint, company, true, tokenProgram);
    const [srcBal, dstInfo] = await Promise.all([
      connection.getTokenAccountBalance(src, "confirmed").catch(() => null),
      connection.getAccountInfo(dstAta, "confirmed").catch(() => null),
    ]);
    if (!srcBal || BigInt(srcBal.value.amount) < atoms) throw new Error(`Not enough ${ins.asset} in your wallet`);
    if (!dstInfo) rentLamports = await connection.getMinimumBalanceForRentExemption(165).catch(() => 2_039_280);
    // Idempotent: a no-op when the company's token account already exists.
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, dstAta, company, mint, tokenProgram));
    ixs.push(createTransferCheckedInstruction(src, mint, dstAta, user, atoms, decimals, [], tokenProgram));
  }
  ixs.push(memoIx(ins.memo, user));

  const writable = dstAta ? [user, dstAta] : [user, company];
  const micro = await priorityFeeMicroLamports(connection, writable);
  const { tx, lastValidBlockHeight } = await buildTransaction(connection, user, [...computeBudgetIxs(units, micro), ...ixs]);
  const feeLamports = BASE_FEE_LAMPORTS + priorityFeeLamports(units, micro);

  // Native SOL: leave room for the fee so the wallet doesn't fail at signing time.
  if (!ins.mint) {
    const bal = await connection.getBalance(user, "confirmed").catch(() => null);
    if (bal !== null && BigInt(bal) < atoms + BigInt(feeLamports)) throw new Error("Not enough SOL in your wallet for this amount plus the network fee");
  } else {
    const bal = await connection.getBalance(user, "confirmed").catch(() => null);
    if (bal !== null && bal < feeLamports + rentLamports) throw new Error("Not enough SOL in your wallet to pay the network fee");
  }

  await simulateOrThrow(connection, tx);

  return {
    tx,
    lastValidBlockHeight,
    asset: ins.asset,
    amount: amountUi,
    atoms,
    destination: ins.companyWallet,
    destinationTokenAccount: dstAta?.toBase58() ?? null,
    mint: ins.mint,
    memo: ins.memo,
    feeSol: feeLamports / LAMPORTS_PER_SOL,
    rentSol: rentLamports / LAMPORTS_PER_SOL,
    priorityMicroLamports: micro,
  };
}

/** Back-compat wrapper (older callers): build + simulate, return the transaction. */
export async function buildDepositTransaction(connection: Connection, user: PublicKey, ins: DepositInstructions, amountUi: number) {
  const p = await prepareDepositTransaction(connection, user, ins, amountUi);
  return { tx: p.tx, blockhash: p.tx.recentBlockhash!, lastValidBlockHeight: p.lastValidBlockHeight };
}
