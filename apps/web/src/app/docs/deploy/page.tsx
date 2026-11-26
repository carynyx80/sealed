import type { Metadata } from "next";
import { COMPANY_WALLET } from "@sealed/shared";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { COMPANY_WALLET_EXPLORER, MAINNET_COMMIT_WINDOW, RealFundsDisclosure } from "@/components/docs/Mainnet";
import { A, Accent, C, DocHeader, H2, H3, Note, OL, P, StatusBadge, Table, UL } from "@/components/docs/Prose";

export const metadata: Metadata = { title: "Deploy" };

const API_ENV: Array<[string, string, string]> = [
  ["EXECUTION_MODE", "offchain", "offchain (custodial, default) or onchain (roadmap)."],
  ["COMPANY_WALLET", COMPANY_WALLET, "Public address that receives deposits and is reported in proof of reserves."],
  ["COMPANY_WALLET_SECRET_KEY", "secret · operator-set", "Signs mainnet withdrawals from the company wallet. Unset → payoutsEnabled=false, no payout worker runs and every withdrawal stays queued (funds locked) until it is set or the withdrawal is rejected. Never commit it; store it only in the Railway secret store."],
  ["ADMIN_TOKEN", "secret", "Required on mainnet. Value of the x-admin-token header for /api/admin/withdrawals (list / approve / reject) and /api/admin/credit-pool/seed. Unset → admin routes answer 503. Use a long random value."],
  ["DEPOSIT_CONFIRMATIONS", "finalized", "\"finalized\" or an integer 1–1000 of confirmed-slot depth before a deposit is credited."],
  ["CUSTODY_WORKERS", "true", "Run the deposit watcher and payout worker. Default: WORKERS_ENABLED and not demo. Set it to true explicitly on mainnet."],
  ["SIWS_DOMAIN", "www.sealedsol.xyz", "Domain shown in, and checked against, the sign-in message. Must match the site users sign in on (the code default is sealed.app)."],
  ["DEPOSIT_POLL_MS / PAYOUT_POLL_MS / OFFCHAIN_TICK_MS", "15000 / 10000 / 2000", "Deposit watcher, payout worker and offchain scheduler cadence."],
  ["HELIUS_API_KEY", "secret", "Builds the mainnet Helius RPC URL when SOLANA_RPC_URL is unset; deposit detection, payouts, the browser RPC proxy (POST /api/rpc) and the Privacy Ring proxy. Never sent to the browser."],
  ["DEMO_MODE", "false", "Must be false on mainnet (demo is disabled there). If unset it defaults to true when SOLANA_RPC_URL is unset; HELIUS_API_KEY alone does not turn demo off."],
  ["DATABASE_URL", "${{Postgres.DATABASE_URL}}", "Postgres: the ledger of record for real funds. Required for custody; turn on automated backups."],
  ["REDIS_URL", "${{Redis.REDIS_URL}}", "Cache and job queue; in-process fallback."],
  ["SOLANA_RPC_URL / SOLANA_WS_URL", "—", "Explicit RPC; wins over HELIUS_API_KEY."],
  ["NETWORK", "mainnet", "mainnet | devnet | localnet. mainnet enables SOL and USDC only and enforces the mainnet commit window."],
  ["PROGRAM_ID", "71geDP…5Tpy", "Onchain mode program id (roadmap; not deployed, unused in offchain mode)."],
  ["RELAYER_SECRET_KEY", "secret", "base58 fee payer for reveal_bid (onchain). Keep it small."],
  ["RELAYER_BOX_SEED", "secret · 32-byte hex", "x25519 key users seal reveals to. Unset → ephemeral keys that do not survive restarts."],
  ["KEEPER_SECRET_KEY", "secret", "Signer for drips and fee distribution (onchain)."],
  ["CORS_ORIGIN", "*", "Comma-separated origins, e.g. your Vercel domain."],
  ["PORT / HOST", "4000 / 0.0.0.0", "Railway injects PORT."],
  ["JUPITER_API_URL", "https://quote-api.jup.ag/v6", "Jupiter v6 base."],
  ["WORKERS_ENABLED / DEMO_TICK_MS", "true / 1000", "In-process workers; demo simulation tick."],
  ["IDL_PATH", "—", "Defaults to programs/sealed-launchpad/idl/sealed_launchpad.json."],
];

const WEB_ENV: Array<[string, string]> = [
  ["NEXT_PUBLIC_API_URL", "https://<railway-domain> (no trailing slash)"],
  ["NEXT_PUBLIC_WS_URL", "wss://<railway-domain>/ws"],
  ["NEXT_PUBLIC_NETWORK", "mainnet on production. devnet | localnet show the Devnet / Demo label"],
  ["NEXT_PUBLIC_RPC_URL", "optional public RPC; the web app reaches Solana through the API's POST /api/rpc proxy (rolling out), so no provider key belongs here"],
  ["NEXT_PUBLIC_PROGRAM_ID", "onchain mode program id (roadmap)"],
  ["NEXT_PUBLIC_JUPITER_API_URL, NEXT_PUBLIC_DEVNET_MINTS", "optional overrides"],
];

export default function Deploy() {
  return (
    <>
      <DocHeader
        n="11"
        kicker="Deploy"
        title={
          <>
            Demo in one command, production in <Accent>three</Accent>.
          </>
        }
        lede="Local demo needs no keys and no infrastructure. The production deployment is the web app on Vercel and the custodial API on Railway with Postgres and Redis, on Solana mainnet with real funds."
      />

      <Table
        dense
        head={["Live deployment", "URL", "Host"]}
        rows={[
          ["Website", <A key="w" href="https://www.sealedsol.xyz">https://www.sealedsol.xyz</A>, "Vercel"],
          ["API", <A key="a" href="https://api-production-01dc1743.up.railway.app/api/health">https://api-production-01dc1743.up.railway.app</A>, "Railway"],
          ["WebSocket", <C key="ws">wss://api-production-01dc1743.up.railway.app/ws</C>, "Railway"],
          ["Agent guide", <A key="l" href="https://api-production-01dc1743.up.railway.app/llms.txt">/llms.txt</A>, "Railway"],
        ]}
        caption="Mainnet deployment (rolling out). Check network and isDemo in /api/health, and payoutsEnabled in /api/custody/info, before depositing anything."
      />
      <Note title="Current deployment status" tone="signal">
        <p>
          Web: live on Vercel (Next 15.0.8, React 19.0.9). API: live on Railway with Postgres and Redis and <C>EXECUTION_MODE=offchain</C>. The switch from
          devnet to <strong>mainnet is rolling out</strong>: <C>NETWORK=mainnet</C>, <C>DEMO_MODE=false</C>, custody workers on, and the operator secrets{" "}
          <C>COMPANY_WALLET_SECRET_KEY</C>, <C>HELIUS_API_KEY</C> and <C>ADMIN_TOKEN</C> set. Work through the{" "}
          <A href="#mainnet-checklist">mainnet readiness checklist</A> below. Program: roadmap, not deployed.
        </p>
      </Note>
      <RealFundsDisclosure />

      <H2 id="local" n="11.1">Local quickstart</H2>
      <CodeBlock
        lang="bash"
        title="demo mode"
        code={`corepack enable              # or install pnpm 12
pnpm install
pnpm dev                     # builds @sealed/shared, then API :4000 + web :3000
open http://localhost:3000/docs`}
      />
      <Table
        dense
        head={["Command", "What it does"]}
        rows={[
          [<C key="c">pnpm typecheck · pnpm build</C>, "all workspaces"],
          [<C key="c">pnpm --filter @sealed/e2e test:invariants</C>, "seeded property tests on clearing, fees, commitment, schema, demo world"],
          [<C key="c">pnpm --filter @sealed/e2e test:e2e</C>, "boots the built API (and web) and checks them black-box"],
          [<C key="c">scripts/verify.sh</C>, "full definition of done with a PASS/FAIL table"],
          [<C key="c">cd apps/api && node --import tsx --test test/*.test.ts</C>, "API unit and integration suite (87 tests), including the custody and offchain engine"],
          [<C key="c">pnpm anchor:build</C>, "anchor build of the Solana program"],
          [<C key="c">cd programs/sealed-launchpad && anchor test -- --features test-mode</C>, "anchor suite (18 tests). The test-mode feature is required; the root pnpm anchor:test script omits it. cargo test -p sealed_launchpad --lib runs the 15 Rust unit tests."],
        ]}
      />

      <H2 id="env" n="11.2">Environment variables</H2>
      <P>
        Templates: <C>apps/api/.env.example</C>, <C>apps/web/.env.example</C> and the root <C>.env.example</C> (deploy-script inputs: Solana wallet, Railway and
        Vercel tokens). Secrets go in the platform&apos;s secret store, never in git.
      </P>
      <H3 id="env-api">API (Railway)</H3>
      <Table
        dense
        head={["Variable", "Example", "Purpose"]}
        colClass={["min-w-[11rem]", "min-w-[9rem]", "min-w-[16rem]"]}
        rows={API_ENV.map(([k, v, d]) => [<C key="k">{k}</C>, <span key="v" className="font-mono text-[12px] [overflow-wrap:anywhere]">{v}</span>, d])}
        caption="Example values are the mainnet production settings. EXECUTION_MODE, COMPANY_WALLET*, ADMIN_TOKEN, DEPOSIT_CONFIRMATIONS and CUSTODY_WORKERS configure the custodial backend (apps/api/src/offchain/custody/config.ts)."
      />
      <H3 id="env-web">Web (Vercel)</H3>
      <Table dense head={["Variable", "Value"]} rows={WEB_ENV.map(([k, v]) => [<C key="k">{k}</C>, v])} caption="NEXT_PUBLIC_* values are inlined at build time; redeploy after changing them." />

      <H2 id="mainnet-checklist" n="11.3">Mainnet readiness checklist</H2>
      <P>
        Do every item before announcing deposits. Each one is checkable: tick it only when you have seen the result on the hosted API or in the
        dashboard.
      </P>
      <H3 id="checklist-api">API (Railway variables)</H3>
      <Table
        dense
        head={["Variable", "Value", "Check"]}
        colClass={["min-w-[11rem]", "min-w-[9rem]", "min-w-[16rem]"]}
        rows={[
          [<C key="k">NETWORK</C>, <C key="v">mainnet</C>, <><C>GET /api/health</C> → <C>&quot;network&quot;: &quot;mainnet&quot;</C></>],
          [<C key="k">DEMO_MODE</C>, <C key="v">false</C>, <><C>GET /api/health</C> → <C>&quot;isDemo&quot;: false</C>; no launch carries <C>isDemo: true</C>; <C>demo-bid</C> answers 403</>],
          [<C key="k">ADMIN_TOKEN</C>, "long random secret", <><C>GET /api/admin/withdrawals</C> without the header is refused; with it returns the queue</>],
          [<C key="k">COMPANY_WALLET_SECRET_KEY</C>, <>secret for <A href={COMPANY_WALLET_EXPLORER}>{COMPANY_WALLET.slice(0, 4)}…{COMPANY_WALLET.slice(-4)}</A></>, <><C>GET /api/custody/info</C> → <C>payoutsEnabled: true</C>; the key&apos;s public key equals <C>COMPANY_WALLET</C></>],
          [<C key="k">HELIUS_API_KEY</C>, "mainnet key", <>A small test deposit is detected and credited; <C>/api/health</C> shows a redacted mainnet RPC</>],
          [<C key="k">CUSTODY_WORKERS</C>, <C key="v">true</C>, "Deposit watcher and payout worker log on boot"],
          [<C key="k">SIWS_DOMAIN</C>, <C key="v">www.sealedsol.xyz</C>, <>The sign-in message from <C>POST /api/auth/nonce</C> names www.sealedsol.xyz</>],
          [<C key="k">DATABASE_URL</C>, <C key="v">{"${{Postgres.DATABASE_URL}}"}</C>, "Automated Postgres backups enabled and one restore tested; the ledger is the only record of who owns what"],
          [<C key="k">CORS_ORIGIN</C>, <C key="v">https://www.sealedsol.xyz</C>, "No wildcard origin in production"],
        ]}
      />
      <H3 id="checklist-funds">Funds</H3>
      <UL>
        <li>
          <strong>Fund the company wallet with SOL for fees.</strong> Every payout pays a network fee from <C>{COMPANY_WALLET}</C>; when the balance runs low
          payouts pause with a reason. Keep a buffer and alert on it.
        </li>
        <li>
          <strong>Seed the credit pool.</strong> Send company SOL or USDC to the company wallet, then record it with{" "}
          <C>POST /api/admin/credit-pool/seed {"{asset, amount, reference}"}</C> (header <C>x-admin-token</C>, reference = the funding transaction
          signature). Graduations get no buyback credit while the pool is empty.
        </li>
        <li>
          <strong>Check proof of reserves.</strong> <C>GET /api/custody/info</C> shows a ratio ≥ 1 for SOL and USDC, and the on-chain figures match the{" "}
          <A href={COMPANY_WALLET_EXPLORER}>Explorer</A>.
        </li>
      </UL>
      <H3 id="checklist-web">Web (Vercel)</H3>
      <UL>
        <li>
          <C>NEXT_PUBLIC_NETWORK=mainnet</C>, with <C>NEXT_PUBLIC_API_URL</C> and <C>NEXT_PUBLIC_WS_URL</C> pointing at the Railway API. Redeploy afterwards:
          these values are inlined at build time.
        </li>
        <li>The site shows no Devnet / Demo label, no demo launches, and no in-browser demo fallback when the API is unreachable.</li>
        <li>No RPC provider key in any <C>NEXT_PUBLIC_*</C> variable; the browser goes through <C>POST /api/rpc</C>.</li>
      </UL>
      <H3 id="checklist-behaviour">Behaviour to verify (rolling out)</H3>
      <UL>
        <li>Only SOL and USDC are offered as quote and deposit assets; tokenized stocks show as coming soon.</li>
        <li>Creating a launch with a commit window outside {MAINNET_COMMIT_WINDOW} is rejected.</li>
        <li>A withdrawal requested while the price feed is unavailable lands in <C>pending_approval</C>, not <C>queued</C>.</li>
        <li>Launched-token withdrawals are refused; SOL and USDC withdrawals reach <C>sent</C> with a mainnet signature.</li>
        <li>The risk disclosure is visible on the custody, security and deposit screens.</li>
      </UL>

      <H2 id="railway" n="11.4">API on Railway</H2>
      <OL>
        <li>Create a project and add the Postgres and Redis plugins.</li>
        <li>
          Add a service from the repo. <C>apps/api/railway.json</C> builds with <C>apps/api/Dockerfile</C> (context = repo root), health-checks{" "}
          <C>/api/health</C> (120 s timeout) and restarts on failure.
        </li>
        <li>
          Set the variables above. For mainnet custody: <C>NETWORK=mainnet</C>, <C>EXECUTION_MODE=offchain</C>, <C>DEMO_MODE=false</C>,{" "}
          <C>CUSTODY_WORKERS=true</C>, <C>COMPANY_WALLET</C>, <C>COMPANY_WALLET_SECRET_KEY</C> (operator only), <C>ADMIN_TOKEN</C>,{" "}
          <C>DEPOSIT_CONFIRMATIONS</C>, <C>HELIUS_API_KEY</C>, <C>SIWS_DOMAIN=www.sealedsol.xyz</C> and <C>CORS_ORIGIN=https://www.sealedsol.xyz</C>.
          Then seed the credit pool from company funds with <C>POST /api/admin/credit-pool/seed</C>; graduations draw their buyback credit from it and get
          none while it is empty.
        </li>
        <li>
          Run <C>scripts/deploy-api.sh</C> (wraps <C>railway up</C>; asks first, <C>--yes</C> / <C>--dry-run</C>). The container runs <C>prisma db push</C> on boot
          when <C>DATABASE_URL</C> is set.
        </li>
      </OL>
      <CodeBlock lang="bash" title="local image" code={`docker build -f apps/api/Dockerfile -t sealed-api .
docker run -p 4000:4000 sealed-api`} />

      <H2 id="vercel" n="11.5">Web on Vercel</H2>
      <OL>
        <li>
          Import the repo with Root Directory <C>apps/web</C>. <C>vercel.json</C> installs from the monorepo root, builds <C>@sealed/shared</C> →{" "}
          <C>@sealed/defi</C> → <C>@sealed/web</C>, and adds nosniff, referrer and frame-deny headers.
        </li>
        <li>
          Set the web variables, including <C>NEXT_PUBLIC_NETWORK=mainnet</C> for production.
        </li>
        <li>
          <C>scripts/deploy-web.sh</C> for production, <C>--preview</C> for a preview.
        </li>
      </OL>

      <H2 id="devnet" n="11.6">Program on devnet (onchain mode, roadmap)</H2>
      <StatusBadge status="chain-pending" />
      <P>
        The Anchor program is the future non-custodial mode. It is not deployed to devnet or mainnet, and the mainnet custodial backend does not use it.
      </P>
      <CodeBlock
        lang="bash"
        title="deploy-devnet.sh"
        code={`solana-keygen new -o ~/.config/solana/id.json   # then fund with ~5 devnet SOL
scripts/deploy-devnet.sh`}
      />
      <P>
        The script refuses mainnet RPCs, runs <C>anchor build</C> (and <C>anchor keys sync</C> if ids differ), <C>anchor deploy</C> using{" "}
        <C>target/deploy/sealed_launchpad-keypair.json</C>, copies the IDL to <C>programs/sealed-launchpad/idl/</C>, runs <C>scripts/init-devnet.ts</C> (protocol
        config, credit pools, mock quote mints) and writes <C>PROGRAM_ID</C> / <C>NEXT_PUBLIC_PROGRAM_ID</C> into the env files.
      </P>
      <Note title="Before you go live" tone="warn">
        <p>
          Never run a public mainnet deployment with DEMO_MODE=true: demo-bid and unauthenticated in-memory launch creation are enabled in demo. Mainnet
          disables demo mode. Read <A href="/docs/security">Security</A> and finish the <A href="#mainnet-checklist">checklist</A> first.
        </p>
      </Note>
    </>
  );
}
