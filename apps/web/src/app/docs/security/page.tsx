import type { Metadata } from "next";
import { COMPANY_WALLET, NO_REVEAL_SLASH_BPS, WITHDRAWAL_LIMITS } from "@sealed/shared";
import { A, Accent, C, DocHeader, H2, H3, Ledger, Note, P, StatusBadge, Table, UL } from "@/components/docs/Prose";

export const metadata: Metadata = { title: "Security" };

export default function Security() {
  return (
    <>
      <DocHeader
        n="12"
        kicker="Security"
        title={
          <>
            What you trust, what is <Accent>tested</Accent>, what is not done.
          </>
        }
        lede="An honest account of the trust model in each execution mode, the invariants the test suites check, and the gaps we know about."
      >
        <StatusBadge status="planned" label="No audit" />
        <StatusBadge status="planned" label="No mainnet deployment" />
      </DocHeader>

      <Note title="Custody disclosure" tone="warn">
        <p>
          In the default offchain mode Sealed is <strong>custodial</strong>. Deposits sit in the company wallet <C>{COMPANY_WALLET}</C>; your balance is a
          ledger entry. Sealed can see your bids once submitted, can delay or refuse withdrawals, and could lose funds if the operator key is compromised.
          There is no insurance, no audit and no regulatory licence behind this service. See <A href="/docs/custody">Custody</A>.
        </p>
      </Note>

      <H2 id="trust" n="12.1">Trust model</H2>
      <H3 id="trust-offchain">Offchain custodial (default)</H3>
      <Table
        head={["Party", "Can", "Cannot"]}
        rows={[
          ["Operator (company wallet key)", "move reserves; pause, delay or reject withdrawals; read every bid after submission", "forge your SIWS signature; hide reserves from proof of reserves (they are on-chain)"],
          ["Admin token holder", <>approve or reject queued withdrawals above <C>${WITHDRAWAL_LIMITS.autoApproveMaxUsd}</C></>, "send funds without the wallet key"],
          ["Other users", "see aggregate auction counters", "see your bid before reveal (the API never returns it)"],
          ["Chain observers", "see deposits to and withdrawals from the company wallet", "see bids, fills or internal trades"],
        ]}
      />
      <H3 id="trust-onchain">Onchain (roadmap)</H3>
      <Table
        head={["Party", "Can", "Cannot"]}
        rows={[
          ["Admin", "initialize the protocol once (treasury, platform ops, keeper, mainnet flag, max credit)", "withdraw the buyback vault, escrow or pool — no such instruction exists"],
          ["Auto-reveal relayer", "learn your bid early; withhold your reveal (you can still reveal yourself)", "change your bid (keccak binds it) or move funds (it only pays fees)"],
          ["Keeper / any cranker", "run a drip or fee distribution that is already due", "run drips early, change sizes, or redirect funds"],
          ["Creator", <>receive at most 2% of supply</>, "mint more (mint authority is a PDA) or touch the raise"],
        ]}
      />

      <H2 id="invariants" n="12.2">Invariants tested</H2>
      <Ledger
        items={[
          { k: "Clearing", s: "offchain-passing", v: "Every winner pays one uniform price ≤ their max; Σspent ≤ cap; Σtokens ≤ supply for sale; refund + spent = deposit; no bid below P wins; adding a bid never lowers P; order independence." },
          { k: "Fees", s: "offchain-passing", v: "The split sums exactly to the input; repayment never exceeds outstanding; the flip happens at exactly 0 with crossover overflow to the flywheel; drips drain the vault to exactly 0." },
          { k: "Commitment", s: "offchain-passing", v: "80-byte layout; distinct salts give distinct commitments; changing any field changes the hash." },
          { k: "Schema and demo world", s: "offchain-passing", v: "Creator allocation > 200 bps rejected; only legal status transitions; vault ≥ 0; repaidPct within 0–100." },
          { k: "API and e2e", s: "offchain-passing", v: "API unit tests 26/26, defi 13/13; e2e checks that auctions expose no per-bid fields and the 2% cap returns 400." },
          { k: "Program", s: "chain-pending", v: "Lifecycle suite (commit-reveal, clearing, refunds, cap, vault guard, flywheel flip, sniper exclusion) plus 14 math.rs unit tests — written, not yet run here." },
          { k: "Custodial ledger", s: "dev", v: "Double-entry balance (Σ postings = 0), reserves ≥ liabilities, withdrawal limits — to be covered by the offchain workstream." },
        ]}
      />
      <P>
        Reproduce a failing property test with <C>INVARIANT_SEED=&lt;seed&gt;</C>; soak with <C>INVARIANT_RUNS=5000</C>.
      </P>

      <H2 id="limits" n="12.3">Known limitations</H2>
      <UL>
        <li>
          <strong>Deposit size leaks.</strong> Onchain the escrow transfer is public; pad deposits. Offchain, deposits to the company wallet are public.
        </li>
        <li>
          <strong>Salts are the secret.</strong> Lose the salt and miss the window and {NO_REVEAL_SLASH_BPS / 100}% of the deposit is slashed.
        </li>
        <li>
          <strong>Relayer keys.</strong> Without <C>RELAYER_BOX_SEED</C> the API uses ephemeral keys and queued reveals do not survive a restart.
        </li>
        <li>
          <strong>Onchain keeper wiring.</strong> <C>buybackKeeper.ts</C> passes <C>keeper</C> instead of the IDL&apos;s <C>cranker</C> and omits accounts that{" "}
          <C>execute_buyback_drip</C> and <C>distribute_fees</C> need.
        </li>
        <li>
          <strong>Holder rewards need staking.</strong> With nothing staked, the holder share of a distribution goes to treasury.
        </li>
        <li>
          <strong>Platform-token burn is off-chain and unbuilt.</strong> The 20% ops and 35% buyback-burn shares land as quote in the platform ops account.
        </li>
        <li>
          <strong>Anti-snipe binds wallets, not tokens.</strong> A flagged buyer can move tokens to a fresh wallet.
        </li>
        <li>
          <strong>Network bounds differ.</strong> The API schema accepts a 2-minute commit window on any network; only the program enforces 15 minutes on mainnet.
        </li>
        <li>
          <strong>Non-demo launch creation.</strong> <C>POST /api/launches</C> returns 501 with create_launch args and omits <C>drip_interval_sec</C> /{" "}
          <C>drip_count</C>, so clients must add them.
        </li>
        <li>
          <strong>Withdrawal limits use demo prices</strong> from the quote-asset registry for USD conversion.
        </li>
        <li>
          <strong>Demo mode is not secure mode.</strong> <C>demo-bid</C> and in-memory launch creation are unauthenticated and exist only with{" "}
          <C>DEMO_MODE=true</C>.
        </li>
      </UL>

      <H2 id="roadmap" n="12.4">Roadmap</H2>
      <Ledger
        items={[
          { k: "Custodial backend", s: "dev", v: "Ledger engine, SIWS, deposit watcher, payouts, proof of reserves, admin queue." },
          { k: "Custody hardening", s: "planned", v: "Multisig or MPC for the company wallet, hot/cold split, independent reserve attestations, ledger export." },
          { k: "Program to devnet", s: "planned", v: "Run the anchor suite, deploy with deploy-devnet.sh, fix keeper wiring, run the indexer against it." },
          { k: "Onchain mode", s: "planned", v: "Non-custodial execution with the Anchor program as the source of truth." },
          { k: "Private deposits", s: "planned", v: "Phases A (bucketed), B (ring-funded, attested), C (non-custodial ring CPI). See Privacy." },
          { k: "External audit and mainnet", s: "planned", v: "Not before the above. Nothing on this site claims otherwise." },
        ]}
      />
    </>
  );
}
