import type { Metadata } from "next";
import Link from "next/link";
import {
  COMPANY_WALLET,
  CREDIT_TIERS,
  FLYWHEEL_SPLIT,
  MAX_CREATOR_ALLOCATION_BPS,
  NUM_PRICE_TICKS,
  POOL_FEE_BPS,
  REPAY_SPLIT,
} from "@sealed/shared";
import { CapitalLoop, PhaseTrack } from "@/components/docs/Diagrams";
import { DOC_GROUPS } from "@/components/docs/nav";
import { A, Accent, C, DocHeader, Figure, H2, Ledger, Note, P, StatusBadge, StatusLegend, UL } from "@/components/docs/Prose";

export const metadata: Metadata = { title: "Overview" };

const pct = (bps: number) => `${bps / 100}%`;

export default function DocsOverview() {
  return (
    <>
      <DocHeader
        n="00"
        kicker="Overview"
        title={
          <>
            Fair launches, <Accent>sealed</Accent> until one price clears.
          </>
        }
        lede="Sealed is a Solana token launchpad. Every launch opens with a sealed-bid auction, clears at one uniform price, and graduates into a pool that gets a buyback budget on day one. Trading fees repay that budget, then flow to holders for good."
      >
        <StatusBadge status="demo" label="Devnet / demo" />
        <StatusBadge status="dev" label="Offchain custodial · in development" />
        <StatusBadge status="planned" label="Not on mainnet · not audited" />
      </DocHeader>

      <Note title="Execution mode" tone="signal">
        <p>
          Sealed runs <strong>offchain and custodial by default</strong>. A backend on Railway runs auctions, clearing, the graduation pool, buyback
          drips, fee splits and holder rewards in a Postgres double-entry ledger. You sign in with your wallet, deposit by sending SOL or SPL tokens to
          the company wallet <C>{COMPANY_WALLET}</C>, trade against your internal balance and withdraw back on-chain. The Anchor program in this repo is
          the <strong>future non-custodial mode</strong> (&ldquo;Onchain mode — roadmap&rdquo;). Read <A href="/docs/custody">Custody</A> before you deposit.
        </p>
      </Note>

      <Ledger
        items={[
          { k: "Website", v: <A href="https://www.sealedsol.xyz">www.sealedsol.xyz</A> },
          { k: "API", v: <><A href="https://api-production-01dc1743.up.railway.app/api/health">api-production-01dc1743.up.railway.app</A> · agent guide at <C>/llms.txt</C></> },
        ]}
      />

      <H2 id="what" n="0.1">What Sealed is</H2>
      <P>
        Most launches reward whoever lands the first transaction. Sealed replaces the race with a sealed-bid auction. During a fixed commit window
        bidders lock collateral and submit only a keccak hash of their bid. Nobody sees prices or sizes. In the reveal window the bids are opened, and
        the auction clears at a single price that everyone pays. The proceeds seed a pool, and a credit line of{" "}
        {pct(CREDIT_TIERS.standard)}–{pct(CREDIT_TIERS.premier)} of the raise starts buying and burning the token from the first drip.
      </P>
      <P>
        The same canonical math runs in both execution modes: <C>computeClearing</C> and <C>settleBid</C> (clearing.ts), <C>splitFees</C> (fees.ts) and{" "}
        <C>computeCommitment</C> (commitment.ts) in <C>@sealed/shared</C>. The Rust program mirrors it integer for integer.
      </P>

      <H2 id="loop" n="0.2">The four-phase loop</H2>
      <PhaseTrack
        phases={[
          {
            n: "01",
            title: "Launch setup",
            body: "The creator sets name, ticker, quote asset, auction timing, floor, tick, target raise and clearing cap.",
            facts: [`creator ≤ ${pct(MAX_CREATOR_ALLOCATION_BPS)} of supply`, "SOL · USDC · tokenized stocks"],
          },
          {
            n: "02",
            title: "Sealed auction",
            body: "Commit a keccak hash plus collateral, reveal later, clear at one uniform price. Losers and leftovers are refunded.",
            facts: [`${NUM_PRICE_TICKS} price ticks`, "1% slash if never revealed"],
          },
          {
            n: "03",
            title: "Graduate + vault",
            body: "The raise and pool supply seed a locked pool. The Credit Pool advances a buyback line that drips into buy-and-burns.",
            facts: [`credit ${pct(CREDIT_TIERS.standard)}–${pct(CREDIT_TIERS.premier)} of raise`, "drip every 2–5 min"],
          },
          {
            n: "04",
            title: "Repay → flywheel",
            body: "Pool fees repay the credit first, then split to holders, platform burn and treasury, permanently.",
            facts: [
              `${pct(REPAY_SPLIT.creditRepayBps)} / ${pct(REPAY_SPLIT.platformBurnOpsBps)} while repaying`,
              `${pct(FLYWHEEL_SPLIT.holderPayoutBps)} / ${pct(FLYWHEEL_SPLIT.platformBuybackBurnBps)} / ${pct(FLYWHEEL_SPLIT.treasuryBps)} after`,
            ],
          },
        ]}
      />
      <Figure caption={`Credit is recycled: the pool fee (${pct(POOL_FEE_BPS)} of every swap) repays the Credit Pool, which funds the next launch's vault.`}>
        <CapitalLoop />
      </Figure>

      <H2 id="who" n="0.3">Who it is for</H2>
      <Ledger
        items={[
          { k: "Creators", v: "A fair price-discovery event instead of a sniper race, and a buyback budget the moment the token lists. Creator allocation is capped at 2%." },
          { k: "Bidders", v: "Bid your true valuation without being copy-traded. Everyone who wins pays the same price; unused collateral comes back in full." },
          { k: "Holders", v: "A day-one bid under the token from vault drips, then 50% of pool fees in the quote asset once the credit is repaid." },
          { k: "Agents and integrators", v: <>A JSON API, a WebSocket feed and a plain-text agent guide at <C>/llms.txt</C>. See <A href="/docs/api">API reference</A>.</> },
        ]}
      />

      <H2 id="status" n="0.4">What is live today</H2>
      <P>Every capability in these docs carries one of these labels. They describe this repository on 2026-11-26.</P>
      <StatusLegend />
      <Ledger
        items={[
          { k: "Demo world", s: "demo", v: "Ticking auctions, buyback countdowns, repayment bars and a trade tape, served by the API in DEMO_MODE or simulated in the browser if the API is down." },
          { k: "Offchain custodial backend", s: "dev", v: "Ledger engine, SIWS sign-in, deposit watcher, payouts and proof of reserves. Contract: packages/shared/src/custody.ts. Code: apps/api/src/offchain (being written)." },
          { k: "Clearing, fee and commitment math", s: "offchain-passing", v: "Shared TypeScript with unit and seeded property tests (shared 7/7, invariants 34 pass + 1 todo)." },
          { k: "Anchor program", s: "chain-pending", v: "14 instructions, full lifecycle test suite written. Not built or deployed: the program id has no account on devnet." },
          { k: "Helius Privacy Rings", s: "simulated", v: "Simulated ring in demo; real status probe and indexer proxy implemented; private escrow funding fails closed on real networks." },
          { k: "Mainnet, audits", s: "planned", v: "No mainnet deployment and no third-party audit exist." },
        ]}
      />

      <H2 id="index" n="0.5">Read next</H2>
      <div className="mt-6 grid gap-8 sm:grid-cols-3">
        {DOC_GROUPS.map((g) => (
          <div key={g.label} className="min-w-0">
            <p className="eyebrow mb-2">{g.label}</p>
            <ul className="border-t border-ink">
              {g.pages
                .filter((p) => p.href !== "/docs")
                .map((p) => (
                  <li key={p.href} className="border-b border-rule">
                    <Link href={p.href} className="block py-3 transition-colors hover:text-ink">
                      <span className="num mr-2 text-[10.5px] text-ink-muted">§ {p.n}</span>
                      <span className="text-[14px] font-semibold text-ink">{p.title}</span>
                      <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-slate">{p.summary}</span>
                    </Link>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
      <UL>
        <li>
          Repo docs live in <C>docs/</C>: OVERVIEW, ARCHITECTURE, MECHANICS, PROGRAM, API, STACK, DEPLOYMENT, SECURITY, CUSTODY and PRIVACY.
        </li>
      </UL>
    </>
  );
}
