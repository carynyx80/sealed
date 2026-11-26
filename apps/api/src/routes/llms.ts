import type { FastifyInstance } from "fastify";
import {
  ANTI_SNIPE_WINDOW_SEC,
  COMPANY_WALLET,
  CREDIT_TIERS,
  DEPOSIT_MEMO_PREFIX,
  DEFAULT_DRIP_INTERVAL_SEC,
  MAX_COMMIT_DURATION_SEC,
  MAX_CREATOR_ALLOCATION_BPS,
  MIN_COMMIT_DURATION_SEC_DEVNET,
  MIN_COMMIT_DURATION_SEC_MAINNET,
  NO_REVEAL_SLASH_BPS,
  NUM_PRICE_TICKS,
  POOL_FEE_BPS,
  QUOTE_ASSET_LIST,
  SIWS_STATEMENT,
  STOCK_QUOTE_ASSETS,
  WITHDRAWAL_LIMITS,
} from "@sealed/shared";
import type { AppContext } from "../context.js";

export function renderLlmsTxt(ctx: AppContext, baseUrl: string): string {
  const { cfg } = ctx;
  const ws = baseUrl.replace(/^http/, "ws") + "/ws";
  const mode = cfg.isDemo ? "DEMO (simulated data, devnet-labelled; no real funds)" : cfg.network === "mainnet" ? "MAINNET (live, REAL FUNDS, custodial)" : `${cfg.network.toUpperCase()} (live on-chain data)`;
  const quotes = QUOTE_ASSET_LIST.map((q) => `${q.symbol} (${q.name}, ${q.kind})`).join(", ");
  const stocks = STOCK_QUOTE_ASSETS.map((q) => q.symbol).join(", ");
  const commitWindow = `${MIN_COMMIT_DURATION_SEC_MAINNET / 60}–${MAX_COMMIT_DURATION_SEC / 60} min`;
  const offchain = cfg.executionMode === "offchain";
  const execMode = offchain
    ? "offchain (custodial, default): the Sealed backend runs auctions, clearing, the pool, drips, fee splits and rewards in a double-entry ledger"
    : "onchain: the sealed_launchpad Anchor program is the source of truth; agents sign program transactions";
  return `# Sealed-Block Launchpad — agent guide

> A Solana token launchpad where every launch starts with a sealed-bid (commit-reveal) uniform-price auction,
> graduates into a locked pool, and receives a protocol fee-credit line that funds programmatic buy-and-burn
> drips (the first one interval after graduation). Trading fees repay the credit, then flow to holders forever.

Mode: ${mode}
Execution mode: ${execMode}
Network: ${cfg.network}
Program id: ${cfg.programId}
Website: https://www.sealedsol.xyz
Hosted API: https://api-production-01dc1743.up.railway.app
Company wallet (custody): ${COMPANY_WALLET}  https://explorer.solana.com/address/${COMPANY_WALLET}
REST base: ${baseUrl}
WebSocket: ${ws}
All amounts in this API are UI units (JS numbers, already divided by decimals). Prices are quote per whole token
(launched tokens always have 6 decimals). Timestamps are unix seconds. Errors are {"error": string, "details"?: any}.

## 0. Mainnet facts and custodial risk disclosure (read first)

Mainnet base facts (the hosted service is switching from devnet to Solana MAINNET with REAL FUNDS; rolling out —
confirm "network":"mainnet" in GET /api/health and GET /api/custody/info before acting):
- Network: Solana mainnet. Explorer links need no cluster parameter.
- Custody: the company holds all deposits in ${COMPANY_WALLET}. Balances are Sealed ledger entries.
- Demo mode is disabled on mainnet: no demo launches, no demo-bid, no simulated data. isDemo is false.
- Enabled quote / deposit assets on mainnet: SOL and USDC. Tokenized stocks (${stocks}) are coming soon (mainnet
  mints not verified); do not send them.
- Launches on mainnet require a ${commitWindow} commit window.
- Withdrawals: only SOL and USDC can be withdrawn on-chain. Launched tokens exist only as custodial Sealed ledger
  balances and cannot be withdrawn on-chain yet. Withdrawal USD limits use live Jupiter Price API prices; with no fresh
  price a withdrawal goes to pending_approval (manual). Payouts pause, with a reason, when the company wallet lacks
  SOL for network fees. Operator approvals require ADMIN_TOKEN.
- Browser RPC: POST /api/rpc proxies an allowlist of JSON-RPC methods, rate limited; the provider key is never exposed.
- The Anchor program (onchain, non-custodial mode) is roadmap only and is not deployed.

Risk disclosure. In the default offchain mode Sealed is CUSTODIAL. Deposits leave your wallet and sit in the company wallet
${COMPANY_WALLET}; your balance is a ledger entry, not an on-chain account you control. The operator can see
your bids once submitted, can pause, delay or refuse withdrawals, and a compromised operator key could lose funds.
There is no insurance and no audit (neither the backend nor the program has been audited). Withdrawals may need
manual approval and can be delayed. Proof of reserves (GET /api/custody/info) compares the company wallet's
on-chain balances with ledger liabilities; it does not prove the ledger is complete or that the key is safe.
Payouts only run once the operator has configured the company wallet key: check "payoutsEnabled" in
GET /api/custody/info before depositing anything. Deposit detection likewise needs a Helius/Solana RPC on the API
(POST /api/account/deposits answers 503 without one). The Anchor program (onchain mode) is the future
non-custodial alternative and is not deployed.
Sealed is not a bank, broker or licensed custodian, and nothing here is investment advice. Users and agent operators
are responsible for complying with the laws of their own jurisdiction (including securities, tax and sanctions
rules); do not use Sealed where it is prohibited. Deposit only what you can afford to lose.

## 1. Mechanics

Phase 1 — Launch setup (creator)
- Name, ticker, description, image, quote asset, auction timing, floor price, tick size, target raise, clearing cap.
- Quote assets in the registry: ${quotes}. On mainnet only SOL and USDC are enabled; the stocks are coming soon.
- Creator allocation is hard-capped at ${MAX_CREATOR_ALLOCATION_BPS} bps (2%) of supply, enforced on-chain (CreatorAllocationTooHigh).

Phase 2 — Sealed auction (status "commit" then "reveal")
- Commit window (${commitWindow} mainnet, ≥${MIN_COMMIT_DURATION_SEC_DEVNET / 60} min devnet): a bidder deposits collateral into escrow and submits
  commitment = keccak256(bidder_pubkey(32) || max_price u64 LE || bid_amount u64 LE || salt(32)).
- max_price must be on the tick grid: floor + i * tick, 0 ≤ i < ${NUM_PRICE_TICKS} (quote atoms per whole token).
- Publicly visible: bid count, escrowed wallets, total escrowed, time remaining. Individual bid sizes and prices
  are NEVER published (not on-chain, not by this API) until clearing.
- Reveal window (~2 min): anyone holding the preimage calls reveal_bid. Use the auto-reveal relayer (section 4)
  so you never miss it. Unrevealed bids are refunded minus a ${NO_REVEAL_SLASH_BPS / 100}% slash.
- Clearing: bids sorted by max_price desc; everyone who clears pays the same uniform clearing price.
  Losing / unfilled amounts are refunded via claim_or_refund.

Phase 3 — Graduation (status "live")
- Raised quote + pool token allocation seed Sealed's own constant-product pool (a ledger pool offchain, a
  program-owned pool onchain; not Raydium). No LP tokens exist, so liquidity is permanently locked. Every swap
  pays a ${POOL_FEE_BPS / 100}% fee to the launch's fee collector.
- The protocol credit pool advances a fee-credit line of ${CREDIT_TIERS.standard / 100}–${CREDIT_TIERS.premier / 100}% of the raise
  (tiers: standard ${CREDIT_TIERS.standard / 100}%, plus ${CREDIT_TIERS.plus / 100}%, premier ${CREDIT_TIERS.premier / 100}%) into a
  NON-WITHDRAWABLE buyback vault. Every ~${DEFAULT_DRIP_INTERVAL_SEC / 60} minutes (first drip one interval after graduation) a drip
  (offchain: the backend scheduler; onchain: permissionless execute_buyback_drip) swaps through the pool and burns the
  tokens bought. vault.nextDripTs is the public countdown. Offchain, the credit line is capped by the protocol
  credit pool balance; if the operator has not funded it, a launch graduates straight to the flywheel split.

Phase 4 — Repay then flywheel (status "live" → "flywheel")
- While credit is outstanding: 80% of fees repay the credit pool, 20% platform burn/ops.
- After 100% repayment: 50% to stakers/holders in the quote asset, 35% platform buyback-and-burn, 15% treasury.
  (The platform shares accrue as quote; buying and burning a platform token with them is not built yet.)
- Anti-snipe: wallets that buy in the same slot as graduation (offchain: within ${ANTI_SNIPE_WINDOW_SEC}s) are recorded and earn 0%
  holder rewards (eligible=false).

Status values: commit | reveal | clearing | live | flywheel | failed

## 2. REST endpoints

GET /api/health
  {"ok":true,"network":"mainnet","isDemo":false,"db":"postgres","cache":"redis","rpc":"https://mainnet.helius-rpc.com/?api-key=***","programId":"${cfg.programId}","uptimeSec":42,"version":"${cfg.version}"}

GET /api/stats  → ProtocolStats
  {"totalVolumeUsd":1234567.8,"totalFeesUsd":12345.6,"activeBuybackCreditUsd":45000,"totalCreditDeployedUsd":210000,
   "totalCreditRepaidUsd":150000,"solvencyRatio":4.7,"totalTokensBurnedUsd":88000,"platformTokensBurned":1200000,
   "holderPayoutsUsd":9100,"liveAuctions":5,"activeVaults":4,"graduatedFlywheels":3,"snipersBlocked":41,
   "network":"devnet","isDemo":true,"updatedTs":1764150000}

GET /api/launches?status=&quote=&limit=  → {"launches": LaunchSummary[], "total": number}
  status: commit|reveal|clearing|live|flywheel|failed, or tab aliases auctions (commit+reveal+clearing),
          vaults (live), graduated (flywheel)
  quote:  SOL|USDC|NVDAx|TSLAx|TTWOx|AAPLx|SPYx|stocks|all       limit: 1–200 (default 50)
  Example: GET /api/launches?status=auctions&quote=stocks&limit=10
  LaunchSummary:
  {"id":"<launch PDA>","mint":"<token mint>","name":"Silicon Saints","ticker":"SAINT","description":"...",
   "imageUri":"...","creator":"<pubkey>","creatorAllocationBps":100,"totalSupply":1000000000,"quoteAsset":"NVDAx",
   "creditTier":"plus","status":"commit","createdTs":1764149000,
   "auction":{"commitStartTs":1764149060,"commitEndTs":1764150260,"revealEndTs":1764150380,"bidCount":57,
              "revealedCount":0,"escrowedWallets":49,"totalEscrowed":912.4,"floorPrice":0.0000012,"tickSize":0.00000006,
              "tokensForSale":400000000,"targetRaise":1200,"clearingCap":1800,"clearingPrice":null,"totalRaised":null},
   "market":null,"vault":null,"credit":null,"network":"devnet","isDemo":true}
  After graduation, market {price, priceUsd, change24hPct, volume24h, liquidityQuote, marketCapQuote, holders,
  graduationSlot, graduatedTs}, vault {creditLine, balance, dripAmount, dripIntervalSec, nextDripTs, dripsExecuted,
  dripsTotal, tokensBurned, quoteSpent} and credit {creditLine, repaid, repaidPct, phase, feesCollected,
  holderPayouts, platformBurnQuote, treasury} are populated.

GET /api/launches/:idOrMint            → LaunchSummary (404 if unknown)
GET /api/launches/:idOrMint/trades?limit=50
  {"trades":[{"id":"...","launchId":"...","side":"buy","wallet":"...","amountQuote":2.1,"amountToken":81234.5,
              "price":0.0000258,"signature":"...","slot":312345678,"ts":1764150001,"isBuyback":false,"isSniper":false}]}
GET /api/launches/:idOrMint/chart?interval=1m|5m|1h
  {"points":[{"ts":1764146400,"price":0.0000251,"volume":12.4}]}

POST /api/launches   (offchain mode with "Authorization: Bearer <token>" — required outside demo: creates a real
                      launch with creator = the signed-in wallet; demo mode without a token: an in-memory demo
                      launch; onchain mode outside demo: 501 "sign client-side" with the create_launch args in atoms)
  {"name":"Quiet Money","ticker":"QUIET","description":"Sealed bids only","quoteAsset":"USDC","creditTier":"standard",
   "totalSupply":1000000000,"creatorAllocationBps":150,"auctionSupplyBps":4000,"commitDurationSec":1200,
   "revealDurationSec":120,"floorPrice":0.0001,"tickSize":0.000005,"targetRaise":50000,"clearingCap":75000}
  → LaunchSummary. creatorAllocationBps > ${MAX_CREATOR_ALLOCATION_BPS} → 400.

GET /api/auctions/:idOrMint   → {"launch": LaunchSummary, "serverTimeTs": 1764150000}
  Public aggregates only. Use serverTimeTs to correct your clock before computing time remaining.
POST /api/auctions/:idOrMint/demo-bid   (demo mode only; disabled on mainnet)
  {"commitment":"<64 hex>","deposit":25,"wallet":"<optional pubkey>"}  → AuctionResponse with updated counters.

GET /api/vaults/:mint   → {"launch": LaunchSummary, "recentBuybacks": BuybackEvent[], "serverTimeTs": 1764150000}
  BuybackEvent: {"id":"...","launchId":"...","ticker":"LANE","quoteAsset":"SOL","quoteSpent":0.52,"tokensBurned":20123.4,
                 "price":0.0000258,"signature":"...","ts":1764150000,"dripIndex":16}

GET /api/rewards/:mint/:wallet
  {"launchId":"...","wallet":"...","staked":125000,"claimable":0.84,"claimed":1.2,"quoteAsset":"USDC","eligible":true}

GET /api/revenue
  {"stats":ProtocolStats,"recentBuybacks":BuybackEvent[],"ledger":CreditLedgerEntry[],
   "daily":[{"date":"2026-11-26","feesUsd":1200,"creditRepaidUsd":900,"burnedUsd":400,"holderPayoutsUsd":150}]}
  CreditLedgerEntry kinds: advance | repayment | flywheel_holder | flywheel_platform_burn | flywheel_treasury | platform_ops

GET /api/relayer/pubkey   → {"pubkey":"<base64 x25519>","relayerAddress":"<base58 fee payer>"}
POST /api/relayer/reveals → {"accepted":true,"id":"..."}   (body: SealedRevealEnvelope, see section 4)
  400 malformed / wrong relayer key / payload does not match commitment, 401 bad signature, 404 unknown launch,
  409 window closed.

## 2b. Custody and trade endpoints (offchain custodial mode)

All except /api/custody/info, /api/auth/nonce and /api/auth/verify need "Authorization: Bearer <token>". The acting
wallet is always the signed-in wallet, never a body field. Trade routes answer 503 if the offchain ledger is
unavailable or EXECUTION_MODE=onchain. Rate limits answer 429.

GET /api/custody/info   (public, cached ~30s)
  {"companyWallet":"${COMPANY_WALLET}","network":"${cfg.network}","mode":"offchain","payoutsEnabled":true,
   "proofOfReserves":[{"asset":"SOL","onchain":412.8,"liabilities":398.1,"ratio":1.037,"asOfTs":1764150000}]}

Sign in with Solana (SIWS)
POST /api/auth/nonce    {"wallet":"<base58>"}
  → {"nonce":"<nonce>","message":"<exact text to sign>","expiresTs":1764150300}   (nonce valid 5 min, single use)
  The message contains the statement "${SIWS_STATEMENT}"
POST /api/auth/verify   {"wallet":"<base58>","nonce":"<nonce>","signature":"<base58 ed25519 sig over utf8(message)>"}
  → {"token":"<session token>","wallet":"<base58>","expiresTs":1764755100}          (7-day session; 401 on bad sig)
GET  /api/auth/session  → {"wallet":"<base58>"}   (401 if missing / expired / revoked)
POST /api/auth/logout   → {"ok":true}             (revokes the presented token)

Account
GET /api/account
  {"wallet":"<base58>","balances":[{"asset":"SOL","symbol":"SOL","available":12.5,"locked":2},
   {"asset":"tok:<launchId>","symbol":"SAINT","available":81234.5,"locked":0,"launchId":"<launchId>"}],
   "depositRef":"<ref>","companyWallet":"${COMPANY_WALLET}","network":"${cfg.network}","sniperFlags":[]}
GET /api/account/deposit/:asset   (asset = SOL | USDC on mainnet; stocks only where a verified mint exists; else 400)
  {"companyWallet":"${COMPANY_WALLET}","memo":"${DEPOSIT_MEMO_PREFIX}<depositRef>","asset":"USDC","mint":"<mint or null for SOL>",
   "minConfirmations":32,"note":"..."}
  Deposit = an ordinary on-chain transfer to companyWallet carrying exactly that memo. No memo → not credited.
GET  /api/account/deposits        → {"deposits":[{"id":"...","signature":"...","asset":"SOL","amount":1.5,
                                      "status":"detected|confirmed|credited|rejected","ts":1764150000,"reason"?:"..."}]}
POST /api/account/deposits        {"signature":"<base58 tx signature>"}   nudge detection right after sending
  200 → DepositRecord
  202 → {"id":"<sig>","signature":"<sig>","asset":"SOL","amount":0,"status":"detected","ts":...,
         "reason":"not yet finalized (or not found); it will be picked up automatically"}
  404 → no deposit for your account in this transaction (check the memo);  400 → transaction failed on-chain;
  503 → no RPC configured / RPC unavailable
GET  /api/account/withdrawals     → {"withdrawals":[WithdrawalRecord]}
POST /api/account/withdrawals     {"asset":"SOL","amount":1,"destination":"<base58, usually your wallet>"}
  201 → {"id":"<uuid>","asset":"SOL","amount":1,"destination":"...","status":"queued","ts":1764150000}
  Statuses: queued | pending_approval | sending | sent | failed | rejected. Auto-approved (queued) up to
  $${WITHDRAWAL_LIMITS.autoApproveMaxUsd} USD-equivalent and within $${WITHDRAWAL_LIMITS.dailyPerWalletUsd}/day per wallet; otherwise pending_approval until an
  operator acts. Limits are valued at live Jupiter prices; with no fresh price the request is pending_approval.
  Only SOL and USDC withdraw; launched-token balances cannot be withdrawn on-chain yet.
  queued withdrawals are only sent while payoutsEnabled is true and the company wallet holds SOL for fees; until
  then they wait, funds locked.

Trading (amounts in UI units unless noted; optional "Idempotency-Key" header on swap and stake)
POST /api/trade/commit   {"launchId":"...","commitment":"<64 hex>","deposit":25,"sealedReveal":<optional SealedRevealEnvelope>}
  → {"bidId":"...","bidCount":58}     commitment = keccak256(your_wallet || u64le(maxPrice) || u64le(bidAmount) || salt),
  same preimage as onchain; deposit is locked from your available quote balance. 409 window closed / bid exists.
POST /api/trade/reveal   {"launchId":"...","maxPrice":"<u64 atoms>","bidAmount":"<u64 atoms>","salt":"<64 hex>"}
  → {"revealed":true}   (reveal window only; or pass sealedReveal at commit for auto-reveal)
POST /api/trade/claim/:launchId   → {"tokens":400000,"refund":3.2}   (after clearing)
POST /api/trade/swap     {"launchId":"...","side":"buy","amountIn":1.5,"minAmountOut":50000}
  → {"tradeId":"...","amountIn":1.5,"amountOut":51234.1,"fee":0.015,"price":0.0000290,"isSniper":false}
  amountIn is quote for buy, tokens for sell.
POST /api/trade/stake    {"launchId":"...","amount":50000}   (negative amount unstakes) → {"staked":50000,"eligible":true}
POST /api/trade/rewards/:launchId → {"amount":0.84}

Operator only (header "x-admin-token: <ADMIN_TOKEN>"; 503 if unset): GET/POST /api/admin/withdrawals (list, approve,
reject) and POST /api/admin/credit-pool/seed {"asset","amount","reference"}. Agents do not need these.

Browser RPC proxy (rolling out)
POST /api/rpc   {"jsonrpc":"2.0","id":1,"method":"<allowlisted method>","params":[...]}  → raw JSON-RPC response.
  Methods outside the allowlist are rejected; rate limited per client (429). The RPC provider key stays server-side.

## 3. WebSocket (${ws})

Client → server:
  {"op":"subscribe","channels":["global","launch:<launchId>"]}
  {"op":"unsubscribe","channels":["launch:<launchId>"]}
  {"op":"ping"}                       → {"type":"pong","ts":...}
Server → client: {"type": <event>, "data": {...}, "channel": "global"|"launch:<id>", "ts": unix}
  On subscribe you immediately receive a snapshot (stats.updated for global, launch.updated for a launch).
Events: launch.created, launch.updated, auction.bid_committed {launchId,bidCount,escrowedWallets,totalEscrowed},
  auction.bid_revealed {launchId,revealedCount,bidCount}, auction.phase_changed {launchId,from,to},
  auction.cleared {launchId,clearingPrice,totalRaised,winners}, trade (Trade),
  vault.drip (BuybackEvent + nextDripTs + vaultBalance), credit.ledger (CreditLedgerEntry + repaidPct),
  credit.flywheel_activated {launchId,ts}, stats.updated (ProtocolStats, every ~3s on global).
"global" carries stats, creations, phase changes, bid counters, clears, flywheel activations and all buybacks.
"launch:<id>" carries everything for one launch, including trades.

Example (Node):
  const ws = new WebSocket("${ws}");
  ws.onopen = () => ws.send(JSON.stringify({ op: "subscribe", channels: ["global"] }));
  ws.onmessage = (m) => { const e = JSON.parse(m.data); if (e.type === "vault.drip") console.log(e.data.ticker, e.data.quoteSpent); };

## 4. How an agent participates

Offchain custodial mode (default${offchain ? ", active on this server" : ""})
  a. Read section 0. GET /api/custody/info; continue only if you accept custody (and payoutsEnabled for withdrawals).
  b. Sign in: /api/auth/nonce → sign message → /api/auth/verify → keep the bearer token.
  c. GET /api/account/deposit/SOL → transfer to companyWallet with the memo → POST /api/account/deposits {signature}
     → poll GET /api/account until the balance is available.
  d. Pick a launch (GET /api/launches?status=auctions), build the commitment with your signed-in wallet as bidder,
     POST /api/trade/commit (with sealedReveal for auto-reveal), or POST /api/trade/reveal yourself in the window.
  e. After clearing POST /api/trade/claim/:launchId; then swap / stake / claim rewards via /api/trade/*.
  f. POST /api/account/withdrawals to take SOL or USDC back on-chain (launched tokens stay on the ledger for now).

Onchain mode (roadmap; the program is not deployed yet)
Discover
  1. GET /api/launches?status=auctions → pick a launch; GET /api/auctions/:id for timing (commitEndTs, revealEndTs).
  2. Subscribe to "launch:<id>" for live bid counters and phase changes.

Bid (on-chain)
  3. Choose max_price on the tick grid (atoms of quote per whole token) and bid_amount ≤ deposit (atoms of quote).
  4. salt = 32 random bytes. commitment = keccak256(bidder || u64le(max_price) || u64le(bid_amount) || salt).
  5. Send commit_bid(commitment, deposit) during the commit window (bid PDA seeds: "bid", launch, bidder).
     One bid per bidder per launch.
Auto-reveal (recommended)
  6. GET /api/relayer/pubkey. Sign utf8("sealed-reveal:v1:<launchId>:<commitmentHexLowercase>") with the bidder key (ed25519).
  7. nacl.box-seal JSON {"maxPrice":"<u64>","bidAmount":"<u64>","salt":"<64 hex>"} to the relayer pubkey with a fresh
     ephemeral keypair and POST /api/relayer/reveals:
     {"version":1,"launchId":"...","bidder":"...","commitment":"<64 hex>","relayerPubkey":"<base64>",
      "ephemeralPubkey":"<base64>","nonce":"<base64 24 bytes>","ciphertext":"<base64>","signature":"<base64>"}
     (@sealed/shared exports sealReveal() which builds this envelope.) The relayer decrypts it once on submission to
     check it matches the commitment (plaintext discarded), then again when the reveal window opens, and submits
     reveal_bid for you. You may still reveal yourself at any time in the window.
Settle
  8. After revealEndTs anyone may call clear_auction; then claim_or_refund(stake) returns tokens and/or refunds.
Trade + earn
  9. Swap through the program pool (swap(amount_in, min_amount_out, is_buy)); watch vault.nextDripTs for the next
     buy-and-burn. Do NOT buy in the graduation slot — you will be flagged as a sniper and earn no rewards.
 10. stake(amount) → GET /api/rewards/:mint/:wallet → claim_rewards.
Keepers
  execute_buyback_drip and distribute_fees are permissionless; anyone may call them when due.

Privacy guarantee: this API never returns individual bid amounts, prices or commitments for launches in commit or reveal.

## 5. Private deposits (Helius Solana Privacy Rings, beta)

Why: the commitment hides max_price and bid_amount, but the escrow deposit of commit_bid is a public SPL transfer
and bounds your bid size from above. Helius Solana Privacy Rings (Default Ring) encrypt token amounts and balances
for SOL / SPL / Token-2022 (wallet addresses stay visible); owners decrypt with their viewing key.
Status
  GET /api/privacy/status → {"available":bool,"network":"devnet|mainnet|localnet","simulated":bool,"ringId"?:string,
                              "escrowFunding"?:bool,"reason"?:string}
  simulated=true in demo mode (no real funds; the demo marks such bids as privately funded).
  ringId is the Solana Privacy Program ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW when real.
Indexer proxy (our HELIUS_API_KEY stays server-side)
  POST /api/privacy/rpc {"method":"<name>","params":{...}} → raw JSON-RPC 2.0 response from Helius.
  Allowed methods: getEncryptedUtxosByTags, getShieldedTransactionsByTags, getShieldedTransactionsBySignature,
  getShieldedTransactionsByNullifiers, getMerkleProofs, getNonInclusionProofs, getNullifierQueueElements, getUserRecords.
  Example: {"method":"getUserRecords","params":{"owners":["<base58 wallet>"]}}
  Responses are ciphertexts; decryption happens locally with your viewing key (SDK @heliuslabs/spr, decryptToBalances).
On-chain today (${cfg.network})
  escrowFunding=false: the program escrow is a public token account and records bid.deposit in plaintext, and
  ring withdrawals publish their amount — so a private deposit cannot be made on-chain yet. Clients must not send
  privateDeposit bids on real networks until the commit_bid_shielded upgrade ships (see docs/PRIVACY.md).
Always public (by design): wallet addresses, aggregate totalEscrowed, buyback drips, protocol fees, clearing results.
`;
}

export async function llmsRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/llms.txt", async (req, reply) => {
    const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? req.protocol;
    const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? `localhost:${ctx.cfg.port}`;
    reply.type("text/plain; charset=utf-8");
    return renderLlmsTxt(ctx, `${proto}://${host}`);
  });
}
