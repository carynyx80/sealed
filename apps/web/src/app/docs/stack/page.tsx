import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Accent, C, DocHeader, H2, P, StatusBadge, type Status } from "@/components/docs/Prose";

export const metadata: Metadata = { title: "What powers Sealed" };

interface Item {
  name: string;
  version?: string;
  role: ReactNode;
  where: string;
  status: Status;
  statusLabel?: string;
}

const GROUPS: Array<{ id: string; n: string; title: string; items: Item[] }> = [
  {
    id: "chain",
    n: "10.1",
    title: "Chain",
    items: [
      { name: "Solana", role: "Settlement layer. In custodial mode it carries deposits to and withdrawals from the company wallet; in onchain mode it runs the whole launch.", where: "devnet today", status: "demo", statusLabel: "Devnet · custodial deposits in development" },
      { name: "Anchor", version: "0.32", role: "Framework for the sealed_launchpad program: account constraints, PDAs, events, IDL generation, TypeScript client.", where: "programs/sealed-launchpad", status: "chain-pending" },
      { name: "SPL Token", role: "Escrow, vault, pool and reward token accounts; minting with a PDA authority; burns from the pool reserve.", where: "program, @solana/spl-token 0.4.9", status: "chain-pending" },
      { name: "@solana/web3.js", version: "1.98", role: "PublicKey, PDA derivation, connections and transactions across shared, defi, API and web.", where: "all packages", status: "offchain-passing" },
    ],
  },
  {
    id: "helius",
    n: "10.2",
    title: "Helius",
    items: [
      { name: "Helius RPC", role: <>RPC endpoint built from <C>HELIUS_API_KEY</C> when <C>SOLANA_RPC_URL</C> is unset; used for deposit detection on the company wallet and by the onchain indexer.</>, where: "apps/api config.ts", status: "dev", statusLabel: "Deposit watcher · in development" },
      { name: "Helius indexing", role: "getProgramAccounts + onLogs for the onchain-mode indexer; signature history for deposit detection.", where: "workers/indexer.ts, src/offchain", status: "chain-pending", statusLabel: "Onchain indexer · tests pending" },
      { name: "Helius Privacy Rings", role: "Confidential amounts for deposits, refunds and payouts. Status probe and indexer proxy are real; escrow funding is simulated in demo and fails closed elsewhere.", where: "services/heliusPrivacy.ts, packages/defi/src/privacy", status: "simulated", statusLabel: "Simulated · proxy live" },
    ],
  },
  {
    id: "defi",
    n: "10.3",
    title: "Liquidity and wallets",
    items: [
      { name: "Internal CPMM pool", role: "The graduation venue: constant-product, 1% fee in quote to the fee collector, no LP tokens (locked liquidity), same-slot anti-snipe.", where: "program swap / ledger pool", status: "demo" },
      { name: "Jupiter v6", role: "Quote and swap-transaction builder for converting between quote assets before a pool swap. Timeouts, never throws into a worker.", where: "packages/defi jupiter.ts, apps/api services/jupiter.ts", status: "offchain-passing" },
      { name: "Raydium", role: "Optional CPMM / LaunchLab adapter that derives addresses and produces a migration plan. Nothing in the protocol calls it: moving liquidity would forfeit the fee routing and anti-snipe guarantees.", where: "packages/defi raydium.ts", status: "offchain-passing", statusLabel: "Optional · not wired" },
      { name: "Solana Wallet Adapter", role: "Connect, signMessage (SIWS, bid-vault key, reveal authorisation), sendTransaction.", where: "apps/web components/wallet", status: "demo" },
    ],
  },
  {
    id: "app",
    n: "10.4",
    title: "Application",
    items: [
      { name: "Next.js on Vercel", version: "15.0", role: "App Router web app and these docs. vercel.json installs from the monorepo root and builds shared → defi → web.", where: "apps/web", status: "demo" },
      { name: "Fastify on Railway", version: "Node 22", role: "REST, WebSocket hub, workers and /llms.txt in one process; Dockerfile + railway.json with a /api/health check.", where: "apps/api", status: "offchain-passing" },
      { name: "Postgres + Prisma", role: "Store of record and, in custodial mode, the double-entry ledger. Optional in demo (memory store).", where: "apps/api/prisma", status: "dev", statusLabel: "Ledger · in development" },
      { name: "Redis", role: "Short-TTL response cache and keeper job queue; in-process fallback.", where: "apps/api/src/cache", status: "offchain-passing" },
      { name: "tweetnacl", version: "1.0.3", role: "x25519 nacl.box sealing of auto-reveal payloads; ed25519 signature checks.", where: "shared relayer.ts", status: "offchain-passing" },
      { name: "@noble/hashes keccak_256", role: "The bid commitment hash, matching the program's keccak.", where: "shared commitment.ts", status: "offchain-passing" },
      { name: "WebCrypto (HKDF + AES-GCM)", role: "Encrypts bid salts at rest in IndexedDB with a key derived from a wallet signature.", where: "packages/defi bidVault.ts", status: "offchain-passing" },
      { name: "framer-motion", version: "11", role: "Restrained motion: springs (260/26), rolling numbers, the rotating seal ring; reduced-motion respected.", where: "apps/web", status: "demo" },
      { name: "Tailwind CSS", version: "3.4", role: "Design tokens from DESIGN.md: paper, ink, ultramarine signal, hairline rules, 14px cards.", where: "apps/web", status: "demo" },
    ],
  },
  {
    id: "types",
    n: "10.5",
    title: "The type system",
    items: [
      { name: "TypeScript", version: "5.6", role: "Strict mode in every package. DTOs use UI-unit numbers; transaction code uses bigint atoms; the two never mix in one object.", where: "tsconfig.base.json", status: "offchain-passing" },
      { name: "Zod", version: "3.23", role: "Runtime validation of launch input (2% cap), queries, reveal envelopes, custody requests and the API environment.", where: "shared schemas.ts, custody.ts, api config.ts", status: "offchain-passing" },
      { name: "@sealed/shared", role: "The contract: constants mirrored in constants.rs, PDA seeds, clearing/fee/commitment math, REST/WS/custody types. These docs import it, so numbers cannot drift.", where: "packages/shared", status: "offchain-passing" },
    ],
  },
];

export default function Stack() {
  return (
    <>
      <DocHeader
        n="10"
        kicker="What powers Sealed"
        title={
          <>
            The stack, and what each piece <Accent>actually</Accent> does here.
          </>
        }
        lede="No logo wall. Each dependency below says what job it does in Sealed, where it lives in the repo, and how far along that job is."
      />
      {GROUPS.map((g) => (
        <section key={g.id}>
          <H2 id={g.id} n={g.n}>
            {g.title}
          </H2>
          <dl className="mt-6 border-t border-ink">
            {g.items.map((it) => (
              <div key={it.name} className="grid gap-2 border-b border-rule py-4 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:gap-6">
                <dt className="min-w-0">
                  <p className="text-[15px] font-semibold text-ink">{it.name}</p>
                  {it.version && <p className="num mt-0.5 text-[11px] text-ink-muted">{it.version}</p>}
                </dt>
                <dd className="min-w-0">
                  <StatusBadge status={it.status} label={it.statusLabel} />
                  <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">{it.role}</p>
                  <p className="mt-1 font-mono text-[11.5px] text-ink-muted [overflow-wrap:anywhere]">{it.where}</p>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <P className="mt-10">
        Tooling: pnpm 12 workspaces, <C>node:test</C> + <C>tsx</C> for unit, invariant and e2e tests, GitHub Actions CI (typecheck, build, tests, Docker
        boot, anchor build/test).
      </P>
    </>
  );
}
