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
import { COMPANY_WALLET_EXPLORER, MAINNET_COMMIT_WINDOW, MainnetRollout, RealFundsDisclosure } from "@/components/docs/Mainnet";
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
        <StatusBadge status="rolling" label="Solana mainnet · rolling out" />
        <StatusBadge status="offchain-passing" label="Custodial · real funds" />
        <StatusBadge status="planned" label="Not audited" />
      </DocHeader>

      <RealFundsDisclosure />

      <Note title="Execution mode" tone="signal">
        <p>
          Sealed runs <strong>offchain and custodial on Solana mainnet</strong>. A backend on Railway runs auctions, clearing, the graduation pool,
          buyback drips, fee splits and holder rewards in a Postgres double-entry ledger. You sign in with your wallet, deposit by sending SOL or USDC to
          the company wallet <A href={COMPANY_WALLET_EXPLORER}>{COMPANY_WALLET}</A>, trade against your internal balance and withdraw SOL or USDC back
          on-chain. Launched tokens stay as Sealed ledger balances for now. The Anchor program in this repo is the <strong>future non-custodial mode</strong>{" "}
          (&ldquo;Onchain mode — roadmap&rdquo;) and is not deployed. Read <A href="/docs/custody">Custody</A> before you deposit.
        </p>
        <p>
          The switch from devnet to mainnet is <strong>rolling out</strong>: demo mode is disabled on mainnet, only SOL and USDC are enabled as quote assets,
          and mainnet launches need a {MAINNET_COMMIT_WINDOW} commit window. Check <C>network</C> in <C>/api/health</C> and <C>payoutsEnabled</C> in{" "}
          <C>/api/custody/info</C> before depositing.
        </p>
      </Note>

      <Ledger
        items={[
          { k: "Website", v: <A href="https://www.sealedsol.xyz">www.sealedsol.xyz</A> },
          { k: "Network", v: "Solana mainnet (rolling out)" },
          { k: "Company wallet", v: <A href={COMPANY_WALLET_EXPLORER}>{COMPANY_WALLET}</A> },
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
            facts: [`creator ≤ ${pct(MAX_CREATOR_ALLOCATION_BPS)} of supply`, "SOL · USDC (stocks coming soon)"],
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

      <H2 id="status" n="0.4">Status labels</H2>
      <P>Every capability in these docs carries one of these labels. They describe this repository on 2026-11-26.</P>
      <StatusLegend />
      <H2 id="mainnet" n="0.5">Moving to mainnet</H2>
      <P>
        These changes make up the switch from devnet to mainnet. They are labelled rolling out until each one can be checked on the hosted API.
      </P>
      <MainnetRollout />
      <H2 id="components" n="0.6">Components</H2>
      <Ledger
        items={[
          { k: "Demo world", s: "demo", v: "Ticking auctions, buyback countdowns, repayment bars and a trade tape for local development and devnet. Disabled on mainnet: no demo launches and no in-browser fallback." },
          { k: "Offchain ledger engine and SIWS", s: "offchain-passing", sLabel: "Off-chain · tests passing", v: "Double-entry ledger, auction/clearing/pool/drip/fee/reward engine, SIWS sign-in and the trade, account, custody and admin routes in apps/api/src/offchain and apps/api/src/routes. Deployed on Railway with Postgres and Redis; moving to mainnet." },
          { k: "Deposits and payouts", s: "rolling", v: "Deposit watcher, withdrawal queue, payout worker and proof of reserves are built and tested. On mainnet they need HELIUS_API_KEY and COMPANY_WALLET_SECRET_KEY on the API and a company wallet funded with SOL for fees. Only SOL and USDC withdraw." },
          { k: "Clearing, fee and commitment math", s: "offchain-passing", v: "Shared TypeScript with unit and seeded property tests (shared 7/7, invariants 34 pass + 1 todo)." },
          { k: "Anchor program", s: "chain-pending", v: "14 instructions. anchor build succeeds; 15/15 Rust unit tests and 18/18 anchor tests (anchor test -- --features test-mode) pass. Roadmap: not deployed to devnet or mainnet." },
          { k: "Helius Privacy Rings", s: "simulated", v: "Simulated ring in demo; real status probe and indexer proxy implemented; private escrow funding fails closed on real networks." },
          { k: "Third-party audit", s: "planned", v: "None exists, for the custodial backend or the program." },
        ]}
      />

      <H2 id="index" n="0.7">Read next</H2>
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
