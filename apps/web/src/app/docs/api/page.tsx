import type { Metadata } from "next";
import { API_ROUTES, CUSTODY_ROUTES, PROGRAM_ID, WITHDRAWAL_LIMITS } from "@sealed/shared";
import { MAINNET_COMMIT_WINDOW } from "@/components/docs/Mainnet";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { A, Accent, C, DocHeader, H2, H3, Note, P, StatusBadge, Table, UL } from "@/components/docs/Prose";

export const metadata: Metadata = { title: "API reference" };

const PUBLIC: Array<[string, string, string]> = [
  ["GET", API_ROUTES.health, "HealthResponse: network, isDemo, db, cache, redacted rpc, programId, uptime, version. Also /health."],
  ["GET", API_ROUTES.stats, "ProtocolStats: volume, fees, credit deployed/repaid, solvency, burns, payouts, counts."],
  ["GET", `${API_ROUTES.launches}?status=&quote=&limit=`, "LaunchListResponse. status: a LaunchStatus or auctions | vaults | graduated; quote: a symbol, stocks or all; limit 1 to 200 (50)."],
  ["GET", API_ROUTES.launch(":idOrMint"), "LaunchSummary, 404 if unknown."],
  ["GET", `${API_ROUTES.trades(":idOrMint")}?limit=`, "{ trades: Trade[] }"],
  ["GET", `${API_ROUTES.chart(":idOrMint")}?interval=1m|5m|1h`, "{ points: PricePoint[] }"],
  ["POST", API_ROUTES.launches, `Offchain mode with a bearer token (required when not in demo): creates a real launch with creator = session wallet. On mainnet the commit window must be ${MAINNET_COMMIT_WINDOW} and the quote asset SOL or USDC (rolling out). Demo without a token: in-memory demo launch. Onchain mode, not demo: 501 \"sign client-side\" with create_launch args in atoms. 400 on invalid input (e.g. > 200 bps).`],
  ["GET", API_ROUTES.auction(":idOrMint"), "{ launch, serverTimeTs }, public aggregates only."],
  ["POST", API_ROUTES.demoBid(":idOrMint"), "Demo only (403 otherwise; disabled on mainnet). { commitment, deposit, wallet? }; 409 if the commit window is closed."],
  ["GET", API_ROUTES.vault(":mint"), "{ launch, recentBuybacks (30), serverTimeTs }"],
  ["GET", API_ROUTES.rewards(":mint", ":wallet"), "HolderReward: staked, claimable, claimed, eligible (false for snipers)."],
  ["GET", API_ROUTES.revenue, "{ stats, recentBuybacks, ledger, daily (14 days) }"],
  ["GET", API_ROUTES.relayerPubkey, "{ pubkey (base64 x25519), relayerAddress }"],
  ["POST", API_ROUTES.relayerReveals, "SealedRevealEnvelope → { accepted, id }. 400 malformed / wrong key / bad payload, 401 bad signature, 404, 409 window closed."],
  ["GET", API_ROUTES.privacyStatus, "PrivacyStatusResponse: available, simulated, ringId, escrowFunding, reason."],
  ["POST", API_ROUTES.privacyRpc, "{ method, params } → raw Helius JSON-RPC (8 whitelisted methods, 120/min/IP)."],
  ["POST", "/api/rpc", "Browser RPC proxy (rolling out). JSON-RPC 2.0 body { jsonrpc, id, method, params } for an allowlisted set of Solana methods; others are rejected. Rate-limited per client (429). The RPC provider key stays on the server."],
  ["GET", API_ROUTES.llms, "text/plain agent guide, generated from live config and shared constants."],
];

const CUSTODY: Array<[string, string, string, string]> = [
  ["GET", CUSTODY_ROUTES.info, "CustodyInfoResponse: companyWallet, network, mode, payoutsEnabled, proofOfReserves[] (cached ~30 s)", "none"],
  ["POST", CUSTODY_ROUTES.nonce, "{ wallet } → { nonce, message, expiresTs } (nonce valid 5 min; 429 when rate-limited)", "none"],
  ["POST", CUSTODY_ROUTES.verify, "{ wallet, nonce, signature (base58) } → { token, wallet, expiresTs } (7-day session; 401 bad/expired/replayed nonce)", "none"],
  ["GET", "/api/auth/session", "→ { wallet } for a live token, else 401", "bearer"],
  ["POST", "/api/auth/logout", "revokes the presented token → { ok: true }", "bearer"],
  ["GET", CUSTODY_ROUTES.me, "AccountResponse: wallet, balances (available / locked), depositRef, companyWallet, network, sniperFlags", "bearer"],
  ["GET", CUSTODY_ROUTES.depositInstructions(":asset" as never), "DepositInstructions: companyWallet, memo, asset, mint, minConfirmations, note. 400 for an unknown asset or one with no mint on this network", "bearer"],
  ["GET", CUSTODY_ROUTES.deposits, "→ { deposits: DepositRecord[] } (latest 100)", "bearer"],
  ["POST", CUSTODY_ROUTES.deposits, "{ signature } nudges detection → 200 DepositRecord; 202 not yet finalized or not found (picked up automatically later); 404 the transaction holds no deposit for your memo; 400 failed tx; 503 no RPC configured", "bearer"],
  ["GET", CUSTODY_ROUTES.withdrawals, "→ { withdrawals: WithdrawalRecord[] } (latest 100)", "bearer"],
  ["POST", CUSTODY_ROUTES.withdrawals, `{ asset, amount, destination } → 201 WithdrawalRecord: queued at or under $${WITHDRAWAL_LIMITS.autoApproveMaxUsd.toLocaleString("en-US")} and within $${WITHDRAWAL_LIMITS.dailyPerWalletUsd.toLocaleString("en-US")}/day at a fresh live price, otherwise pending_approval. On mainnet only SOL and USDC withdraw; launched tokens are refused (rolling out). 4xx on insufficient funds / bad destination / unsupported asset`, "bearer"],
  ["POST", CUSTODY_ROUTES.commitBid, "{ launchId, commitment, deposit, sealedReveal? } → { bidId, bidCount }. 409 window closed or second bid", "bearer"],
  ["POST", CUSTODY_ROUTES.reveal, "{ launchId, maxPrice, bidAmount, salt } (atoms as decimal strings, salt 64 hex) → { revealed: true }", "bearer"],
  ["POST", CUSTODY_ROUTES.swap, "{ launchId, side, amountIn, minAmountOut } → { tradeId, amountIn, amountOut, fee, price, isSniper }. Optional Idempotency-Key header", "bearer"],
  ["POST", CUSTODY_ROUTES.claim(":launchId"), "after clearing → { tokens, refund }", "bearer"],
  ["POST", CUSTODY_ROUTES.stake, "{ launchId, amount }; a negative amount unstakes → { staked, eligible }. Optional Idempotency-Key", "bearer"],
  ["POST", CUSTODY_ROUTES.claimRewards(":launchId"), "→ { amount }", "bearer"],
  ["GET", `${CUSTODY_ROUTES.adminWithdrawals}?status=`, "operator queue (default pending_approval, queued, sending) → { withdrawals, payoutsEnabled }. Requires ADMIN_TOKEN", "x-admin-token"],
  ["POST", CUSTODY_ROUTES.adminWithdrawals, "{ id, action: approve | reject, reason? } → WithdrawalRecord. Approve moves pending_approval → queued; reject unlocks funds", "x-admin-token"],
  ["POST", "/api/admin/credit-pool/seed", "{ asset, amount, reference } → { ok, asset, amount, txId, replayed }. Records company funds as credit_pool; idempotent on reference (409 on conflicting replay)", "x-admin-token"],
];

const Method = ({ m }: { m: string }) => <span className="num whitespace-nowrap text-[11px] font-semibold text-ink">{m}</span>;

export default function ApiReference() {
  return (
    <>
      <DocHeader
        n="09"
        kicker="API reference"
        title={
          <>
            JSON over REST, events over <Accent>/ws</Accent>, a guide at /llms.txt.
          </>
        }
        lede="The Fastify API is the single backend for the web app and for agents. The contract is typed in packages/shared/src/api.ts, ws.ts and custody.ts."
      >
        <StatusBadge status="offchain-passing" label="Public REST + WS · tests passing" />
        <StatusBadge status="offchain-passing" label="Custody + trade routes · tests passing" />
        <StatusBadge status="rolling" label="Mainnet · rolling out" />
      </DocHeader>

      <H2 id="conventions" n="9.1">Conventions</H2>
      <UL>
        <li>
          Base URL: <C>https://api-production-01dc1743.up.railway.app</C> (Solana mainnet, real funds, rolling out) or your own host (local{" "}
          <C>http://localhost:4000</C>). REST under <C>/api</C>. Check <C>network</C> and <C>isDemo</C> in <C>/api/health</C> first.
        </li>
        <li>Amounts are UI units (JS numbers already divided by decimals); on-chain code uses bigint atoms. Prices are quote per whole token; tokens have 6 decimals.</li>
        <li>Timestamps are unix seconds. Use <C>serverTimeTs</C> to correct your clock before computing countdowns.</li>
        <li>
          Errors: <C>{'{ "error": string, "details"?: unknown }'}</C> with a 4xx/5xx status. Unknown routes return 404 <C>route not found</C>.
        </li>
        <li>CORS from <C>CORS_ORIGIN</C>; body limit 256 KB (32 KB on the privacy proxy).</li>
      </UL>

      <H2 id="public" n="9.2">Public endpoints</H2>
      <Table
        dense
        head={["Method", "Path", "Returns"]}
        colClass={["", "min-w-[13rem]", "min-w-[16rem]"]}
        rows={PUBLIC.map(([m, p, d]) => [<Method key="m" m={m} />, <C key="p">{p}</C>, d])}
      />
      <H3 id="ex-health">Example: health</H3>
      <CodeBlock
        lang="json"
        title="GET /api/health (mainnet)"
        code={`{
  "ok": true,
  "network": "mainnet",
  "isDemo": false,
  "db": "postgres",
  "cache": "redis",
  "rpc": "https://mainnet.helius-rpc.com/?api-key=***",
  "programId": "${PROGRAM_ID}",
  "uptimeSec": 221,
  "version": "0.1.0"
}`}
      />
      <H3 id="ex-launch">Example: a launch in reveal</H3>
      <CodeBlock
        lang="json"
        title="GET /api/launches?status=auctions&limit=1 (trimmed)"
        code={`{
  "launches": [{
    "id": "Ccrm8zMN6fJFrHGnm9dHHKAquAPTJdJsX2xj7LgGKZXw",
    "mint": "EH5Z1R2MGW2iXAMX9yudQm39xxFZQ8ittkUgNwU4HLty",
    "name": "Solstice", "ticker": "SOLST",
    "creatorAllocationBps": 50, "totalSupply": 1000000000,
    "quoteAsset": "SOL", "creditTier": "plus", "status": "reveal",
    "auction": {
      "commitStartTs": 1795691227, "commitEndTs": 1795692427, "revealEndTs": 1795692547,
      "bidCount": 120, "revealedCount": 43, "escrowedWallets": 100, "totalEscrowed": 354.135,
      "floorPrice": 3.1846375e-7, "tickSize": 1.59231875e-8, "tokensForSale": 400000000,
      "targetRaise": 231.61, "clearingCap": 347.415, "clearingPrice": null, "totalRaised": null
    },
    "market": null, "vault": null, "credit": null,
    "network": "mainnet", "isDemo": false
  }],
  "total": 5
}`}
      />
      <P>
        After graduation <C>market</C>, <C>vault</C> (creditLine, balance, dripAmount, nextDripTs, dripsExecuted, tokensBurned…) and <C>credit</C> (repaid,
        repaidPct, phase, feesCollected, holderPayouts…) are populated. No per-bid field is ever exposed before clearing.
      </P>
      <Note title="Mainnet" tone="warn">
        <p>
          On mainnet the API is custodial with real funds: deposits go to the company wallet, only SOL and USDC are enabled, withdrawals may need manual
          approval, and launched tokens cannot be withdrawn on-chain yet. Demo endpoints are disabled. Read <A href="/docs/custody">Custody</A> first.
        </p>
      </Note>
      <H3 id="ex-create">Example: create a launch (local demo)</H3>
      <CodeBlock
        lang="bash"
        title="curl"
        code={`curl -s -X POST http://localhost:4000/api/launches \\
  -H 'content-type: application/json' \\
  -d '{"name":"Quiet Money","ticker":"QUIET","quoteAsset":"USDC","creditTier":"standard",
       "creatorAllocationBps":150,"auctionSupplyBps":4000,"commitDurationSec":1200,
       "revealDurationSec":120,"floorPrice":0.0001,"tickSize":0.000005,
       "targetRaise":50000,"clearingCap":75000}'`}
      />

      <H2 id="custody" n="9.3">Custody and trading endpoints</H2>
      <P>
        Defined in <C>CUSTODY_ROUTES</C> and implemented in <C>apps/api/src/routes/</C> (<C>auth.ts</C>, <C>account.ts</C>, <C>trade.ts</C>,{" "}
        <C>custody.ts</C>, <C>admin.ts</C>). Everything except <C>/api/custody/info</C>, nonce and verify requires{" "}
        <C>Authorization: Bearer &lt;token&gt;</C> from <A href="/docs/custody">SIWS sign-in</A>; the acting wallet is always the session wallet, never a
        body field. Admin routes take the header <C>x-admin-token: &lt;ADMIN_TOKEN&gt;</C> and answer 503 when <C>ADMIN_TOKEN</C> is unset; on mainnet
        every approval requires it. Trade routes
        answer 503 when the offchain ledger is unavailable or <C>EXECUTION_MODE=onchain</C>. Account and withdrawal writes are rate-limited (429).
      </P>
      <Table
        dense
        head={["Method", "Path", "Body → response", "Auth"]}
        colClass={["", "min-w-[13rem]", "min-w-[16rem]", ""]}
        rows={CUSTODY.map(([m, p, d, auth]) => [<Method key="m" m={m} />, <C key="p">{p}</C>, d, auth])}
      />
      <CodeBlock
        lang="json"
        title="POST /api/account/deposits: 202 while the transaction is not final yet"
        code={`{ "id": "<signature>", "signature": "<signature>", "asset": "SOL", "amount": 0, "status": "detected",
  "ts": 1795692450, "reason": "not yet finalized (or not found); it will be picked up automatically" }`}
      />
      <CodeBlock
        lang="bash"
        title="operator: seed the credit pool"
        code={`curl -s -X POST "$API/api/admin/credit-pool/seed" \\
  -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \\
  -d '{"asset":"SOL","amount":50,"reference":"<funding tx signature>"}'`}
      />
      <CodeBlock
        lang="ts"
        title="Sign in and read your account"
        code={`import bs58 from "bs58";

const api = "http://localhost:4000";
const { nonce, message } = await fetch(\`\${api}/api/auth/nonce\`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ wallet: wallet.publicKey.toBase58() }),
}).then((r) => r.json());

const signature = bs58.encode(await wallet.signMessage(new TextEncoder().encode(message)));
const { token } = await fetch(\`\${api}/api/auth/verify\`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ wallet: wallet.publicKey.toBase58(), nonce, signature }),
}).then((r) => r.json());

const account = await fetch(\`\${api}/api/account\`, { headers: { authorization: \`Bearer \${token}\` } }).then((r) => r.json());
// account.depositRef → send funds to account.companyWallet with memo "sealed:" + depositRef`}
      />

      <H2 id="ws" n="9.4">WebSocket</H2>
      <P>
        Connect to <C>/ws</C>. Subscribing sends an immediate snapshot (<C>stats.updated</C> for global, <C>launch.updated</C> for a launch). The server
        pings to detect dead sockets; clients may send <C>{'{"op":"ping"}'}</C> and receive <C>{'{"type":"pong","ts":…}'}</C>.
      </P>
      <CodeBlock
        lang="json"
        title="client → server"
        code={`{ "op": "subscribe",   "channels": ["global", "launch:<launchId>"] }
{ "op": "unsubscribe", "channels": ["launch:<launchId>"] }
{ "op": "ping" }`}
      />
      <CodeBlock
        lang="json"
        title="server → client envelope"
        code={`{ "type": "vault.drip", "channel": "global", "ts": 1795692450,
  "data": { "launchId": "…", "ticker": "LANE", "quoteSpent": 0.52, "tokensBurned": 20123.4,
            "dripIndex": 16, "nextDripTs": 1795692630, "vaultBalance": 11.9, "…": "…" } }`}
      />
      <Table
        dense
        head={["Event", "Data"]}
        rows={[
          [<C key="e">launch.created · launch.updated</C>, "LaunchSummary"],
          [<C key="e">auction.bid_committed</C>, "launchId, bidCount, escrowedWallets, totalEscrowed"],
          [<C key="e">auction.bid_revealed</C>, "launchId, revealedCount, bidCount"],
          [<C key="e">auction.phase_changed</C>, "launchId, from, to"],
          [<C key="e">auction.cleared</C>, "launchId, clearingPrice, totalRaised, winners"],
          [<C key="e">trade</C>, "Trade (launch channel)"],
          [<C key="e">vault.drip</C>, "BuybackEvent + nextDripTs + vaultBalance"],
          [<C key="e">credit.ledger</C>, "CreditLedgerEntry + repaidPct"],
          [<C key="e">credit.flywheel_activated</C>, "launchId, ts"],
          [<C key="e">stats.updated</C>, "ProtocolStats, every ~3 s on global"],
        ]}
        caption="'global' carries stats, creations, phase changes, bid counters, clears, flywheel activations and all buybacks. 'launch:<id>' carries everything for one launch."
      />

      <H2 id="llms" n="9.5">/llms.txt for AI agents</H2>
      <P>
        <C>GET /llms.txt</C> returns a plain-text guide rendered from the running config: mode (demo or live), network (mainnet on the hosted API), the
        real-funds custody disclosure, program id, REST and WS URLs, the
        mechanics with numbers pulled from shared constants, every endpoint with example JSON, the WS protocol, a step-by-step &ldquo;how an agent
        participates&rdquo; recipe (discover → bid → auto-reveal → settle → trade and earn) and the Privacy Ring status. Point an agent at it first.
      </P>
      <CodeBlock lang="bash" title="fetch the agent guide" code={`curl -s http://localhost:4000/llms.txt | head -40`} />
      <Note>
        <p>Privacy guarantee: the API never returns individual bid amounts, prices or commitments for launches in commit or reveal.</p>
      </Note>
    </>
  );
}
