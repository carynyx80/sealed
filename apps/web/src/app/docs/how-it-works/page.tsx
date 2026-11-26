import type { Metadata } from "next";
import {
  ANTI_SNIPE_WINDOW_SEC,
  DEFAULT_DRIP_COUNT,
  DEFAULT_DRIP_INTERVAL_SEC,
  DEFAULT_REVEAL_DURATION_SEC,
  DEFAULT_TOTAL_SUPPLY_WHOLE,
  MAX_AUCTION_SUPPLY_BPS,
  MAX_COMMIT_DURATION_SEC,
  MAX_CREATOR_ALLOCATION_BPS,
  MAX_DRIP_INTERVAL_SEC,
  MIN_AUCTION_SUPPLY_BPS,
  MIN_COMMIT_DURATION_SEC_DEVNET,
  MIN_COMMIT_DURATION_SEC_MAINNET,
  MIN_DRIP_INTERVAL_SEC,
  NO_REVEAL_SLASH_BPS,
  QUOTE_ASSET_LIST,
} from "@sealed/shared";
import { Timeline } from "@/components/docs/Diagrams";
import { A, Accent, C, DocHeader, Figure, Figures, H2, H3, N, Note, OL, P, StatusBadge, Table } from "@/components/docs/Prose";

export const metadata: Metadata = { title: "How it works" };

const pct = (bps: number) => `${bps / 100}%`;
const min = (s: number) => `${s / 60} min`;

// Worked supply example: default supply, 1% creator, 40% auction (API default auctionSupplyBps).
const SUPPLY = Number(DEFAULT_TOTAL_SUPPLY_WHOLE);
const CREATOR_BPS = 100;
const AUCTION_BPS = 4_000;
const creator = (SUPPLY * CREATOR_BPS) / 10_000;
const auction = (SUPPLY * AUCTION_BPS) / 10_000;
const pool = SUPPLY - creator - auction;
const fmt = (n: number) => n.toLocaleString("en-US");

export default function HowItWorks() {
  return (
    <>
      <DocHeader
        n="01"
        kicker="How it works"
        title={
          <>
            One launch, from the first <Accent>commit</Accent> to the flywheel.
          </>
        }
        lede="A launch moves through six statuses. This page walks through each one: who acts, what money moves, and which numbers are fixed by the protocol."
      >
        <StatusBadge status="demo" />
        <StatusBadge status="offchain-passing" label="Offchain ledger · tests passing" />
        <StatusBadge status="chain-pending" />
      </DocHeader>

      <H2 id="modes" n="1.1">Two execution modes, one rulebook</H2>
      <Table
        head={["", "Offchain custodial (default)", "Onchain (roadmap)"]}
        rows={[
          ["Who runs the auction", "Railway backend, Postgres double-entry ledger", <>Anchor program <C>sealed_launchpad</C></>],
          ["Where your money is", <>Company wallet; you hold an internal balance (<A href="/docs/custody">Custody</A>)</>, "Program-owned PDAs; you keep custody"],
          ["How you sign in / act", "SIWS signature → bearer token → API calls", "Wallet signs each transaction"],
          ["Anti-snipe rule", <>Buys within <N>{ANTI_SNIPE_WINDOW_SEC}s</N> of graduation are flagged</>, "Buys in the graduation slot are flagged"],
          ["Math", <><C>computeClearing</C>, <C>settleBid</C>, <C>splitFees</C> from <C>@sealed/shared</C></>, "math.rs, a line-for-line port"],
          ["Status", <StatusBadge key="a" status="offchain-passing" label="Off-chain · tests passing · deployed" />, <StatusBadge key="b" status="chain-pending" />],
        ]}
      />

      <H2 id="lifecycle" n="1.2">Statuses</H2>
      <Figure caption="Durations to scale for the API defaults: 20 min commit, 2 min reveal; live and flywheel run indefinitely.">
        <Timeline
          segments={[
            { label: "commit", sub: "bids sealed, collateral locked", weight: 20, tone: "ink" },
            { label: "reveal", sub: "preimages opened", weight: 2, tone: "soft" },
            { label: "live", sub: "vault drips, fees repay credit", weight: 14, tone: "line" },
            { label: "flywheel", sub: "credit repaid, holders paid", weight: 14, tone: "line" },
          ]}
        />
      </Figure>
      <Table
        head={["Status", "Meaning", "Next"]}
        rows={[
          [<C key="s">commit</C>, "Commit window open. Bidders lock collateral and submit a 32-byte commitment.", "reveal at commitEndTs"],
          [<C key="s">reveal</C>, "Reveal window open. Anyone holding a preimage can reveal it (the bidder or the auto-reveal relayer).", "clearing at revealEndTs"],
          [<C key="s">clearing</C>, "Reveal closed; waiting for clear and graduation.", "live, or failed"],
          [<C key="s">live</C>, "Graduated. The pool trades, the buyback vault drips, fees repay the credit line.", "flywheel when outstanding = 0"],
          [<C key="s">flywheel</C>, "Credit 100% repaid. Fees split 50/35/15 forever.", "terminal"],
          [<C key="s">failed</C>, "No revealed bids (or nothing raised). Every deposit is refunded in full.", "terminal"],
        ]}
        caption="API statuses (LaunchStatus in types.ts). On-chain the program stores Open / Cleared / Failed / Live / Flywheel; commit, reveal and clearing are derived from timestamps."
      />

      <H2 id="setup" n="1.3">Launch setup</H2>
      <P>
        The creator picks a quote asset ({QUOTE_ASSET_LIST.map((q) => q.symbol).join(", ")}) and the auction parameters. Launched tokens always use{" "}
        <N>6</N> decimals and prices are quoted in quote-asset per whole token.
      </P>
      <Table
        head={["Parameter", "Bounds", "Enforced by"]}
        rows={[
          ["Creator allocation", <N key="a">0 to {pct(MAX_CREATOR_ALLOCATION_BPS)} of supply</N>, "schema (400) + program (CreatorAllocationTooHigh)"],
          ["Auction supply", <N key="a">{pct(MIN_AUCTION_SUPPLY_BPS)} to {pct(MAX_AUCTION_SUPPLY_BPS)}</N>, "schema + program (InvalidAuctionSupply)"],
          ["Commit window", <N key="a">{min(MIN_COMMIT_DURATION_SEC_MAINNET)} to {min(MAX_COMMIT_DURATION_SEC)} on mainnet · ≥ {min(MIN_COMMIT_DURATION_SEC_DEVNET)} in local development</N>, "program (InvalidDuration); the API enforces the mainnet bound on mainnet (rolling out) and allows 2 to 30 min in local development"],
          ["Reveal window", <N key="a">60 to 600 s API · 60 to 1,800 s program · default {DEFAULT_REVEAL_DURATION_SEC} s</N>, "schema + program"],
          ["Drip interval", <N key="a">{MIN_DRIP_INTERVAL_SEC} to {MAX_DRIP_INTERVAL_SEC} s · default {DEFAULT_DRIP_INTERVAL_SEC} s · {DEFAULT_DRIP_COUNT} drips</N>, "program (InvalidDripInterval)"],
          ["Clearing cap", <span key="a">≥ targetRaise (API) and ≥ floor × tokensForSale (program)</span>, "API superRefine + program (InvalidParams)"],
        ]}
      />
      <H3 id="supply">Supply split, worked</H3>
      <P>
        With the default supply of <N>{fmt(SUPPLY)}</N> tokens, a <N>{pct(CREATOR_BPS)}</N> creator allocation and a <N>{pct(AUCTION_BPS)}</N> auction:
      </P>
      <Figures
        items={[
          { value: fmt(creator / 1e6), unit: "M", label: "to the creator at creation" },
          { value: fmt(auction / 1e6), unit: "M", label: "sold in the sealed auction" },
          { value: fmt(pool / 1e6), unit: "M", label: "seeded into the pool (+ any unsold)" },
          { value: "0", label: "LP tokens minted: liquidity is locked" },
        ]}
      />

      <H2 id="walkthrough" n="1.4">A launch, step by step</H2>
      <OL>
        <li>
          <strong>Create.</strong> Offchain: <C>POST /api/launches</C> records the launch. Onchain: the creator signs <C>create_launch</C>, which mints the
          creator allocation and opens escrow, stake and rewards accounts.
        </li>
        <li>
          <strong>Commit.</strong> A bidder picks a max price on the tick grid and a bid amount, draws a 32-byte salt and submits{" "}
          <C>keccak256(bidder ‖ max_price ‖ bid_amount ‖ salt)</C> with a deposit ≥ bid amount. Only bid count, escrowed wallets and total escrowed are
          public. See <A href="/docs/sealed-auction">Sealed auction</A>.
        </li>
        <li>
          <strong>Reveal.</strong> The preimage is submitted and checked against the hash; the bid amount joins the tick histogram. Opting into auto-reveal
          seals the preimage to the relayer, which reveals at window open.
        </li>
        <li>
          <strong>Clear.</strong> One uniform price is computed from the histogram. Winners above it fill fully, the marginal tick is pro-rated, everything
          else is refunded. Unrevealed bids lose <N>{pct(NO_REVEAL_SLASH_BPS)}</N> of their deposit.
        </li>
        <li>
          <strong>Graduate.</strong> The raise and pool allocation seed a constant-product pool. The Credit Pool advances the credit line into the buyback
          vault and the first drip is scheduled one drip interval later. See <A href="/docs/buyback-vault">Buyback vault</A>.
        </li>
        <li>
          <strong>Trade and repay.</strong> Every swap pays a 1% fee in the quote asset. Fees repay credit 80/20 until outstanding reaches exactly zero,
          then split 50/35/15. See <A href="/docs/flywheel">Flywheel</A>.
        </li>
      </OL>

      <H2 id="actors" n="1.5">Who does what</H2>
      <Table
        head={["Action", "Offchain (default)", "Onchain (roadmap)"]}
        rows={[
          ["Create launch", "signed-in creator: POST /api/launches with a bearer token", "creator signs create_launch"],
          ["Commit bid", "POST /api/trade/commit (locks internal balance)", "bidder signs commit_bid (SPL transfer to escrow)"],
          ["Reveal", "POST /api/trade/reveal or auto-reveal", "anyone with the preimage: reveal_bid"],
          ["Clear, graduate", "backend scheduler", "permissionless crank: clear_auction, graduate_and_open_credit"],
          ["Drips, fee split", "backend scheduler on the ledger", "permissionless crank: execute_buyback_drip, distribute_fees"],
          ["Claim, stake, rewards", "POST /api/trade/claim · stake · rewards", "claim_or_refund, stake, claim_rewards"],
          ["Withdraw", "POST /api/account/withdrawals → company wallet pays out", "not needed: funds are already in your wallet"],
        ]}
      />
      <Note title="Demo mode">
        <p>
          With no environment set, the API runs <C>DEMO_MODE</C> with an in-memory store and a deterministic demo world; the UI labels it Demo.
          Demo bids go through <C>POST /api/auctions/:id/demo-bid</C> with a real keccak commitment. No real funds move. Demo mode is for local development only:
          it is disabled on mainnet, where the hosted API (rolling out) serves only real launches with real funds and the web app has no demo fallback.
        </p>
      </Note>
    </>
  );
}
