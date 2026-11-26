import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EscrowFundingUnsupportedError,
  HeliusPrivacyRingClient,
  InsufficientShieldedBalanceError,
  PrivacySdkUnavailableError,
  SPR_ADDRESSES,
  SimulatedPrivacyRingClient,
  createPrivacyRingClient,
  directTransport,
  isSprRpcMethod,
  memoryRingStorage,
  proxyTransport,
  simulatedViewingKey,
  sprIndexerUrl,
  type SprTransport,
} from "../privacy/index.js";

const ALICE = "5Vt1Mnq2b9ynV1EMXS564i5ZDuNudxm8ZG7yCXfH55M";
const BOB = "GjGGg8nkKjJaiRXCcXJuHjcQmFf61vTMPaU7ridhWhLX";

test("simulated ring: shield → ciphertext only → decrypt with viewing key", async () => {
  const ring = new SimulatedPrivacyRingClient();
  await ring.shield({ owner: ALICE, symbol: "USDC", atoms: 5_000_000n });
  const enc = await ring.encryptedBalance(ALICE, "USDC");
  assert.equal(enc.outputs, 1);
  assert.ok(enc.ciphertext && !enc.ciphertext.includes("5000000"));
  assert.equal(await ring.decryptBalance(ALICE, "USDC", simulatedViewingKey(ALICE)), 5_000_000n);
  await assert.rejects(ring.decryptBalance(ALICE, "USDC", simulatedViewingKey(BOB)), /Wrong viewing key/);
});

test("simulated ring: confidential transfer, escrow funding, payout, persistence", async () => {
  const storage = memoryRingStorage();
  const ring = new SimulatedPrivacyRingClient({ storage });
  await ring.shield({ owner: ALICE, symbol: "SOL", atoms: 10n });
  const t = await ring.confidentialTransfer({ owner: ALICE, recipient: BOB, symbol: "SOL", atoms: 3n });
  assert.deepEqual(t.publicFields, ["sender", "recipient"]);
  assert.ok(t.signature.startsWith("simring"));
  await ring.fundEscrow({ owner: ALICE, launchId: "L1", symbol: "SOL", atoms: 7n, commitmentHex: "ab" });
  await assert.rejects(ring.fundEscrow({ owner: ALICE, launchId: "L1", symbol: "SOL", atoms: 1n, commitmentHex: "cd" }), InsufficientShieldedBalanceError);
  assert.equal(ring.privateDeposits("L1"), 1);
  assert.ok(ring.isPrivatelyFunded("L1", "ab"));
  await ring.payout("L1", ALICE, "SOL", 2n);

  const reloaded = new SimulatedPrivacyRingClient({ storage });
  assert.equal(await reloaded.decryptBalance(ALICE, "SOL", simulatedViewingKey(ALICE)), 2n);
  assert.equal(await reloaded.decryptBalance(BOB, "SOL", simulatedViewingKey(BOB)), 3n);
  assert.equal(reloaded.privateDeposits("L1"), 1);
});

function fakeTransport(results: Record<string, unknown>, calls: Array<[string, unknown]> = []): SprTransport {
  return async (method, params) => {
    calls.push([method, params]);
    if (!(method in results)) throw new Error(`unexpected ${method}`);
    return results[method];
  };
}

test("helius ring: verified indexer methods, fails closed for escrow and SDK-only ops", async () => {
  const calls: Array<[string, unknown]> = [];
  const ring = new HeliusPrivacyRingClient({
    network: "devnet",
    transport: fakeTransport(
      {
        getUserRecords: { context: { slot: 1 }, records: [{ owner: ALICE, nullifierPubkey: "x", viewingPubkey: "y", mergeEncryption: 0 }] },
        getShieldedTransactionsByTags: {
          context: { slot: 99 },
          data: [{ slot: 98, signature: "s", events: [{ outputSlots: [{ viewTag: ALICE, payload: "Y2lwaGVy" }, { viewTag: BOB, payload: "b3RoZXI=" }] }] }],
          paginationToken: null,
        },
      },
      calls,
    ),
  });
  assert.equal(await ring.isRegistered(ALICE), true);
  const enc = await ring.encryptedBalance(ALICE, "USDC");
  assert.deepEqual([enc.outputs, enc.ciphertext, enc.asOfSlot], [1, "Y2lwaGVy", 99]);
  assert.deepEqual(calls[1], ["getShieldedTransactionsByTags", { tags: [ALICE], limit: 1000 }]);
  const st = await ring.status();
  assert.equal(st.available, true);
  assert.equal(st.ringId, SPR_ADDRESSES.privacyProgram);
  assert.equal(ring.capabilities().fundProgramEscrow, false);
  await assert.rejects(ring.fundEscrow({ owner: ALICE, launchId: "L", symbol: "USDC", atoms: 1n, commitmentHex: "00" }), EscrowFundingUnsupportedError);
  await assert.rejects(ring.shield({ owner: ALICE, symbol: "USDC", atoms: 1n }), PrivacySdkUnavailableError);
  await assert.rejects(ring.decryptBalance(ALICE, "USDC", new Uint8Array(32)), PrivacySdkUnavailableError);
});

test("helius ring: localnet unavailable; factory picks simulated without transport", async () => {
  const ring = new HeliusPrivacyRingClient({ network: "localnet", transport: fakeTransport({}) });
  assert.equal((await ring.status()).available, false);
  assert.equal(createPrivacyRingClient({ network: "mainnet" }).kind, "simulated");
  assert.equal(createPrivacyRingClient({ network: "mainnet", transport: fakeTransport({}) }).kind, "helius");
  assert.equal(createPrivacyRingClient({ network: "devnet", transport: fakeTransport({}), simulated: true }).kind, "simulated");
});

test("transports: URL shape, method whitelist, JSON-RPC error unwrapping", async () => {
  assert.equal(sprIndexerUrl("mainnet", "getUserRecords", "k y"), "https://mainnet.helius-rpc.com/v1/spr/getUserRecords?api-key=k%20y");
  assert.equal(isSprRpcMethod("getMerkleProofs"), true);
  assert.equal(isSprRpcMethod("sendTransaction"), false);
  let seen: { url: string; body: string } | null = null;
  const direct = directTransport({
    network: "devnet",
    apiKey: "KEY",
    fetch: async (url, init) => {
      seen = { url, body: init.body };
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "sealed", result: { records: [null] } }) };
    },
  });
  assert.deepEqual(await direct("getUserRecords", { owners: [ALICE] }), { records: [null] });
  assert.match(seen!.url, /devnet\.helius-rpc\.com\/v1\/spr\/getUserRecords\?api-key=KEY/);
  assert.equal(JSON.parse(seen!.body).method, "getUserRecords");
  const proxy = proxyTransport("http://api/", async (url) => {
    assert.equal(url, "http://api/api/privacy/rpc");
    return { ok: false, status: 502, json: async () => ({ error: { code: -32000, message: "upstream down" } }) };
  });
  await assert.rejects(proxy("getUserRecords", { owners: [ALICE] }), /upstream down/);
});
