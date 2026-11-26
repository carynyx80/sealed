import { DEPOSIT_MEMO_PREFIX, type QuoteAssetSymbol } from "@sealed/shared";
import { MEMO_PROGRAM_IDS, SYSTEM_PROGRAM, TOKEN_PROGRAM_ID, ata, type CustodyAsset } from "./chain.js";
import type { ParsedInstruction, ParsedTransaction } from "./rpc.js";

/**
 * Pure parser: jsonParsed transaction → inbound transfers into the company wallet (+ the deposit memo).
 * Each transfer is keyed by `${signature}:${ixIndex}` so a credit happens at most once per transfer.
 *
 * Accepted inbound transfers:
 *   - System Program `transfer` with destination == company wallet (native SOL, lamports)
 *   - SPL Token (classic) `transfer` / `transferChecked` whose destination token account is owned by the company
 *     wallet. The mint comes from `transferChecked.info.mint` or the destination's token balance entry.
 * Anything else into the wallet (Token-2022, unknown mint, missing/unknown memo) becomes a REJECTED candidate.
 */

export interface DepositCandidate {
  key: string;
  signature: string;
  ixIndex: string;
  sender: string | null;
  asset: QuoteAssetSymbol | null; // null when the mint is not a configured quote asset
  mint: string | null; // null for native SOL
  amountAtoms: bigint;
  depositRef: string | null; // parsed from `sealed:<ref>` memo
  memo: string | null;
  /** Reason this transfer can never be credited (wrong mint / bad memo / token-2022). Unknown ref is checked later. */
  reject: string | null;
  slot: number;
  blockTime: number | null;
}

export interface ParseResult {
  signature: string;
  failed: boolean;
  candidates: DepositCandidate[];
}

interface Located {
  ix: ParsedInstruction;
  index: string;
}

function allInstructions(tx: ParsedTransaction): Located[] {
  const out: Located[] = [];
  const top = tx.transaction.message.instructions ?? [];
  const inner = new Map<number, ParsedInstruction[]>();
  for (const g of tx.meta?.innerInstructions ?? []) inner.set(g.index, g.instructions);
  top.forEach((ix, i) => {
    out.push({ ix, index: String(i) });
    (inner.get(i) ?? []).forEach((iix, j) => out.push({ ix: iix, index: `${i}.${j}` }));
  });
  return out;
}

/** Memo text from a parsed SPL Memo instruction (jsonParsed gives the string directly in `parsed`). */
function memoText(ix: ParsedInstruction): string | null {
  if (!MEMO_PROGRAM_IDS.includes(ix.programId)) return null;
  if (typeof ix.parsed === "string") return ix.parsed;
  return null;
}

export function parseMemoRef(memo: string | null): string | null {
  if (!memo) return null;
  const m = memo.trim();
  if (!m.startsWith(DEPOSIT_MEMO_PREFIX)) return null;
  const ref = m.slice(DEPOSIT_MEMO_PREFIX.length).trim();
  return /^[a-z2-9]{6,32}$/.test(ref) ? ref : null;
}

type Info = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);

export function parseDepositTransaction(tx: ParsedTransaction, companyWallet: string, assets: CustodyAsset[]): ParseResult {
  const signature = tx.transaction.signatures[0]!;
  if (tx.meta?.err != null) return { signature, failed: true, candidates: [] };

  const ixs = allInstructions(tx);
  const memos = ixs.map((l) => memoText(l.ix)).filter((m): m is string => m != null);
  const sealedMemo = memos.find((m) => m.trim().startsWith(DEPOSIT_MEMO_PREFIX)) ?? null;
  const memo = sealedMemo ?? memos[0] ?? null;
  const depositRef = parseMemoRef(sealedMemo);

  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const tokenBalances = [...(tx.meta?.postTokenBalances ?? []), ...(tx.meta?.preTokenBalances ?? [])];
  const tokenInfo = (account: string) => {
    const idx = keys.indexOf(account);
    return idx < 0 ? undefined : tokenBalances.find((b) => b.accountIndex === idx);
  };
  const bySymbolMint = new Map(assets.filter((a) => a.mint).map((a) => [a.mint!, a] as const));
  const sol = assets.find((a) => a.mint === null);

  const candidates: DepositCandidate[] = [];
  const base = { signature, slot: tx.slot, blockTime: tx.blockTime ?? null, memo, depositRef };
  const memoReject = sealedMemo == null ? "missing sealed:<depositRef> memo" : depositRef == null ? "malformed deposit memo" : null;

  for (const { ix, index } of ixs) {
    const parsed = ix.parsed as { type?: string; info?: Info } | undefined;
    if (!parsed || typeof parsed !== "object" || !parsed.info) continue;
    const info = parsed.info;

    if (ix.programId === SYSTEM_PROGRAM && (parsed.type === "transfer" || parsed.type === "transferWithSeed")) {
      if (str(info.destination) !== companyWallet) continue;
      if (str(info.source) === companyWallet) continue; // self-transfer
      const lamports = BigInt(String(info.lamports ?? 0));
      if (lamports <= 0n) continue;
      candidates.push({
        ...base, key: `${signature}:${index}`, ixIndex: index, sender: str(info.source),
        asset: sol?.symbol ?? "SOL", mint: null, amountAtoms: lamports, reject: memoReject,
      });
      continue;
    }

    const isTokenProgram = ix.program === "spl-token" || ix.program === "spl-token-2022" || ix.programId === TOKEN_PROGRAM_ID.toBase58();
    if (!isTokenProgram || (parsed.type !== "transfer" && parsed.type !== "transferChecked")) continue;
    const dest = str(info.destination);
    if (!dest) continue;
    const destBal = tokenInfo(dest);
    const mint = str(info.mint) ?? destBal?.mint ?? null;
    const owner = destBal?.owner ?? null;
    // Destination must be a company-owned token account (owner from balances, or the canonical ATA).
    const companyOwned = owner === companyWallet || (mint != null && ata(companyWallet, mint).toBase58() === dest);
    if (!companyOwned) continue;
    const sourceOwner = str(info.authority) ?? str(info.multisigAuthority) ?? tokenInfo(str(info.source) ?? "")?.owner ?? null;
    if (sourceOwner === companyWallet) continue; // outgoing / internal move
    const amountRaw = parsed.type === "transferChecked" ? (info.tokenAmount as { amount?: string } | undefined)?.amount : info.amount;
    const amountAtoms = BigInt(String(amountRaw ?? 0));
    if (amountAtoms <= 0n) continue;
    const asset = mint ? bySymbolMint.get(mint) : undefined;
    let reject = memoReject;
    if (ix.programId !== TOKEN_PROGRAM_ID.toBase58()) reject = "token-2022 transfers are not supported";
    else if (!mint) reject = "could not resolve mint";
    else if (!asset) reject = `unsupported mint ${mint}`;
    candidates.push({
      ...base, key: `${signature}:${index}`, ixIndex: index, sender: sourceOwner,
      asset: asset?.symbol ?? null, mint, amountAtoms, reject,
    });
  }
  return { signature, failed: false, candidates };
}
