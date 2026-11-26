import type { Metadata } from "next";
import { COMPANY_WALLET, NO_REVEAL_SLASH_BPS, WITHDRAWAL_LIMITS } from "@sealed/shared";
import { MAINNET_COMMIT_WINDOW, RealFundsDisclosure } from "@/components/docs/Mainnet";
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
        <StatusBadge status="rolling" label="Mainnet custodial · real funds · rolling out" />
      </DocHeader>

      <RealFundsDisclosure />
      <Note title="Custody in one line" tone="signal">
        <p>
          Sealed is <strong>custodial on Solana mainnet</strong>: deposits sit in the company wallet <C>{COMPANY_WALLET}</C> and your balance is a ledger
          entry. Sealed can see your bids once submitted, can delay or refuse withdrawals, and could lose funds if the operator key is compromised. There
          is no insurance, no audit and no regulatory licence behind this service. See <A href="/docs/custody">Custody</A>.
        </p>
      </Note>

      <H2 id="trust" n="12.1">Trust model</H2>
      <H3 id="trust-offchain">Offchain custodial (default)</H3>
      <Table
        head={["Party", "Can", "Cannot"]}
        rows={[
          ["Operator (company wallet key)", "move reserves; pause, delay or reject withdrawals; read every bid after submission", "forge your SIWS signature; hide reserves from proof of reserves (they are on-chain)"],
          ["Admin token holder (x-admin-token)", <>approve or reject withdrawals held above <C>${WITHDRAWAL_LIMITS.autoApproveMaxUsd}</C>, over the daily cap or without a fresh price; reject queued ones; seed the credit pool ledger account. Admin routes require <C>ADMIN_TOKEN</C></>, "send funds without the wallet key"],
          ["Browser (via POST /api/rpc)", "call the allowlisted JSON-RPC methods the web app needs, within the rate limit", "see the RPC provider key or call methods outside the allowlist"],
          ["Other users", "see aggregate auction counters", "see your bid before reveal (the API never returns it)"],
          ["Chain observers", "see deposits to and withdrawals from the company wallet", "see bids, fills or internal trades"],
        ]}
      />
      <H3 id="trust-onchain">Onchain (roadmap)</H3>
      <Table
        head={["Party", "Can", "Cannot"]}
        rows={[
          ["Admin", "initialize the protocol once (treasury, platform ops, keeper, mainnet flag, max credit)", "withdraw the buyback vault, escrow or pool (no such instruction exists)"],
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
          { k: "Schema and state model", s: "offchain-passing", v: "Creator allocation > 200 bps rejected; only legal status transitions; vault ≥ 0; repaidPct within 0 to 100." },
          { k: "API and e2e", s: "offchain-passing", v: "API suite 87/87 (node --import tsx --test test/*.test.ts in apps/api), defi 13/13; e2e checks that auctions expose no per-bid fields and the 2% cap returns 400." },
          { k: "Program", s: "chain-pending", v: "anchor build OK; 15/15 Rust unit tests (14 in math.rs plus the generated id test); 18/18 anchor tests with --features test-mode (commit-reveal, clearing, refunds, cap, vault guard, flywheel flip, sniper exclusion). Not deployed." },
          { k: "Custodial ledger", s: "offchain-passing", v: "Random-op fuzz keeps Σ postings = 0 per transaction and stored balances = Σ entries with no negative user balance; idempotent replays; serialized concurrent debits; end-to-end lifecycle reconciles supply and liabilities." },
          { k: "Custody", s: "offchain-passing", v: "SIWS (nonce replay, expiry, revocation, 7-day sessions); deposit parser fixtures and exactly-once crediting; withdrawal limits; payouts disabled without the key; idempotent payout worker (rebroadcast, expiry re-queue, failure unlock); admin auth." },
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
          <strong>Real funds in one hot wallet.</strong> Every mainnet deposit sits in a single company wallet controlled by one key held as a Railway
          secret. No multisig, MPC or hot/cold split yet.
        </li>
        <li>
          <strong>Launched tokens are ledger-only.</strong> Tokens won or bought on Sealed are custodial ledger balances and cannot be withdrawn on-chain yet.
          Only SOL and USDC withdraw.
        </li>
        <li>
          <strong>Tokenized stocks are coming soon.</strong> Their mainnet mints are not verified, so only SOL and USDC are enabled on mainnet.
        </li>
        <li>
          <strong>Payouts depend on a SOL fee balance.</strong> If the company wallet runs low on SOL, payouts pause with a reason until it is topped up.
        </li>
        <li>
          <strong>Relayer sees your bid twice.</strong> The relayer decrypts an auto-reveal envelope once on submission to check it matches the commitment
          (plaintext discarded), then again when the reveal window opens.
        </li>
        <li>
          <strong>Internal pool instead of Raydium.</strong> Graduation seeds Sealed&apos;s own constant-product pool (program pool onchain, ledger pool offchain).
          The Raydium adapter in <C>packages/defi</C> is optional and not called by the protocol.
        </li>
        <li>
          <strong>First drip is one interval after graduation</strong>, not at the moment of graduation: <C>nextDripTs = graduation + dripIntervalSec</C>.
        </li>
        <li>
          <strong>Credit depends on the pool balance.</strong> Offchain, the credit line is capped by the <C>credit_pool</C> ledger balance. Until the
          operator seeds it (<C>POST /api/admin/credit-pool/seed</C>) a graduating launch gets no buyback vault and goes straight to the flywheel split.
        </li>
        <li>
          <strong>Network bounds.</strong> On mainnet the API requires a {MAINNET_COMMIT_WINDOW} commit window (rolling out). Local development
          still accepts 2 minutes.
        </li>
        <li>
          <strong>Onchain-mode launch creation.</strong> With <C>EXECUTION_MODE=onchain</C>, <C>POST /api/launches</C> returns 501 with
          create_launch args and omits <C>drip_interval_sec</C> / <C>drip_count</C>, so clients must add them. (Offchain, a signed-in creator gets a real
          launch.)
        </li>
        <li>
          <strong>Withdrawal limits depend on a price feed.</strong> USD limits use live Jupiter Price API prices (rolling out); without a fresh price the
          withdrawal fails safe to manual approval, which can delay it.
        </li>
        <li>
          <strong>The in-memory store is for local development.</strong> Without <C>DATABASE_URL</C> the API keeps state in memory, which is not durable.
          Production runs on Postgres with backups.
        </li>
      </UL>

      <H2 id="roadmap" n="12.4">Roadmap</H2>
      <Ledger
        items={[
          { k: "Custodial backend", s: "offchain-passing", sLabel: "Built · tests passing", v: "Ledger engine, SIWS, deposit watcher, payouts, proof of reserves, admin queue. Deployed on Railway." },
          { k: "Mainnet custody", s: "rolling", v: "NETWORK=mainnet, COMPANY_WALLET_SECRET_KEY, HELIUS_API_KEY and ADMIN_TOKEN set, company wallet funded with SOL for fees, credit pool seeded. See the mainnet readiness checklist in Deploy." },
          { k: "On-chain withdrawal of launched tokens", s: "planned", v: "Today only SOL and USDC withdraw." },
          { k: "Custody hardening", s: "planned", v: "Multisig or MPC for the company wallet, hot/cold split, independent reserve attestations, ledger export." },
          { k: "Program deployment", s: "planned", v: "Anchor suite passes locally; next: deploy the program, fix keeper wiring, run the indexer against it." },
          { k: "Onchain mode", s: "planned", v: "Non-custodial execution with the Anchor program as the source of truth." },
          { k: "Private deposits", s: "planned", v: "Phases A (bucketed), B (ring-funded, attested), C (non-custodial ring CPI). See Privacy." },
          { k: "External audit", s: "planned", v: "No audit exists for the custodial backend or the program. Nothing on this site claims otherwise." },
        ]}
      />
    </>
  );
}
