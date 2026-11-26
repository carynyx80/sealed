import type { Metadata } from "next";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { ArchitectureMap } from "@/components/docs/Diagrams";
import { A, Accent, C, DocHeader, Figure, H2, H3, Ledger, Note, OL, P, StatusBadge, Table } from "@/components/docs/Prose";

export const metadata: Metadata = { title: "Architecture" };

export default function Architecture() {
  return (
    <>
      <DocHeader
        n="07"
        kicker="Architecture"
        title={
          <>
            A pnpm monorepo with <Accent>one</Accent> source of truth for the math.
          </>
        }
        lede="Next.js on Vercel, Fastify on Railway, Postgres and Redis behind it, Solana underneath. Types, schemas, PDAs and every protocol number live in @sealed/shared so web, API and program cannot drift."
      />

      <H2 id="map" n="7.1">System map</H2>
      <Figure caption="Default offchain custodial mode. In the roadmap onchain mode the browser signs program transactions directly and the API only indexes, relays reveals and cranks.">
        <ArchitectureMap />
      </Figure>

      <H2 id="repo" n="7.2">Monorepo</H2>
      <CodeBlock
        lang="text"
        title="layout"
        code={`packages/shared            @sealed/shared — types, Zod schemas, PDAs, clearing / fee / commitment math,
                           custody contract (custody.ts), demo world, REST + WS contract
packages/defi              @sealed/defi — Anchor client, Jupiter v6, Raydium adapter (optional),
                           internal-CPMM quotes, encrypted bid vault, Privacy Ring clients
programs/sealed-launchpad  Anchor program sealed_launchpad (onchain mode, roadmap) + tests + devnet init
apps/api                   @sealed/api — Fastify REST + /ws, Prisma/Postgres, Redis, workers, /llms.txt
  src/offchain/            custodial ledger engine, SIWS, deposits, withdrawals (in development)
apps/web                   @sealed/web — Next.js 15 App Router, Tailwind, framer-motion, these docs
tests                      @sealed/e2e — invariant/property tests, black-box API e2e, web smoke
scripts                    deploy-devnet.sh · deploy-api.sh · deploy-web.sh · verify.sh`}
      />
      <CodeBlock
        lang="text"
        title="dependency graph"
        code={`@sealed/web ──▶ @sealed/defi ──▶ @sealed/shared
     │                                ▲
     └────────────────────────────────┤
@sealed/api ──────────────────────────┘   (the API deliberately does not depend on @sealed/defi)
sealed_launchpad (Rust) mirrors constants.ts and clearing/fees/commitment integer-for-integer`}
      />

      <H2 id="flow" n="7.3">Data flow</H2>
      <H3 id="flow-offchain">Offchain custodial (default)</H3>
      <OL>
        <li>The browser signs a SIWS message; the API issues a bearer token.</li>
        <li>The user transfers SOL/SPL to the company wallet with memo <C>sealed:&lt;depositRef&gt;</C>; the deposit watcher sees it through Helius RPC and credits the ledger after finality.</li>
        <li>Commits, reveals, swaps, claims and stakes are API calls that post double-entry ledger transactions.</li>
        <li>Schedulers clear auctions, graduate, run drips and split fees on the ledger; events stream over <C>/ws</C>.</li>
        <li>Withdrawals are paid from the company wallet by the payout worker, or queued for manual approval.</li>
      </OL>
      <H3 id="flow-onchain">Onchain (roadmap)</H3>
      <OL>
        <li>The browser builds and signs program transactions with Wallet Adapter (<C>@sealed/defi</C> client).</li>
        <li>The indexer polls <C>getProgramAccounts</C> every 20 s (and on <C>onLogs</C>, debounced 1.5 s), decodes accounts with the IDL and upserts launches.</li>
        <li>Diffs become WS events; the API serves the store over REST.</li>
      </OL>

      <H2 id="workers" n="7.4">Workers</H2>
      <Table
        head={["Worker", "File", "Cadence", "Runs when", "Status"]}
        rows={[
          ["Indexer", <C key="f">workers/indexer.ts</C>, "20 s poll + onLogs", "not demo, RPC + IDL present", <StatusBadge key="s" status="chain-pending" label="Onchain mode" />],
          ["Auto-reveal relayer", <C key="f">workers/revealRelayer.ts</C>, "2 s", "always; demo marks bids revealed", <StatusBadge key="s" status="demo" />],
          ["Buyback keeper", <C key="f">workers/buybackKeeper.ts</C>, "10 s", "not demo, KEEPER_SECRET_KEY set", <StatusBadge key="s" status="partial" label="Account wiring gap" />],
          ["Demo world ticker", <C key="f">@sealed/shared demo.ts</C>, "DEMO_TICK_MS (1 s)", "DEMO_MODE", <StatusBadge key="s" status="demo" />],
          ["Ledger engine, deposit watcher, payouts", <C key="f">src/offchain/**</C>, "—", "EXECUTION_MODE=offchain", <StatusBadge key="s" status="dev" />],
        ]}
      />
      <P>
        Workers run in-process with the HTTP server (<C>WORKERS_ENABLED=true</C>) and are stopped on shutdown. The relayer retries a reveal up to 8 times
        and treats <C>AlreadyRevealed</C> as success.
      </P>

      <H2 id="storage" n="7.5">Storage and cache</H2>
      <Ledger
        items={[
          { k: "Postgres (Prisma)", v: <>Models: Launch, Bid, RevealPayload, Trade, BuybackEvent, CreditLedger, HolderReward, ProtocolStats (<C>apps/api/prisma/schema.prisma</C>). The custodial ledger tables are added by the offchain workstream. <C>prisma db push</C> runs on container boot when <C>DATABASE_URL</C> is set.</> },
          { k: "Memory store", v: "Used when DATABASE_URL is unset (demo). Not durable; a custodial deployment must use Postgres." },
          { k: "Redis", v: <>Response cache (1–2 s TTLs on lists, stats, revenue) and the keeper job queue. Falls back to an in-process map when <C>REDIS_URL</C> is unset.</> },
          { k: "Browser", v: "Encrypted bid salts in IndexedDB; a client-side demo world takes over if the API is unreachable." },
        ]}
      />
      <Note>
        <p>
          The full endpoint list is in <A href="/docs/api">API reference</A>; account layouts are in <A href="/docs/program">Onchain program</A>.
        </p>
      </Note>
    </>
  );
}
