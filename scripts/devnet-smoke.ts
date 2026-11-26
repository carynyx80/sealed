/**
 * Sealed custodial DEVNET smoke test (operator script). Run from the repo root:
 *
 *   pnpm --filter @sealed/e2e smoke:devnet -- --api https://<your-devnet-api> --keypair ~/.config/solana/devnet-smoke.json [--send]
 *
 * See `--help` for all flags. The keypair file is YOURS (solana-keygen format), is read locally only, and must never
 * be committed. No secret (key bytes, session token, RPC API key, bid salt) is ever printed.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ApiClient, sleep } from "../tests/lib/api.ts";
import {
  CUSTODY_ROUTES,
  QUOTE_ASSETS,
  computeCommitment,
  randomSalt,
  revealSignMessage,
  sealReveal,
  toHex,
  type AccountResponse,
  type CustodyInfoResponse,
  type DepositInstructions,
  type DepositRecord,
  type HealthResponse,
  type LaunchListResponse,
  type LaunchSummary,
  type OffchainSwapResponse,
  type QuoteAssetSymbol,
  type WithdrawalRecord,
} from "../tests/lib/sealed.ts";
import { buildTransferWithMemo, loadKeypairFile, rpcCall, type TestKeypair } from "../tests/lib/solana.ts";

const USAGE = `Sealed custodial devnet smoke test

Usage:
  pnpm --filter @sealed/e2e smoke:devnet -- --api <API_URL> --keypair <DEVNET_KEYPAIR.json> [options]

Required (flag or env):
  --api <url>              Sealed API base URL                          (env API_URL)
  --keypair <path>         YOUR devnet keypair file (solana-keygen JSON) (env DEVNET_KEYPAIR)
                           Never commit it. It is only read locally to sign the SIWS message and, with --send, the deposit tx.

Options:
  --send                   Actually send a SOL deposit (transfer + memo "sealed:<ref>") to the company wallet on devnet.
                           Without it the script only prints the deposit instructions and uses any existing balance.
  --amount <SOL>           Deposit amount with --send (default 0.01, max 1).
  --rpc <url>              Devnet JSON-RPC for --send (env SOLANA_RPC_URL, default https://api.devnet.solana.com).
  --wait <sec>             Max seconds to wait for the deposit to be credited (default 180).
  --launch <id>            Launch to trade on (default: first non-demo launch where a swap or bid fits your balance).
  --trade-amount <n>       Quote amount for the tiny swap / bid deposit (default 0.002 for SOL launches, 1 otherwise).
  --withdraw <SOL>         SOL withdrawal amount to request back to your wallet (default 0.002; 0 to skip; min 0.001).
  --i-understand-mainnet   Allow running when the API reports NETWORK=mainnet (real funds!). --send is never allowed there.
  -h, --help               Show this help.

What it does: GET /api/health (refuses mainnet) → GET /api/custody/info → SIWS sign-in → print deposit instructions
→ [--send: transfer + memo, nudge detection, poll until credited] → tiny swap (live launch) or sealed bid with an
auto-reveal envelope (commit-phase launch) → withdrawal request → print statuses and final balances.
`;

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const LAMPORTS = 1_000_000_000;

function fail(msg: string, code = 1): never {
  console.error(`\n✗ ${msg}`);
  process.exit(code);
}
/** Never print credentials embedded in URLs (api-key query params, basic auth). */
function redactUrl(u: string): string {
  try {
    const x = new URL(u);
    x.username = "";
    x.password = "";
    if (x.search) x.search = "?…";
    return x.toString();
  } catch {
    return "<invalid url>";
  }
}
function resolvePath(p: string): string {
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
}
const step = (s: string) => console.log(`\n▸ ${s}`);
const info = (s: string) => console.log(`  ${s}`);

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      api: { type: "string" },
      keypair: { type: "string" },
      send: { type: "boolean", default: false },
      amount: { type: "string", default: "0.01" },
      rpc: { type: "string" },
      wait: { type: "string", default: "180" },
      launch: { type: "string" },
      "trade-amount": { type: "string" },
      withdraw: { type: "string", default: "0.002" },
      "i-understand-mainnet": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const apiUrl = (values.api ?? process.env.API_URL ?? "").replace(/\/$/, "");
  const keyPath = values.keypair ?? process.env.DEVNET_KEYPAIR;
  if (!apiUrl || !keyPath) {
    console.log(USAGE);
    fail("--api and --keypair (or API_URL / DEVNET_KEYPAIR) are required", 2);
  }
  const amountSol = Number(values.amount);
  if (!Number.isFinite(amountSol) || amountSol <= 0 || amountSol > 1) fail("--amount must be in (0, 1] SOL", 2);
  const withdrawSol = Number(values.withdraw);
  if (!Number.isFinite(withdrawSol) || withdrawSol < 0) fail("--withdraw must be ≥ 0", 2);
  const waitSec = Number(values.wait);
  const rpcUrl = values.rpc ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

  // ---------------------------------------------------------------- 1. network guard
  step(`API ${redactUrl(apiUrl)}`);
  const pub = new ApiClient(apiUrl);
  const health = await pub.get<HealthResponse>("/api/health").catch((e) => fail(`API unreachable: ${(e as Error).message}`));
  if (health.status !== 200) fail(`GET /api/health → HTTP ${health.status}`);
  info(`network=${health.body.network} demo=${health.body.isDemo} db=${health.body.db} version=${health.body.version}`);
  if (health.body.network === "mainnet") {
    if (!values["i-understand-mainnet"]) fail("API reports NETWORK=mainnet — refusing. This is a DEVNET smoke test (pass --i-understand-mainnet to override; --send stays disabled).", 3);
    if (values.send) fail("--send is never allowed against mainnet", 3);
    console.warn("  ⚠ running against MAINNET by explicit override: real funds — only read-only steps + tiny trades/withdrawals of existing balance");
  }
  const ci = await pub.get<CustodyInfoResponse>(CUSTODY_ROUTES.info);
  if (ci.status !== 200) fail(`GET ${CUSTODY_ROUTES.info} → HTTP ${ci.status} (${ci.body.error ?? ""})`);
  info(`mode=${ci.body.mode} companyWallet=${ci.body.companyWallet} payoutsEnabled=${ci.body.payoutsEnabled}`);
  for (const r of ci.body.proofOfReserves) info(`reserves ${r.asset}: onchain=${r.onchain} liabilities=${r.liabilities} ratio=${r.ratio}`);
  if (ci.body.mode !== "offchain") fail("API is in onchain mode; the custodial smoke test needs EXECUTION_MODE=offchain");

  // ---------------------------------------------------------------- 2. SIWS
  const kpPath = resolvePath(keyPath);
  if (!existsSync(kpPath)) fail(`keypair file not found: ${kpPath}`, 2);
  let kp: TestKeypair;
  try {
    kp = loadKeypairFile(kpPath);
  } catch (e) {
    fail((e as Error).message, 2);
  }
  step(`Sign in with Solana as ${kp.address}`);
  const api = new ApiClient(apiUrl);
  const session = await api.signIn(kp).catch((e) => fail((e as Error).message));
  info(`signed in; session expires ${new Date(session.expiresTs * 1000).toISOString()} (token kept in memory, not printed)`);

  const account = async () => {
    const r = await api.get<AccountResponse>(CUSTODY_ROUTES.me);
    if (r.status !== 200) fail(`GET ${CUSTODY_ROUTES.me} → HTTP ${r.status}`);
    return r.body;
  };
  const printBalances = (a: AccountResponse) => {
    if (a.balances.length === 0) info("(no balances)");
    for (const b of a.balances) info(`${b.symbol.padEnd(10)} available=${b.available} locked=${b.locked}`);
  };
  const available = (a: AccountResponse, asset: string) => a.balances.find((b) => b.asset === asset)?.available ?? 0;
  let acct = await account();
  info(`depositRef=${acct.depositRef}`);
  printBalances(acct);

  // ---------------------------------------------------------------- 3. deposit instructions (+ optional send)
  step("Deposit instructions (SOL)");
  const ins = await api.get<DepositInstructions>(CUSTODY_ROUTES.depositInstructions("SOL"));
  if (ins.status !== 200) fail(`deposit instructions → HTTP ${ins.status} (${ins.body.error ?? ""})`);
  info(`send SOL to ${ins.body.companyWallet} with memo "${ins.body.memo}" (confirmations: ${ins.body.minConfirmations})`);
  info(ins.body.note);
  if (ins.body.companyWallet !== ci.body.companyWallet) fail("deposit wallet differs from /api/custody/info companyWallet — refusing");

  if (values.send) {
    step(`Sending ${amountSol} SOL deposit on devnet via ${redactUrl(rpcUrl)}`);
    const genesis = await rpcCall<string>(rpcUrl, "getGenesisHash", []).catch((e) => fail((e as Error).message));
    if (genesis !== DEVNET_GENESIS) fail("RPC is not Solana devnet (genesis hash mismatch) — refusing to send");
    const lamports = BigInt(Math.round(amountSol * LAMPORTS));
    const bal = await rpcCall<{ value: number }>(rpcUrl, "getBalance", [kp.address, { commitment: "confirmed" }]);
    info(`wallet devnet balance: ${bal.value / LAMPORTS} SOL`);
    if (BigInt(bal.value) < lamports + 10_000n) fail("insufficient devnet SOL (airdrop: `solana airdrop 1 <address> --url devnet` or https://faucet.solana.com)");
    const bh = await rpcCall<{ value: { blockhash: string } }>(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]);
    const tx = buildTransferWithMemo({ from: kp, to: ins.body.companyWallet, lamports, memo: ins.body.memo, recentBlockhash: bh.value.blockhash });
    const sig = await rpcCall<string>(rpcUrl, "sendTransaction", [tx.base64, { encoding: "base64", preflightCommitment: "confirmed" }]).catch((e) => fail((e as Error).message));
    info(`sent: ${sig}`);
    info(`explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);

    step(`Waiting up to ${waitSec}s for the deposit to be credited`);
    const deadline = Date.now() + waitSec * 1000;
    let last = "";
    let nudged = 0;
    while (Date.now() < deadline) {
      if (nudged < 6) {
        const n = await api.post<DepositRecord>(CUSTODY_ROUTES.deposits, { signature: sig });
        nudged++;
        if (n.status === 503 && nudged === 1) info(`(detection nudge unavailable: ${n.body.error}; relying on the deposit watcher)`);
      }
      const d = await api.get<{ deposits: DepositRecord[] }>(CUSTODY_ROUTES.deposits);
      const rec = d.body.deposits?.find((x) => x.signature === sig);
      const s = rec ? `${rec.status}${rec.reason ? ` (${rec.reason})` : ""}` : "not seen yet";
      if (s !== last) info(`deposit: ${s}`);
      last = s;
      if (rec?.status === "credited") break;
      if (rec?.status === "rejected") fail(`deposit rejected: ${rec.reason ?? "unknown"}`);
      await sleep(5_000);
    }
    if (!last.startsWith("credited")) fail(`deposit not credited within ${waitSec}s (last: ${last}). Finalization can take ~30s+; re-run without --send later to continue.`);
    acct = await account();
    printBalances(acct);
  } else {
    info("(dry: pass --send to actually deposit; continuing with existing balances)");
  }

  // ---------------------------------------------------------------- 4. tiny swap or bid
  step("Trade");
  const list = await pub.get<LaunchListResponse>("/api/launches?limit=200");
  const candidates = (list.body.launches ?? []).filter((l) => !l.isDemo && (!values.launch || l.id === values.launch));
  const tradeAmt = (l: LaunchSummary) => Number(values["trade-amount"] ?? (l.quoteAsset === "SOL" ? 0.002 : 1));
  const nowS = Math.floor(Date.now() / 1000);
  const live = candidates.find((l) => (l.status === "live" || l.status === "flywheel") && available(acct, l.quoteAsset) >= tradeAmt(l));
  const commit = candidates.find((l) => l.status === "commit" && l.auction.commitEndTs > nowS + 15 && available(acct, l.quoteAsset) >= Math.max(tradeAmt(l), l.auction.floorPrice));
  if (live) {
    const amt = tradeAmt(live);
    info(`swap: buy ${amt} ${live.quoteAsset} of ${live.ticker} (${live.id})`);
    const r = await api.post<OffchainSwapResponse>(CUSTODY_ROUTES.swap, { launchId: live.id, side: "buy", amountIn: amt, minAmountOut: 0 }, { "idempotency-key": `smoke-${kp.address.slice(0, 8)}-${Date.now()}` });
    if (r.status !== 200) info(`swap failed: HTTP ${r.status} ${r.body.error ?? ""}`);
    else info(`swap ok: got ${r.body.amountOut} ${live.ticker} @ ${r.body.price}, fee ${r.body.fee} ${live.quoteAsset}${r.body.isSniper ? " (flagged sniper)" : ""}`);
  } else if (commit) {
    const qd = QUOTE_ASSETS[commit.quoteAsset as QuoteAssetSymbol].decimals;
    const deposit = Math.max(tradeAmt(commit), commit.auction.floorPrice);
    const maxPrice = BigInt(Math.round(commit.auction.floorPrice * 10 ** qd)); // bid at the floor (on the tick grid)
    const bidAmount = BigInt(Math.round(deposit * 10 ** qd));
    const salt = randomSalt();
    const commitment = toHex(computeCommitment({ bidder: kp.address, maxPrice, bidAmount, salt }));
    const relayer = await pub.get<{ pubkey: string }>("/api/relayer/pubkey");
    const sealedReveal = sealReveal({
      launchId: commit.id, bidder: kp.address, commitmentHex: commitment, relayerPubkeyB64: relayer.body.pubkey,
      plaintext: { maxPrice: maxPrice.toString(), bidAmount: bidAmount.toString(), salt: toHex(salt) },
      signature: kp.sign(revealSignMessage(commit.id, commitment)),
    });
    info(`sealed bid on ${commit.ticker} (${commit.id}): deposit ${deposit} ${commit.quoteAsset} at the floor, auto-reveal envelope attached (salt not printed)`);
    const r = await api.post<{ bidId: string; bidCount: number }>(CUSTODY_ROUTES.commitBid, { launchId: commit.id, commitment, deposit, sealedReveal });
    if (r.status !== 200) info(`commit failed: HTTP ${r.status} ${r.body.error ?? ""}`);
    else info(`bid committed: bidCount=${r.body.bidCount}; the relayer reveals it when the reveal window opens; claim afterwards via POST ${CUSTODY_ROUTES.claim(commit.id)}`);
  } else {
    info(`no tradeable non-demo launch${values.launch ? ` matching ${values.launch}` : ""} for your balance — skipped (create one in the app, or deposit first)`);
  }

  // ---------------------------------------------------------------- 5. withdrawal
  step("Withdrawal");
  acct = await account();
  if (withdrawSol === 0) info("skipped (--withdraw 0)");
  else if (available(acct, "SOL") < withdrawSol) info(`skipped: available SOL ${available(acct, "SOL")} < ${withdrawSol}`);
  else {
    const r = await api.post<WithdrawalRecord>(CUSTODY_ROUTES.withdrawals, { asset: "SOL", amount: withdrawSol, destination: kp.address });
    if (r.status !== 201) info(`withdrawal request failed: HTTP ${r.status} ${r.body.error ?? ""}`);
    else {
      info(`requested ${withdrawSol} SOL → ${kp.address}: id=${r.body.id} status=${r.body.status}${r.body.reason ? ` (${r.body.reason})` : ""}`);
      if (!ci.body.payoutsEnabled) info("payouts are DISABLED on this API (no COMPANY_WALLET_SECRET_KEY): it stays queued until an operator approves/rejects it via /api/admin/withdrawals");
      else {
        let last = r.body.status as string;
        for (let i = 0; i < 12 && !["sent", "failed", "rejected"].includes(last); i++) {
          await sleep(5_000);
          const l = await api.get<{ withdrawals: WithdrawalRecord[] }>(CUSTODY_ROUTES.withdrawals);
          const w = l.body.withdrawals?.find((x) => x.id === r.body.id);
          if (w && w.status !== last) info(`status: ${w.status}${w.signature ? ` sig=${w.signature}` : ""}${w.reason ? ` (${w.reason})` : ""}`);
          last = w?.status ?? last;
        }
      }
    }
  }

  // ---------------------------------------------------------------- 6. summary
  step("Final state");
  printBalances(await account());
  const ws = await api.get<{ withdrawals: WithdrawalRecord[] }>(CUSTODY_ROUTES.withdrawals);
  for (const w of (ws.body.withdrawals ?? []).slice(0, 5)) info(`withdrawal ${w.id.slice(0, 8)}… ${w.amount} ${w.asset} ${w.status}${w.signature ? ` sig=${w.signature}` : ""}`);
  const ds = await api.get<{ deposits: DepositRecord[] }>(CUSTODY_ROUTES.deposits);
  for (const d of (ds.body.deposits ?? []).slice(0, 5)) info(`deposit ${d.signature.slice(0, 12)}… ${d.amount} ${d.asset} ${d.status}`);
  await api.post("/api/auth/logout").catch(() => undefined);
  console.log("\n✓ smoke run complete (session logged out)");
}

main().catch((e) => fail((e as Error).message ?? String(e)));
