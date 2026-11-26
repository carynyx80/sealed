import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { QUOTE_ASSETS, QUOTE_ASSET_LIST, resolveQuoteMint, type Network, type QuoteAssetSymbol } from "@sealed/shared";

/** Program ids (classic SPL Token only — Token-2022 deposits are rejected). */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const MEMO_PROGRAM_IDS = ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"];
export const MEMO_PROGRAM_ID = new PublicKey(MEMO_PROGRAM_IDS[0]!);
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export function ata(owner: string | PublicKey, mint: string | PublicKey): PublicKey {
  const o = typeof owner === "string" ? new PublicKey(owner) : owner;
  const m = typeof mint === "string" ? new PublicKey(mint) : mint;
  return PublicKey.findProgramAddressSync([o.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), m.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

/** Quote assets that are depositable on this network: native SOL + every SPL asset with a resolved mint. */
export interface CustodyAsset {
  symbol: QuoteAssetSymbol;
  mint: string | null; // null = native SOL
  decimals: number;
  usdPrice: number;
}
export function custodyAssets(network: Network, env: Record<string, string | undefined> = process.env): CustodyAsset[] {
  const out: CustodyAsset[] = [];
  for (const q of QUOTE_ASSET_LIST) {
    if (q.kind === "native") {
      out.push({ symbol: q.symbol, mint: null, decimals: q.decimals, usdPrice: q.demoUsdPrice });
      continue;
    }
    const mint = resolveQuoteMint(q.symbol, network, env);
    if (mint) out.push({ symbol: q.symbol, mint, decimals: q.decimals, usdPrice: q.demoUsdPrice });
  }
  return out;
}

// ---------- amounts: BigInt atoms ----------
export function toAtoms(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("amount must be a finite non-negative number");
  // toFixed avoids exponent notation up to 1e21; truncate (never round up) beyond `decimals`.
  const s = amount.toFixed(Math.min(20, decimals + 2));
  const [int, frac = ""] = s.split(".");
  return BigInt(int!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}
export function fromAtoms(atoms: bigint, decimals: number): number {
  const neg = atoms < 0n;
  const a = neg ? -atoms : atoms;
  const base = 10n ** BigInt(decimals);
  const v = Number(a / base) + Number(a % base) / Number(base);
  return neg ? -v : v;
}
export const assetDecimals = (s: QuoteAssetSymbol) => QUOTE_ASSETS[s].decimals;

// ---------- instructions (hand-built; avoids an spl-token dependency) ----------
export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}
export function transferCheckedIx(source: PublicKey, mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint, decimals: number): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0); // TransferChecked
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}
export function memoIx(text: string, signer?: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: signer ? [{ pubkey: signer, isSigner: true, isWritable: false }] : [],
    data: Buffer.from(text, "utf8"),
  });
}

export function isValidDestination(s: string): boolean {
  try {
    const pk = new PublicKey(s);
    // Must be a canonical wallet (on-curve) address — not a PDA / token account / program.
    return pk.toBase58() === s && PublicKey.isOnCurve(pk.toBytes());
  } catch {
    return false;
  }
}
