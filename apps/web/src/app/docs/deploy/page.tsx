import type { Metadata } from "next";
import { COMPANY_WALLET } from "@sealed/shared";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { A, Accent, C, DocHeader, H2, H3, Note, OL, P, StatusBadge, Table } from "@/components/docs/Prose";

export const metadata: Metadata = { title: "Deploy" };

const API_ENV: Array<[string, string, string]> = [
  ["EXECUTION_MODE", "offchain", "offchain (custodial, default) or onchain (roadmap)."],
  ["COMPANY_WALLET", COMPANY_WALLET, "Public address that receives deposits and is reported in proof of reserves."],
  ["COMPANY_WALLET_SECRET_KEY", "secret · operator-set", "Signs withdrawals. Unset → payoutsEnabled=false, no payout worker runs and every withdrawal stays queued (funds locked) until it is set or the withdrawal is rejected. Never commit it."],
  ["ADMIN_TOKEN", "secret", "Value of the x-admin-token header for /api/admin/withdrawals (list / approve / reject) and /api/admin/credit-pool/seed. Unset → admin routes answer 503."],
  ["DEPOSIT_CONFIRMATIONS", "finalized", "\"finalized\" or an integer 1–1000 of confirmed-slot depth before a deposit is credited."],
  ["CUSTODY_WORKERS", "auto", "Run the deposit watcher and payout worker. Default: WORKERS_ENABLED and not demo, so with DEMO_MODE=true they stay off unless this is true."],
  ["SIWS_DOMAIN", "sealed.app", "Domain shown in the sign-in message."],
  ["DEPOSIT_POLL_MS / PAYOUT_POLL_MS / OFFCHAIN_TICK_MS", "15000 / 10000 / 2000", "Deposit watcher, payout worker and offchain scheduler cadence."],
  ["HELIUS_API_KEY", "secret", "Builds the Helius RPC URL when SOLANA_RPC_URL is unset; deposit detection; Privacy Ring proxy."],
  ["DEMO_MODE", "auto", "true when SOLANA_RPC_URL is unset. HELIUS_API_KEY alone does not turn demo off — set DEMO_MODE=false."],
  ["DATABASE_URL", "${{Postgres.DATABASE_URL}}", "Postgres. Optional in demo (memory store); required for custody."],
  ["REDIS_URL", "${{Redis.REDIS_URL}}", "Cache and job queue; in-process fallback."],
  ["SOLANA_RPC_URL / SOLANA_WS_URL", "—", "Explicit RPC; wins over HELIUS_API_KEY."],
  ["NETWORK", "devnet", "mainnet | devnet | localnet."],
  ["PROGRAM_ID", "71geDP…5Tpy", "Onchain mode program id (written by deploy-devnet.sh)."],
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
  ["NEXT_PUBLIC_NETWORK", "devnet | mainnet | localnet — anything but mainnet shows the Devnet / Demo label"],
  ["NEXT_PUBLIC_RPC_URL", "public RPC for wallet transactions"],
  ["NEXT_PUBLIC_PROGRAM_ID", "onchain mode program id"],
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
        lede="Local demo needs no keys and no infrastructure. A real deployment is the web app on Vercel, the API on Railway with Postgres and Redis, and — for the roadmap onchain mode — the program on devnet."
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
        caption="Devnet / demo deployments. Check /api/health for isDemo and the active mode before depositing anything."
      />
      <Note title="Current deployment status" tone="signal">
        <p>
          Web: live on Vercel (Next 15.0.8, React 19.0.9). API: live on Railway with Postgres and Redis, <C>EXECUTION_MODE=offchain</C> and{" "}
          <C>DEMO_MODE=true</C>, so demo launches are merged with real offchain ones. Not configured yet: <C>COMPANY_WALLET_SECRET_KEY</C> (payouts off) and{" "}
          <C>HELIUS_API_KEY</C> (no deposit detection). Program: built and tested locally, not deployed to devnet.
        </p>
      </Note>

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
        caption="EXECUTION_MODE, COMPANY_WALLET*, ADMIN_TOKEN, DEPOSIT_CONFIRMATIONS and CUSTODY_WORKERS configure the custodial backend (apps/api/src/offchain/custody/config.ts). On the hosted API, COMPANY_WALLET_SECRET_KEY and HELIUS_API_KEY are not set yet."
      />
      <H3 id="env-web">Web (Vercel)</H3>
      <Table dense head={["Variable", "Value"]} rows={WEB_ENV.map(([k, v]) => [<C key="k">{k}</C>, v])} caption="NEXT_PUBLIC_* values are inlined at build time; redeploy after changing them." />

      <H2 id="railway" n="11.3">API on Railway</H2>
      <OL>
        <li>Create a project and add the Postgres and Redis plugins.</li>
        <li>
          Add a service from the repo. <C>apps/api/railway.json</C> builds with <C>apps/api/Dockerfile</C> (context = repo root), health-checks{" "}
          <C>/api/health</C> (120 s timeout) and restarts on failure.
        </li>
        <li>
          Set the variables above. For custody add <C>EXECUTION_MODE=offchain</C>, <C>COMPANY_WALLET</C>, <C>COMPANY_WALLET_SECRET_KEY</C> (operator only),{" "}
          <C>ADMIN_TOKEN</C>, <C>DEPOSIT_CONFIRMATIONS</C>, <C>HELIUS_API_KEY</C>, <C>DEMO_MODE=false</C> and <C>CORS_ORIGIN=https://&lt;vercel-domain&gt;</C>.
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

      <H2 id="vercel" n="11.4">Web on Vercel</H2>
      <OL>
        <li>
          Import the repo with Root Directory <C>apps/web</C>. <C>vercel.json</C> installs from the monorepo root, builds <C>@sealed/shared</C> →{" "}
          <C>@sealed/defi</C> → <C>@sealed/web</C>, and adds nosniff, referrer and frame-deny headers.
        </li>
        <li>Set the web variables.</li>
        <li>
          <C>scripts/deploy-web.sh</C> for production, <C>--preview</C> for a preview.
        </li>
      </OL>

      <H2 id="devnet" n="11.5">Program on devnet (onchain mode)</H2>
      <StatusBadge status="chain-pending" />
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
          Never run a public mainnet deployment with DEMO_MODE=true: demo-bid and unauthenticated in-memory launch creation are enabled in demo. The
          hosted devnet API runs in demo today. Read Security first.
        </p>
      </Note>
    </>
  );
}
