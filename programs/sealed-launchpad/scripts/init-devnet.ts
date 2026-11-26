/**
 * Devnet bootstrap for sealed_launchpad:
 *   1. initialize_protocol (idempotent)
 *   2. create mock quote mints: USDC (6 dp) + tokenized stocks NVDAx/TSLAx/TTWOx/AAPLx/SPYx (8 dp)
 *   3. create treasury / platform-ops ATAs for every quote mint (needed by claim_or_refund & distribute_fees)
 *   4. fund a CreditPool per quote mint (+ a small wrapped-SOL pool)
 *   5. write devnet-mints.json
 *
 * Env: ANCHOR_PROVIDER_URL (default devnet), ANCHOR_WALLET (default ~/.config/solana/id.json),
 *      TREASURY / PLATFORM_OPS / KEEPER (base58, default = wallet), MAX_CREDIT_PER_LAUNCH (atoms, default 10^15),
 *      WSOL_CREDIT_LAMPORTS (default 0.5 SOL; 0 disables).
 * Run: pnpm --filter @sealed/program init:devnet
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  createMint,
  createSyncNativeInstruction,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import idl from "../idl/sealed_launchpad.json";
import type { SealedLaunchpad } from "../target/types/sealed_launchpad";

const OUT = path.join(__dirname, "..", "devnet-mints.json");

const QUOTES: { symbol: string; name: string; decimals: number; credit: bigint }[] = [
  { symbol: "USDC", name: "Mock USD Coin", decimals: 6, credit: 1_000_000n * 10n ** 6n },
  { symbol: "NVDAx", name: "Mock NVIDIA xStock", decimals: 8, credit: 10_000n * 10n ** 8n },
  { symbol: "TSLAx", name: "Mock Tesla xStock", decimals: 8, credit: 10_000n * 10n ** 8n },
  { symbol: "TTWOx", name: "Mock Take-Two xStock", decimals: 8, credit: 10_000n * 10n ** 8n },
  { symbol: "AAPLx", name: "Mock Apple xStock", decimals: 8, credit: 10_000n * 10n ** 8n },
  { symbol: "SPYx", name: "Mock SPDR S&P 500 xStock", decimals: 8, credit: 10_000n * 10n ** 8n },
];

function loadKeypair(p: string): Keypair {
  const file = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const payer = loadKeypair(process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json");
  const conn = new Connection(url, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program<SealedLaunchpad>(idl as SealedLaunchpad, provider);
  const pid = program.programId;

  const treasury = new PublicKey(process.env.TREASURY ?? payer.publicKey.toBase58());
  const platformOps = new PublicKey(process.env.PLATFORM_OPS ?? payer.publicKey.toBase58());
  const keeper = new PublicKey(process.env.KEEPER ?? payer.publicKey.toBase58());
  const maxCredit = new BN(process.env.MAX_CREDIT_PER_LAUNCH ?? "1000000000000000");

  console.log(`program ${pid.toBase58()} on ${url}, payer ${payer.publicKey.toBase58()}`);

  const [protocol] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], pid);
  if (!(await conn.getAccountInfo(protocol))) {
    const sig = await program.methods
      .initializeProtocol(treasury, platformOps, keeper, false, maxCredit)
      .accountsPartial({ admin: payer.publicKey })
      .rpc();
    console.log("initialize_protocol", sig);
  } else {
    console.log("protocol already initialised:", protocol.toBase58());
  }

  const prev: any = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { mints: {} };
  const out: any = {
    network: url.includes("devnet") ? "devnet" : url,
    programId: pid.toBase58(),
    protocol: protocol.toBase58(),
    treasury: treasury.toBase58(),
    platformOps: platformOps.toBase58(),
    keeper: keeper.toBase58(),
    mints: {} as Record<string, unknown>,
  };

  const fund = async (mint: PublicKey, amount: bigint) => {
    const funderQuote = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey)).address;
    const [creditPool] = PublicKey.findProgramAddressSync([Buffer.from("credit_pool"), mint.toBuffer()], pid);
    const [creditVault] = PublicKey.findProgramAddressSync([Buffer.from("credit_vault"), mint.toBuffer()], pid);
    await program.methods
      .fundCreditPool(new BN(amount.toString()))
      .accountsPartial({ funder: payer.publicKey, quoteMint: mint, creditPool, creditVault, funderQuote })
      .rpc();
    // Treasury / ops ATAs must exist for claim_or_refund (slash) and distribute_fees.
    await getOrCreateAssociatedTokenAccount(conn, payer, mint, treasury, true);
    await getOrCreateAssociatedTokenAccount(conn, payer, mint, platformOps, true);
    return { creditPool: creditPool.toBase58(), creditVault: creditVault.toBase58() };
  };

  for (const q of QUOTES) {
    let mint: PublicKey;
    if (prev.mints?.[q.symbol]?.mint) {
      mint = new PublicKey(prev.mints[q.symbol].mint);
      console.log(`${q.symbol}: reusing ${mint.toBase58()}`);
    } else {
      mint = await createMint(conn, payer, payer.publicKey, null, q.decimals);
      console.log(`${q.symbol}: created ${mint.toBase58()}`);
    }
    const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
    await mintTo(conn, payer, mint, ata.address, payer, q.credit * 2n);
    const pools = await fund(mint, q.credit);
    out.mints[q.symbol] = { symbol: q.symbol, name: q.name, mint: mint.toBase58(), decimals: q.decimals, mintAuthority: payer.publicKey.toBase58(), ...pools };
  }

  const wsolLamports = BigInt(process.env.WSOL_CREDIT_LAMPORTS ?? String(LAMPORTS_PER_SOL / 2));
  if (wsolLamports > 0n) {
    const wata = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: wata.address, lamports: Number(wsolLamports) }),
        createSyncNativeInstruction(wata.address),
      ),
    );
    const pools = await fund(NATIVE_MINT, wsolLamports);
    out.mints.SOL = { symbol: "SOL", name: "Wrapped SOL", mint: NATIVE_MINT.toBase58(), decimals: 9, ...pools };
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
