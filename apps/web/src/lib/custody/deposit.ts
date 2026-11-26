"use client";
// Owned by web-offchain-agent. Builds the one-click deposit transaction the USER signs in their own wallet:
//   native SOL → SystemProgram.transfer(user → company wallet)
//   SPL       → idempotent create of the company wallet's ATA (user pays rent) + transferChecked(user ATA → company ATA)
// plus an SPL Memo instruction `sealed:<depositRef>` so the backend can attribute the deposit.
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { COMPANY_WALLET, DEPOSIT_MEMO_PREFIX, QUOTE_ASSETS, type DepositInstructions } from "@sealed/shared";
import { buildTransaction, uiToAtoms } from "@sealed/defi";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

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

export async function buildDepositTransaction(connection: Connection, user: PublicKey, ins: DepositInstructions, amountUi: number) {
  if (!(amountUi > 0)) throw new Error("Enter an amount to deposit");
  if (!ins.memo.startsWith(DEPOSIT_MEMO_PREFIX)) throw new Error("Deposit memo is malformed; refresh and try again");
  // The company wallet is pinned in the shared contract; never send to an address the server hands back otherwise.
  if (ins.companyWallet !== COMPANY_WALLET) throw new Error("Deposit address mismatch; refusing to build the transfer");
  const company = new PublicKey(ins.companyWallet);
  const decimals = QUOTE_ASSETS[ins.asset].decimals;
  const atoms = uiToAtoms(amountUi, decimals);
  const ixs: TransactionInstruction[] = [];

  if (!ins.mint) {
    ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: company, lamports: atoms }));
  } else {
    const mint = new PublicKey(ins.mint);
    const mintInfo = await connection.getAccountInfo(mint, "confirmed");
    if (!mintInfo) throw new Error(`${ins.asset} mint not found on this network`);
    const tokenProgram = mintInfo.owner ?? TOKEN_PROGRAM_ID;
    const src = getAssociatedTokenAddressSync(mint, user, true, tokenProgram);
    const dst = getAssociatedTokenAddressSync(mint, company, true, tokenProgram);
    const srcBal = await connection.getTokenAccountBalance(src, "confirmed").catch(() => null);
    if (!srcBal || BigInt(srcBal.value.amount) < atoms) throw new Error(`Not enough ${ins.asset} in your wallet`);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, dst, company, mint, tokenProgram));
    ixs.push(createTransferCheckedInstruction(src, mint, dst, user, atoms, decimals, [], tokenProgram));
  }
  ixs.push(memoIx(ins.memo, user));
  return buildTransaction(connection, user, ixs);
}
