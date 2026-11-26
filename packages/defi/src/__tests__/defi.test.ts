import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { openReveal, relayerKeypairFromSeed, verifyRevealSignature, base64, POOL_FEE_BPS, TOKEN_UNIT } from "@sealed/shared";
import { BidVault, BidVaultDecryptError, deriveVaultKey, memoryStorage, vaultSignMessage, type StoredBid } from "../bidVault.js";
import { prepareSealedBid, pickTick, priceTicks, priceTicksUi, buildAutoRevealEnvelope, verifyPreimage } from "../sealedBid.js";
import { quoteBuy, quoteSell, minOutWithSlippage, spotPrice, uiToAtoms, atomsToUi } from "../cpmm.js";
import { JupiterClient, JupiterUnavailableError, selectSwapVenue } from "../jupiter.js";
import { buildMigrationPlan, sortMints } from "../raydium.js";
import { parseDevnetMints, resolveQuoteAsset } from "../quoteAssets.js";

const VECTOR = "3b10bfafd02724e8e5f26313c9e95931ac6a3429bcda3816144916013c12fe7f";
const BIDDER = "11111111111111111111111111111111";

test("sealedBid commitment matches shared vector", () => {
  const p = prepareSealedBid({
    bidder: BIDDER,
    grid: { floorPrice: 100n, tickSize: 10n },
    maxPrice: 150n,
    bidAmount: 5000n,
    deposit: 5000n,
    salt: new Uint8Array(32).fill(7),
    exactTick: true,
  });
  assert.equal(p.commitmentHex, VECTOR);
  assert.equal(p.tick, 5);
  assert.deepEqual(p.plaintext, { maxPrice: "150", bidAmount: "5000", salt: "07".repeat(32) });
  assert.ok(verifyPreimage({ bidder: BIDDER, maxPrice: 150n, bidAmount: 5000n, saltHex: p.saltHex, commitmentHex: VECTOR }));
});

test("tick picking snaps down and clamps", () => {
  const g = { floorPrice: 100n, tickSize: 10n };
  assert.deepEqual(pickTick(g, 157n), { index: 5, price: 150n });
  assert.deepEqual(pickTick(g, 50n), { index: 0, price: 100n });
  assert.deepEqual(pickTick(g, 10_000n), { index: 63, price: 730n });
  assert.equal(priceTicks(g).length, 64);
  const ui = priceTicksUi({ floorPrice: 0.001, tickSize: 0.0001 }, 9);
  assert.equal(ui.length, 64);
  assert.equal(ui[0], 0.001);
  assert.ok(Math.abs(ui[10]! - 0.002) < 1e-12);
  assert.throws(() => prepareSealedBid({ bidder: BIDDER, grid: g, maxPrice: 155n, bidAmount: 1n, deposit: 1n, exactTick: true }));
  assert.throws(() => prepareSealedBid({ bidder: BIDDER, grid: g, maxPrice: 150n, bidAmount: 2n, deposit: 1n }));
});

test("auto-reveal envelope opens on relayer and verifies", async () => {
  const kp = nacl.sign.keyPair();
  const bidder = new PublicKey(kp.publicKey).toBase58();
  const relayer = relayerKeypairFromSeed(new Uint8Array(32).fill(3));
  const p = prepareSealedBid({ bidder, grid: { floorPrice: 100n, tickSize: 10n }, maxPrice: 120n, bidAmount: 900n, deposit: 1000n });
  const launchId = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
  const env = await buildAutoRevealEnvelope({
    launchId,
    prepared: p,
    relayerPubkeyB64: base64.enc(relayer.publicKey),
    signMessage: async (m) => nacl.sign.detached(m, kp.secretKey),
  });
  assert.ok(verifyRevealSignature(env, kp.publicKey));
  assert.deepEqual(openReveal(env, relayer.secretKey), p.plaintext);
});

function rec(wallet: string, launchId: string): StoredBid {
  return { launchId, bidder: wallet, network: "devnet", commitmentHex: VECTOR, maxPrice: "150", bidAmount: "5000", deposit: "5000", saltHex: "07".repeat(32), tick: 5, createdTs: 1 };
}

test("bidVault round trip, backup export/import", async () => {
  const kp = nacl.sign.keyPair();
  const wallet = new PublicKey(kp.publicKey).toBase58();
  const signMessage = async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey);
  const storage = memoryStorage();
  const v = await BidVault.unlock({ wallet, signMessage, storage });
  await v.save(rec(wallet, "L1"));
  await v.save(rec(wallet, "L2"));
  assert.deepEqual(await v.get("L1"), rec(wallet, "L1"));
  // stored value is ciphertext only
  const raw = await storage.get(`${wallet}:L1`);
  assert.ok(raw && !raw.includes("0707070707"));
  assert.equal((await v.list()).length, 2);
  await v.update("L1", { revealed: true });
  assert.equal((await v.get("L1"))?.revealed, true);

  const backup = await v.exportBackup();
  const v2 = await BidVault.unlock({ wallet, signMessage, storage: memoryStorage() });
  assert.equal(await v2.importBackup(backup), 2);
  assert.equal((await v2.get("L2"))?.saltHex, "07".repeat(32));
});

test("bidVault wrong key fails", async () => {
  const wallet = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
  const storage = memoryStorage();
  const good = BidVault.fromKey(wallet, await deriveVaultKey(new Uint8Array(64).fill(1), wallet), storage);
  await good.save(rec(wallet, "L1"));
  const bad = BidVault.fromKey(wallet, await deriveVaultKey(new Uint8Array(64).fill(2), wallet), storage);
  await assert.rejects(() => bad.get("L1"), BidVaultDecryptError);
  assert.deepEqual(await bad.list(), []);
  const backup = await good.exportBackup();
  const bad2 = BidVault.fromKey(wallet, await deriveVaultKey(new Uint8Array(64).fill(2), wallet), memoryStorage());
  await assert.rejects(() => bad2.importBackup(backup), BidVaultDecryptError);
  // entries are bound to their launch id (AAD): swapping ciphertext between launches fails
  await storage.set(`${wallet}:L9`, (await storage.get(`${wallet}:L1`))!.replace('"id":"L1"', '"id":"L9"'));
  await assert.rejects(() => good.get("L9"), BidVaultDecryptError);
  assert.ok(vaultSignMessage(wallet).length > 0);
});

test("cpmm buy/sell quotes include 1% pool fee", () => {
  const r = { quoteReserve: 1_000_000_000n, tokenReserve: 1_000_000n * TOKEN_UNIT };
  assert.equal(spotPrice(r), 1_000n);
  const b = quoteBuy(10_000_000n, r);
  assert.equal(POOL_FEE_BPS, 100);
  assert.equal(b.feeQuote, 100_000n);
  // net 9_900_000 → out = 9.9e6 * 1e12 / (1e9 + 9.9e6)
  assert.equal(b.amountOut, (9_900_000n * r.tokenReserve) / (r.quoteReserve + 9_900_000n));
  assert.ok(b.priceImpactBps > 90 && b.priceImpactBps < 110, `impact ${b.priceImpactBps}`);
  assert.ok(b.postTradePrice > b.spotPrice);
  const s = quoteSell(1_000n * TOKEN_UNIT, r);
  const gross = (1_000n * TOKEN_UNIT * r.quoteReserve) / (r.tokenReserve + 1_000n * TOKEN_UNIT);
  assert.equal(s.feeQuote, gross / 100n);
  assert.equal(s.amountOut, gross - gross / 100n);
  assert.equal(minOutWithSlippage(10_000n, 50), 9_950n);
  assert.equal(uiToAtoms(1.5, 6), 1_500_000n);
  assert.equal(uiToAtoms("0.000000001", 9), 1n);
  assert.equal(atomsToUi(1_500_000n, 6), 1.5);
});

test("jupiter is mainnet-only; devnet falls back to internal pool", async () => {
  const j = new JupiterClient({ network: "devnet", fetch: async () => { throw new Error("must not fetch"); } });
  await assert.rejects(() => j.getQuote({ inputMint: "a", outputMint: "b", amount: 1n }), JupiterUnavailableError);
  assert.equal(selectSwapVenue("devnet", "quote-conversion"), "internal-pool");
  assert.equal(selectSwapVenue("mainnet", "quote-conversion"), "jupiter");
  assert.equal(selectSwapVenue("mainnet", "launch-token"), "internal-pool");
  const mock = new JupiterClient({
    network: "mainnet",
    timeoutMs: 50,
    fetch: (async (url: string) => {
      assert.ok(String(url).includes("/quote?"));
      return new Response(JSON.stringify({ inputMint: "a", inAmount: "1", outputMint: "b", outAmount: "2", otherAmountThreshold: "2", swapMode: "ExactIn", slippageBps: 50, priceImpactPct: "0", routePlan: [] }));
    }) as typeof fetch,
  });
  assert.equal((await mock.getQuote({ inputMint: "a", outputMint: "b", amount: 1n })).outAmount, "2");
  const slow = new JupiterClient({ network: "mainnet", timeoutMs: 20, fetch: ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as typeof fetch });
  await assert.rejects(() => slow.getQuote({ inputMint: "a", outputMint: "b", amount: 1n }), /timed out/);
});

test("raydium plan and quote-asset resolution", () => {
  const a = new PublicKey(new Uint8Array(32).fill(5));
  const b = new PublicKey(new Uint8Array(32).fill(2));
  assert.deepEqual(sortMints(a, b), [b, a]);
  const plan = buildMigrationPlan({ network: "devnet", tokenMint: a, quoteMint: b, tokenAmount: 1_000n * TOKEN_UNIT, quoteAmount: 5_000_000n, owner: b, burnLp: true });
  assert.equal(plan.optional, true);
  assert.equal(plan.initialPrice, 5_000n);
  assert.equal(plan.amount0, 5_000_000n);
  assert.equal(plan.steps.length, 2);
  const mint = a.toBase58();
  assert.deepEqual(parseDevnetMints({ nvdax: mint, BOGUS: mint, TSLAx: "not-a-key" }), { NVDAx: mint });
  assert.equal(resolveQuoteAsset("NVDAx", "devnet", { env: {}, devnetMints: { NVDAx: mint } }).source, "devnet-mints");
  assert.equal(resolveQuoteAsset("NVDAx", "devnet", { env: { QUOTE_MINT_NVDAX_DEVNET: b.toBase58() }, devnetMints: { NVDAx: mint } }).mint, b.toBase58());
  assert.equal(resolveQuoteAsset("NVDAx", "mainnet", { env: {} }).enabled, false);
  assert.equal(resolveQuoteAsset("USDC", "mainnet", { env: {} }).mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
});
