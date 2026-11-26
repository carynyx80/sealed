import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  createMint,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import * as fs from "fs";
import { createHash } from "crypto";
import * as path from "path";
import { computeClearing, computeCommitment, pdas, settleBid, splitFees } from "@sealed/shared";
import type { SealedLaunchpad } from "../target/types/sealed_launchpad";

const U = 1_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bn = (v: bigint | number) => new BN(v.toString());
const big = (v: BN | number | bigint) => BigInt(v.toString());
const st = (la: { status: object }) => Object.keys(la.status)[0];

describe("sealed-launchpad", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SealedLaunchpad as Program<SealedLaunchpad>;
  const conn = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const pid = program.programId;

  const treasury = Keypair.generate();
  const platformOps = Keypair.generate();
  const keeper = Keypair.generate();
  let quoteMint: PublicKey;
  let treasuryQuote: PublicKey;
  let opsQuote: PublicKey;

  // ---------------------------------------------------------------- helpers
  async function chainNow(): Promise<number> {
    const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "processed");
    return Number(info!.data.readBigInt64LE(32));
  }
  async function waitUntilChain(ts: number) {
    while ((await chainNow()) < ts) await sleep(400);
  }
  async function airdrop(pk: PublicKey, sol = 10) {
    const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    const bh = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  }
  async function fundedUser(quoteAtoms: bigint): Promise<{ kp: Keypair; quote: PublicKey }> {
    const kp = Keypair.generate();
    await airdrop(kp.publicKey);
    const ata = await getOrCreateAssociatedTokenAccount(conn, admin, quoteMint, kp.publicKey);
    if (quoteAtoms > 0n) await mintTo(conn, admin, quoteMint, ata.address, admin, quoteAtoms);
    return { kp, quote: ata.address };
  }
  async function expectErr(p: Promise<unknown>, code: string) {
    try {
      await p;
    } catch (e: any) {
      const s = `${e?.error?.errorCode?.code ?? ""} ${String(e)} ${(e?.logs ?? e?.transactionLogs ?? []).join("\n")}`;
      expect(s, s).to.include(code);
      return;
    }
    expect.fail(`expected error ${code}`);
  }
  async function balance(ta: PublicKey): Promise<bigint> {
    return (await getAccount(conn, ta)).amount;
  }

  interface LaunchCtx {
    mint: Keypair;
    launch: PublicKey;
    creator: Keypair;
    escrow: PublicKey;
    stakeVault: PublicKey;
    rewardsVault: PublicKey;
    pool: PublicKey;
    poolQuote: PublicKey;
    poolToken: PublicKey;
    vault: PublicKey;
    feeCollector: PublicKey;
    mintAuthority: PublicKey;
  }

  function launchPdas(mint: PublicKey) {
    const [launch] = pdas.launch(mint, pid);
    return {
      launch,
      escrow: PublicKey.findProgramAddressSync([Buffer.from("escrow"), launch.toBuffer()], pid)[0],
      stakeVault: PublicKey.findProgramAddressSync([Buffer.from("stake_vault"), launch.toBuffer()], pid)[0],
      rewardsVault: pdas.rewardsVault(launch, pid)[0],
      pool: pdas.pool(launch, pid)[0],
      poolQuote: pdas.poolQuote(launch, pid)[0],
      poolToken: pdas.poolToken(launch, pid)[0],
      vault: pdas.vault(launch, pid)[0],
      feeCollector: pdas.feeCollector(launch, pid)[0],
      mintAuthority: pdas.mintAuthority(launch, pid)[0],
    };
  }

  const creditPool = () => pdas.creditPool(quoteMint, pid)[0];
  const creditVault = () => PublicKey.findProgramAddressSync([Buffer.from("credit_vault"), quoteMint.toBuffer()], pid)[0];

  interface LaunchParams {
    creatorBps?: number;
    commitSec?: number;
    revealSec?: number;
    dripSec?: number;
    dripCount?: number;
  }

  function createLaunchIx(creator: Keypair, mint: Keypair, p: LaunchParams = {}) {
    const lp = launchPdas(mint.publicKey);
    return program.methods
      .createLaunch(
        "Sealed Test",
        "SEAL",
        "https://example.invalid/seal.json",
        bn(2_000n * U), // total supply: 2000 whole tokens
        p.creatorBps ?? 200,
        5_000, // 50% for sale ⇒ S = 1000 tokens (clearing vector A)
        1_000, // credit 10%
        bn(p.commitSec ?? 10),
        bn(p.revealSec ?? 8),
        bn(100), // floor
        bn(10), // tick
        bn(100_000), // target raise
        bn(10_000_000), // clearing cap
        bn(p.dripSec ?? 8),
        p.dripCount ?? 3,
      )
      .accountsPartial({
        creator: creator.publicKey,
        tokenMint: mint.publicKey,
        quoteMint,
        launch: lp.launch,
        mintAuthority: lp.mintAuthority,
        escrow: lp.escrow,
        stakeVault: lp.stakeVault,
        rewardsVault: lp.rewardsVault,
        creatorToken: getAssociatedTokenAddressSync(mint.publicKey, creator.publicKey),
      })
      .signers([creator, mint]);
  }

  async function createLaunch(p: LaunchParams = {}): Promise<LaunchCtx> {
    const creator = Keypair.generate();
    await airdrop(creator.publicKey);
    const mint = Keypair.generate();
    await createLaunchIx(creator, mint, p).rpc();
    return { mint, creator, ...launchPdas(mint.publicKey) };
  }

  interface Bidder {
    kp: Keypair;
    quote: PublicKey;
    maxPrice: bigint;
    amount: bigint;
    deposit: bigint;
    salt: Uint8Array;
  }

  async function commit(l: LaunchCtx, b: Bidder) {
    const c = computeCommitment({ bidder: b.kp.publicKey, maxPrice: b.maxPrice, bidAmount: b.amount, salt: b.salt });
    await program.methods
      .commitBid(Array.from(c), bn(b.deposit))
      .accountsPartial({
        bidder: b.kp.publicKey,
        launch: l.launch,
        bid: pdas.bid(l.launch, b.kp.publicKey, pid)[0],
        escrow: l.escrow,
        bidderQuote: b.quote,
      })
      .signers([b.kp])
      .rpc();
  }

  function reveal(l: LaunchCtx, b: Bidder, salt = b.salt, revealer: Keypair = admin) {
    return program.methods
      .revealBid(bn(b.maxPrice), bn(b.amount), Array.from(salt))
      .accountsPartial({
        payer: revealer.publicKey,
        launch: l.launch,
        bidder: b.kp.publicKey,
        bid: pdas.bid(l.launch, b.kp.publicKey, pid)[0],
      })
      .signers(revealer === admin ? [] : [revealer])
      .rpc();
  }

  function claim(l: LaunchCtx, b: { kp: Keypair; quote: PublicKey }, stake = false) {
    return program.methods
      .claimOrRefund(stake)
      .accountsPartial({
        bidder: b.kp.publicKey,
        launch: l.launch,
        bid: pdas.bid(l.launch, b.kp.publicKey, pid)[0],
        tokenMint: l.mint.publicKey,
        mintAuthority: l.mintAuthority,
        escrow: l.escrow,
        bidderQuote: b.quote,
        bidderToken: getAssociatedTokenAddressSync(l.mint.publicKey, b.kp.publicKey),
        treasuryQuote,
        position: pdas.position(l.launch, b.kp.publicKey, pid)[0],
        stakeVault: l.stakeVault,
        antiSnipe: pdas.antiSnipe(l.launch, b.kp.publicKey, pid)[0],
      })
      .signers([b.kp])
      .rpc();
  }

  function graduateIx(l: LaunchCtx, cranker: PublicKey) {
    return program.methods.graduateAndOpenCredit().accountsPartial({
      cranker,
      launch: l.launch,
      tokenMint: l.mint.publicKey,
      mintAuthority: l.mintAuthority,
      quoteMint,
      escrow: l.escrow,
      pool: l.pool,
      poolQuote: l.poolQuote,
      poolToken: l.poolToken,
      buybackVault: l.vault,
      feeCollector: l.feeCollector,
      creditPool: creditPool(),
      creditVault: creditVault(),
    });
  }

  function swapIx(l: LaunchCtx, u: { kp: Keypair; quote: PublicKey }, amountIn: bigint, minOut: bigint, isBuy: boolean) {
    return program.methods
      .swap(bn(amountIn), bn(minOut), isBuy)
      .accountsPartial({
        user: u.kp.publicKey,
        launch: l.launch,
        tokenMint: l.mint.publicKey,
        pool: l.pool,
        poolQuote: l.poolQuote,
        poolToken: l.poolToken,
        feeCollector: l.feeCollector,
        userQuote: u.quote,
        userToken: getAssociatedTokenAddressSync(l.mint.publicKey, u.kp.publicKey),
        antiSnipe: pdas.antiSnipe(l.launch, u.kp.publicKey, pid)[0],
      })
      .signers([u.kp]);
  }

  function stakeIx(l: LaunchCtx, u: { kp: Keypair }, amount: bigint) {
    return program.methods
      .stake(bn(amount))
      .accountsPartial({
        owner: u.kp.publicKey,
        launch: l.launch,
        position: pdas.position(l.launch, u.kp.publicKey, pid)[0],
        stakeVault: l.stakeVault,
        ownerToken: getAssociatedTokenAddressSync(l.mint.publicKey, u.kp.publicKey),
        antiSnipe: pdas.antiSnipe(l.launch, u.kp.publicKey, pid)[0],
      })
      .signers([u.kp]);
  }

  function distributeIx(l: LaunchCtx) {
    return program.methods.distributeFees().accountsPartial({
      cranker: admin.publicKey,
      launch: l.launch,
      creditPool: creditPool(),
      creditVault: creditVault(),
      feeCollector: l.feeCollector,
      rewardsVault: l.rewardsVault,
      platformOpsQuote: opsQuote,
      treasuryQuote,
    });
  }

  function dripIx(l: LaunchCtx) {
    return program.methods.executeBuybackDrip().accountsPartial({
      cranker: admin.publicKey,
      launch: l.launch,
      tokenMint: l.mint.publicKey,
      pool: l.pool,
      poolQuote: l.poolQuote,
      poolToken: l.poolToken,
      buybackVault: l.vault,
    });
  }

  // ---------------------------------------------------------------- setup
  before(async () => {
    quoteMint = await createMint(conn, admin, admin.publicKey, null, 6);
    treasuryQuote = (await getOrCreateAssociatedTokenAccount(conn, admin, quoteMint, treasury.publicKey)).address;
    opsQuote = (await getOrCreateAssociatedTokenAccount(conn, admin, quoteMint, platformOps.publicKey)).address;

    await program.methods
      .initializeProtocol(treasury.publicKey, platformOps.publicKey, keeper.publicKey, false, bn(1_000_000_000_000n))
      .accountsPartial({ admin: admin.publicKey })
      .rpc();

    const adminQuote = (await getOrCreateAssociatedTokenAccount(conn, admin, quoteMint, admin.publicKey)).address;
    await mintTo(conn, admin, quoteMint, adminQuote, admin, 10_000_000_000n);
    await program.methods
      .fundCreditPool(bn(5_000_000_000n))
      .accountsPartial({
        funder: admin.publicKey,
        quoteMint,
        creditPool: creditPool(),
        creditVault: creditVault(),
        funderQuote: adminQuote,
      })
      .rpc();
    const cp = await program.account.creditPool.fetch(creditPool());
    expect(big(cp.totalDeposited)).to.equal(5_000_000_000n);
  });

  // ---------------------------------------------------------------- IDL / guards
  it("exposes exactly the contract instructions — no vault withdraw path", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "sealed_launchpad.json"), "utf8"));
    const names: string[] = raw.instructions.map((i: { name: string }) => i.name).sort();
    expect(names).to.deep.equal(
      [
        "claim_or_refund",
        "claim_rewards",
        "clear_auction",
        "commit_bid",
        "create_launch",
        "distribute_fees",
        "execute_buyback_drip",
        "fund_credit_pool",
        "graduate_and_open_credit",
        "initialize_protocol",
        "reveal_bid",
        "stake",
        "swap",
        "unstake",
      ].sort(),
    );
    expect(names.some((n) => /withdraw|sweep|drain|rescue/i.test(n))).to.equal(false);
  });

  it("rejects creator allocation above 2% (CreatorAllocationTooHigh)", async () => {
    const creator = Keypair.generate();
    await airdrop(creator.publicKey);
    await expectErr(createLaunchIx(creator, Keypair.generate(), { creatorBps: 201 }).rpc(), "CreatorAllocationTooHigh");
  });

  // ---------------------------------------------------------------- main lifecycle
  describe("lifecycle: commit → reveal → clear → claim → graduate → trade → flywheel", () => {
    let L: LaunchCtx;
    let b1: Bidder, b2: Bidder, b3: Bidder, b4: Bidder, b5: Bidder;
    let clearingResult: ReturnType<typeof computeClearing>;
    let sniper: { kp: Keypair; quote: PublicKey };
    let holder: { kp: Keypair; quote: PublicKey };
    let trader: { kp: Keypair; quote: PublicKey };

    const mkBidder = async (maxPrice: bigint, amount: bigint, deposit: bigint, saltByte: number): Promise<Bidder> => {
      const u = await fundedUser(deposit);
      return { ...u, maxPrice, amount, deposit, salt: new Uint8Array(32).fill(saltByte) };
    };

    before(async () => {
      // Vector A: tick 5 (150) 100_000 & tick 2 (120) 100_000; plus a below-clearing bid and two non-revealers.
      b1 = await mkBidder(150n, 100_000n, 100_000n, 1);
      b2 = await mkBidder(120n, 100_000n, 120_000n, 2);
      b3 = await mkBidder(100n, 50_000n, 50_000n, 3); // below clearing ⇒ full refund
      b4 = await mkBidder(130n, 10_000n, 10_000n, 4); // never reveals ⇒ 1% slash
      b5 = await mkBidder(140n, 10_000n, 10_000n, 5); // wrong-salt reveal ⇒ mismatch, then unrevealed
      sniper = await fundedUser(10_000_000n);
      holder = await fundedUser(10_000_000n);
      trader = await fundedUser(100_000_000n);
      L = await createLaunch();
    });

    it("commits sealed bids and escrows deposits", async () => {
      for (const b of [b1, b2, b3, b4, b5]) await commit(L, b);
      const la = await program.account.launchAccount.fetch(L.launch);
      expect(la.bidCount).to.equal(5);
      expect(big(la.totalEscrowed)).to.equal(290_000n);
      expect(await balance(L.escrow)).to.equal(290_000n);
      expect(la.histogram.every((h) => big(h) === 0n)).to.equal(true); // nothing leaks before reveal
    });

    it("rejects reveal before the reveal window opens", async () => {
      await expectErr(reveal(L, b1), "RevealWindowNotOpen");
    });

    it("rejects a reveal whose preimage does not match the commitment", async () => {
      const la = await program.account.launchAccount.fetch(L.launch);
      await waitUntilChain(la.commitEndTs.toNumber());
      await expectErr(reveal(L, b5, new Uint8Array(32).fill(99)), "CommitmentMismatch");
    });

    it("reveals valid bids (relayer may submit) into the histogram", async () => {
      const relayer = Keypair.generate();
      await airdrop(relayer.publicKey, 1);
      await reveal(L, b1, b1.salt, relayer);
      await reveal(L, b2);
      await reveal(L, b3);
      await expectErr(reveal(L, b1), "AlreadyRevealed");
      const la = await program.account.launchAccount.fetch(L.launch);
      expect(la.revealedCount).to.equal(3);
      expect(big(la.histogram[5])).to.equal(100_000n);
      expect(big(la.histogram[2])).to.equal(100_000n);
      expect(big(la.histogram[0])).to.equal(50_000n);
    });

    it("rejects reveal after the reveal window closes", async () => {
      const la = await program.account.launchAccount.fetch(L.launch);
      await waitUntilChain(la.revealEndTs.toNumber());
      await expectErr(reveal(L, b4), "RevealWindowClosed");
    });

    it("clears at the uniform price computed by shared computeClearing", async () => {
      await program.methods.clearAuction().accountsPartial({ cranker: admin.publicKey, launch: L.launch }).rpc();
      const la = await program.account.launchAccount.fetch(L.launch);
      clearingResult = computeClearing({
        floorPrice: 100n,
        tickSize: 10n,
        numTicks: 64,
        buckets: la.histogram.map(big),
        tokensForSale: big(la.tokensForSale),
        clearingCap: 10_000_000n,
      });
      expect(st(la)).to.equal("cleared");
      expect(big(la.clearingPrice)).to.equal(clearingResult.clearingPrice);
      expect(big(la.clearingPrice)).to.equal(120n);
      expect(la.marginalTick).to.equal(clearingResult.marginalTick);
      expect(la.marginalTick).to.equal(2);
      expect(big(la.fillNum)).to.equal(clearingResult.fillNum);
      expect(big(la.fillDen)).to.equal(clearingResult.fillDen);
      expect(big(la.totalRaised)).to.equal(clearingResult.totalRaised);
      expect(big(la.tokensSold)).to.equal(clearingResult.tokensSold);
    });

    it("settles winners at the uniform price and refunds losers / non-revealers", async () => {
      const t0 = await balance(treasuryQuote);
      // b1 full fill — auto-stakes its tokens.
      await claim(L, b1, true);
      const s1 = settleBid(clearingResult, 100n, 10n, 5, b1.amount, b1.deposit);
      const pos1 = await program.account.holderPosition.fetch(pdas.position(L.launch, b1.kp.publicKey, pid)[0]);
      expect(big(pos1.staked)).to.equal(s1.tokens);
      expect(await balance(L.stakeVault)).to.equal(s1.tokens);
      expect(await balance(b1.quote)).to.equal(s1.refund);

      // b2 marginal pro-rata.
      await claim(L, b2, false);
      const s2 = settleBid(clearingResult, 100n, 10n, 2, b2.amount, b2.deposit);
      expect(s2.spent).to.equal(20_000n);
      expect(await balance(b2.quote)).to.equal(s2.refund);
      expect(await balance(getAssociatedTokenAddressSync(L.mint.publicKey, b2.kp.publicKey))).to.equal(s2.tokens);
      // Uniform price: both winners paid exactly 120 quote atoms per whole token (rounding down).
      expect((s1.spent * U) / 120n).to.equal(s1.tokens);
      expect((s2.spent * U) / 120n).to.equal(s2.tokens);

      // b3 below clearing ⇒ full refund, no tokens.
      await claim(L, b3, false);
      expect(await balance(b3.quote)).to.equal(b3.deposit);
      expect(await balance(getAssociatedTokenAddressSync(L.mint.publicKey, b3.kp.publicKey))).to.equal(0n);

      // b4/b5 unrevealed ⇒ deposit − 1% slash to treasury.
      await claim(L, b4, false);
      await claim(L, b5, false);
      expect(await balance(b4.quote)).to.equal(9_900n);
      expect(await balance(b5.quote)).to.equal(9_900n);
      expect((await balance(treasuryQuote)) - t0).to.equal(200n);

      // Bid accounts are closed ⇒ cannot claim twice.
      await expectErr(claim(L, b2, false), "AccountNotInitialized");
    });

    it("graduates + same-slot buy in ONE tx ⇒ sniper recorded; advances credit into the buyback vault", async () => {
      const gIx = await graduateIx(L, sniper.kp.publicKey).instruction();
      const sIx = await swapIx(L, sniper, 10_000n, 1n, true).instruction();
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), gIx, sIx);
      await provider.sendAndConfirm(tx, [sniper.kp]);

      const la = await program.account.launchAccount.fetch(L.launch);
      expect(st(la)).to.equal("live");
      expect(big(la.creditLine)).to.equal(12_000n); // 10% of 120_000 raised
      expect(big(la.creditOutstanding)).to.equal(12_000n);
      expect(await balance(L.vault)).to.equal(12_000n);
      const cp = await program.account.creditPool.fetch(creditPool());
      expect(big(cp.outstanding)).to.equal(12_000n);

      // AntiSnipeEntry is not referenced as a typed account by any instruction, so decode it by layout:
      // disc(8) | launch(32) | wallet(32) | slot(u64) | bump(u8)
      const info = await conn.getAccountInfo(pdas.antiSnipe(L.launch, sniper.kp.publicKey, pid)[0]);
      expect(info, "anti-snipe entry").to.not.equal(null);
      expect(info!.owner.toBase58()).to.equal(pid.toBase58());
      const disc = createHash("sha256").update("account:AntiSnipeEntry").digest().subarray(0, 8);
      expect(Buffer.from(info!.data.subarray(0, 8)).equals(disc)).to.equal(true);
      expect(new PublicKey(info!.data.subarray(8, 40)).toBase58()).to.equal(L.launch.toBase58());
      expect(new PublicKey(info!.data.subarray(40, 72)).toBase58()).to.equal(sniper.kp.publicKey.toBase58());
      expect(info!.data.readBigUInt64LE(72)).to.equal(big(la.graduationSlot));
      const proto = await program.account.protocolConfig.fetch(pdas.protocol(pid)[0]);
      expect(big(proto.snipersBlocked)).to.equal(1n);
    });

    it("drip before due fails; after due it buys from the pool and burns supply", async () => {
      await expectErr(dripIx(L).rpc(), "DripNotDue");
      const la0 = await program.account.launchAccount.fetch(L.launch);
      const supply0 = (await getMint(conn, L.mint.publicKey)).supply;
      await waitUntilChain(la0.nextDripTs.toNumber());
      await dripIx(L).rpc();
      const la1 = await program.account.launchAccount.fetch(L.launch);
      const supply1 = (await getMint(conn, L.mint.publicKey)).supply;
      expect(la1.dripsExecuted).to.equal(1);
      expect(big(la1.tokensBurned) > 0n).to.equal(true);
      expect(supply0 - supply1).to.equal(big(la1.tokensBurned));
      expect(await balance(L.vault)).to.equal(12_000n - 4_000n); // 12_000 / 3 drips
      // Immediately again ⇒ not due.
      await expectErr(dripIx(L).rpc(), "DripNotDue");
    });

    it("rejects staking for the same-slot sniper (SniperIneligible)", async () => {
      const bal = await balance(getAssociatedTokenAddressSync(L.mint.publicKey, sniper.kp.publicKey));
      expect(bal > 0n).to.equal(true);
      await expectErr(stakeIx(L, sniper, bal).rpc(), "SniperIneligible");
    });

    it("buyback vault cannot be withdrawn with a forged authority", async () => {
      const attacker = Keypair.generate();
      await airdrop(attacker.publicKey, 1);
      const dest = await createAccount(conn, attacker, quoteMint, attacker.publicKey, Keypair.generate());
      for (const forged of [attacker, L.creator]) {
        const ix = createTransferInstruction(L.vault, dest, forged.publicKey, 1n);
        await expectErr(provider.sendAndConfirm(new Transaction().add(ix), [forged]), "Error");
      }
      // Even naming the launch PDA as authority fails: only the program can sign for it.
      const pdaIx = new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: L.vault, isSigner: false, isWritable: true },
          { pubkey: dest, isSigner: false, isWritable: true },
          { pubkey: L.launch, isSigner: false, isWritable: false },
        ],
        data: createTransferInstruction(L.vault, dest, L.launch, 1n).data,
      });
      await expectErr(provider.sendAndConfirm(new Transaction().add(pdaIx), [attacker]), "Error");
      expect(await balance(L.vault)).to.equal(8_000n); // untouched since the first drip
    });

    it("non-sniper buyer (later slot) can stake", async () => {
      await swapIx(L, holder, 20_000n, 1n, true).rpc();
      const info = await conn.getAccountInfo(pdas.antiSnipe(L.launch, holder.kp.publicKey, pid)[0]);
      expect(info).to.equal(null);
      const bal = await balance(getAssociatedTokenAddressSync(L.mint.publicKey, holder.kp.publicKey));
      await stakeIx(L, holder, bal).rpc();
      const pos = await program.account.holderPosition.fetch(pdas.position(L.launch, holder.kp.publicKey, pid)[0]);
      expect(big(pos.staked)).to.equal(bal);
    });

    it("swap fees + distribute_fees repay credit (80/20) and flip to Flywheel at zero", async () => {
      // Phase 1: a small amount of fees — partial repayment, still Live.
      let la = await program.account.launchAccount.fetch(L.launch);
      let fees = await balance(L.feeCollector);
      expect(fees > 0n).to.equal(true);
      const out0 = big(la.creditOutstanding);
      const exp0 = splitFees(fees, out0);
      const ops0 = await balance(opsQuote);
      await distributeIx(L).rpc();
      la = await program.account.launchAccount.fetch(L.launch);
      expect(big(la.creditOutstanding)).to.equal(exp0.creditOutstandingAfter);
      expect(big(la.creditOutstanding) > 0n).to.equal(true);
      expect(st(la)).to.equal("live");
      expect((await balance(opsQuote)) - ops0).to.equal(exp0.platformOps + exp0.platformBuybackBurn);

      // Phase 2: volume — buy/sell round trips through the pool.
      const traderToken = getAssociatedTokenAddressSync(L.mint.publicKey, trader.kp.publicKey);
      for (let i = 0; i < 3; i++) {
        await swapIx(L, trader, 1_000_000n, 1n, true).rpc();
        const tb = await balance(traderToken);
        await swapIx(L, trader, tb, 1n, false).rpc();
      }
      fees = await balance(L.feeCollector);
      const exp1 = splitFees(fees, big(la.creditOutstanding));
      expect(exp1.creditOutstandingAfter).to.equal(0n);
      const cpBefore = await program.account.creditPool.fetch(creditPool());
      const cvBefore = await balance(creditVault());
      const rvBefore = await balance(L.rewardsVault);
      await distributeIx(L).rpc();
      la = await program.account.launchAccount.fetch(L.launch);
      expect(big(la.creditOutstanding)).to.equal(0n);
      expect(st(la)).to.equal("flywheel");
      const cp = await program.account.creditPool.fetch(creditPool());
      expect(big(cp.outstanding)).to.equal(big(cpBefore.outstanding) - exp1.creditRepay);
      expect((await balance(creditVault())) - cvBefore).to.equal(exp1.creditRepay);
      expect((await balance(L.rewardsVault)) - rvBefore).to.equal(exp1.holders);
      expect(big(la.rewardPerShare) > 0n).to.equal(true);

      // Phase 3: pure flywheel split 50/35/15.
      await swapIx(L, trader, 1_000_000n, 1n, true).rpc();
      fees = await balance(L.feeCollector);
      const exp2 = splitFees(fees, 0n);
      const rv2 = await balance(L.rewardsVault);
      const t2 = await balance(treasuryQuote);
      await distributeIx(L).rpc();
      expect((await balance(L.rewardsVault)) - rv2).to.equal(exp2.holders);
      expect((await balance(treasuryQuote)) - t2).to.equal(exp2.treasury);
    });

    it("non-sniper stakers claim quote rewards; sniper has no accrual", async () => {
      const la = await program.account.launchAccount.fetch(L.launch);
      const rps = big(la.rewardPerShare);
      for (const u of [holder, b1]) {
        const posPk = pdas.position(L.launch, u.kp.publicKey, pid)[0];
        const pos = await program.account.holderPosition.fetch(posPk);
        const expected = big(pos.unclaimed) + (big(pos.staked) * rps) / 1_000_000_000_000n - big(pos.rewardDebt);
        const before = await balance(u.quote);
        await program.methods
          .claimRewards()
          .accountsPartial({
            owner: u.kp.publicKey,
            launch: L.launch,
            position: posPk,
            rewardsVault: L.rewardsVault,
            ownerQuote: u.quote,
            antiSnipe: pdas.antiSnipe(L.launch, u.kp.publicKey, pid)[0],
          })
          .signers([u.kp])
          .rpc();
        const got = (await balance(u.quote)) - before;
        expect(got > 0n).to.equal(true);
        expect(got).to.equal(expected);
      }
      const sniperPos = await conn.getAccountInfo(pdas.position(L.launch, sniper.kp.publicKey, pid)[0]);
      expect(sniperPos).to.equal(null);
    });

    it("unstake returns tokens", async () => {
      const posPk = pdas.position(L.launch, holder.kp.publicKey, pid)[0];
      const pos = await program.account.holderPosition.fetch(posPk);
      const ownerToken = getAssociatedTokenAddressSync(L.mint.publicKey, holder.kp.publicKey);
      await expectErr(
        program.methods
          .unstake(bn(big(pos.staked) + 1n))
          .accountsPartial({ owner: holder.kp.publicKey, launch: L.launch, position: posPk, stakeVault: L.stakeVault, ownerToken })
          .signers([holder.kp])
          .rpc(),
        "InsufficientStake",
      );
      await program.methods
        .unstake(pos.staked)
        .accountsPartial({ owner: holder.kp.publicKey, launch: L.launch, position: posPk, stakeVault: L.stakeVault, ownerToken })
        .signers([holder.kp])
        .rpc();
      expect(await balance(ownerToken)).to.equal(big(pos.staked));
    });
  });

  describe("failed auction", () => {
    it("no reveals ⇒ Failed ⇒ full refund, graduation impossible", async () => {
      const b = await fundedUser(5_000n);
      const L = await createLaunch({ commitSec: 4, revealSec: 2 });
      const bidder: Bidder = { ...b, maxPrice: 150n, amount: 5_000n, deposit: 5_000n, salt: new Uint8Array(32).fill(9) };
      await commit(L, bidder);
      await expectErr(
        program.methods.clearAuction().accountsPartial({ cranker: admin.publicKey, launch: L.launch }).rpc(),
        "AuctionNotEnded",
      );
      const la = await program.account.launchAccount.fetch(L.launch);
      await waitUntilChain(la.revealEndTs.toNumber());
      await program.methods.clearAuction().accountsPartial({ cranker: admin.publicKey, launch: L.launch }).rpc();
      expect(st(await program.account.launchAccount.fetch(L.launch))).to.equal("failed");
      await claim(L, bidder);
      expect(await balance(b.quote)).to.equal(5_000n);
      await expectErr(graduateIx(L, admin.publicKey).rpc(), "AuctionNotCleared");
    });
  });
});
