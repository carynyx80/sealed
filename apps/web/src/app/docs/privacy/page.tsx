import type { Metadata } from "next";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { A, Accent, C, DocHeader, H2, H3, Ledger, Note, P, StatusBadge, Table, UL } from "@/components/docs/Prose";

export const metadata: Metadata = { title: "Privacy" };

const RPC = [
  "getEncryptedUtxosByTags",
  "getShieldedTransactionsByTags",
  "getShieldedTransactionsBySignature",
  "getShieldedTransactionsByNullifiers",
  "getMerkleProofs",
  "getNonInclusionProofs",
  "getNullifierQueueElements",
  "getUserRecords",
];

export default function Privacy() {
  return (
    <>
      <DocHeader
        n="06"
        kicker="Privacy"
        title={
          <>
            Hide the deposit, not just the <Accent>bid</Accent>.
          </>
        }
        lede="A commitment hides price and size, but a public deposit still bounds bid size from above. Helius Solana Privacy Rings encrypt amounts. This page summarises what is hidden, what stays public, and what is real today. The full analysis is docs/PRIVACY.md."
      >
        <StatusBadge status="simulated" label="Ring · simulated in demo" />
        <StatusBadge status="offchain-passing" label="Status probe + RPC proxy" />
        <StatusBadge status="planned" label="Private escrow · phases A to C" />
      </DocHeader>

      <H2 id="leak" n="6.1">The leak</H2>
      <Table
        head={["Field", "Where it lives", "Visible during commit?"]}
        rows={[
          ["max price", "inside the keccak commitment", "no"],
          ["bid amount", "inside the commitment", "no"],
          [<strong key="d">deposit</strong>, <span key="w">public SPL transfer to escrow; stored as <C>SealedBid.deposit</C> (onchain mode)</span>, <strong key="y">yes</strong>],
        ]}
      />
      <P>
        Because <C>bid_amount ≤ deposit</C>, the deposit reveals an upper bound on size, which is enough to spot and copy whales. Refunds and holder
        payouts also land in public token accounts.
      </P>
      <H3 id="custodial">In custodial mode</H3>
      <P>
        Offchain, bids and their deposits are ledger entries, so chain observers see none of them. What they do see is your deposit into, and withdrawals
        out of, the company wallet: public transfers with amounts. The operator sees everything, including revealed bids, as soon as you submit them. The
        trust moves from the chain to <A href="/docs/custody">the custodian</A>.
      </P>

      <H2 id="rings" n="6.2">What Helius Privacy Rings provide</H2>
      <UL>
        <li>The Default (confidential) Ring encrypts the amount and asset of private balances and transfers. Sender and recipient addresses stay visible.</li>
        <li>Deposits into a ring (public → private) and withdrawals (private → public) publish their amounts. Only private → private transfers hide them.</li>
        <li>Owners read balances locally with an X25519 viewing key. Proofs come from a Helius-hosted prover in a TEE, or a local prover.</li>
        <li>
          Solana Privacy Program <C>ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW</C>, the same id on every cluster. The Helius docs disagree on whether mainnet
          beta is live, so the API probes liveness at runtime.
        </li>
      </UL>

      <H2 id="matrix" n="6.3">Hidden vs public</H2>
      <Table
        head={["", "Today (public deposit)", "Target design"]}
        rows={[
          ["Max price, bid size", "hidden until reveal", "same"],
          ["Deposit amount", <strong key="a">public</strong>, "hidden (ring ciphertext)"],
          ["Refunds, holder payouts", "public", "hidden (confidential transfer)"],
          ["Bidder and escrow addresses", "public", <strong key="b">still public</strong>],
          ["Aggregate escrow, clearing results", "public", "public"],
          ["Buyback drips, protocol fees", "public", "public by design"],
        ]}
        caption="After reveal, max price and bid amount are public in every design: ring privacy protects the commit window, which is when copy-trading happens."
      />

      <H2 id="real" n="6.4">Real vs simulated</H2>
      <Ledger
        items={[
          { k: "GET /api/privacy/status", s: "offchain-passing", v: "Live probe via getUserRecords, cached 60 s. Returns simulated: true in demo mode." },
          { k: "POST /api/privacy/rpc", s: "offchain-passing", v: <>Proxies the 8 documented indexer methods; <C>HELIUS_API_KEY</C> never leaves the server; 32 KB body, 120 requests/min/IP.</> },
          { k: "Private deposit toggle (demo)", s: "simulated", v: "A nacl.secretbox ring model funds a shielded escrow; bids are marked privately funded. No real funds." },
          { k: "Private deposit (mainnet)", s: "planned", v: "Fails closed: the escrow is a plain SPL token account and cannot receive confidential transfers. The toggle is disabled with the reason." },
          { k: "Shield, transfer, withdraw, decrypt", s: "planned", v: "Need @heliuslabs/spr plus a shielded keypair that wallet-adapter cannot yet derive. Behind the HeliusSprBindings seam." },
        ]}
      />
      <CodeBlock
        lang="http"
        title="Indexer proxy"
        code={`POST /api/privacy/rpc
Content-Type: application/json

{ "method": "getUserRecords", "params": { "owners": ["<base58 wallet>"] } }

allowed methods:
  ${RPC.join("\n  ")}`}
      />

      <H2 id="plan" n="6.5">The plan</H2>
      <Ledger
        items={[
          { k: "Phase A · bucketed deposits", s: "planned", v: <>A new <C>commit_bid_v2(commitment, bucket)</C> with fixed deposit buckets (for example 100 / 1k / 10k / 100k). The deposit then leaks only a coarse bucket. No Helius dependency.</> },
          { k: "Phase B · ring-funded commits", s: "planned", v: <>A confidential transfer to a launch escrow-operator Shielded Address, attested off-chain and verified with an Ed25519 precompile in <C>commit_bid_shielded</C>; one aggregate withdrawal at settlement; confidential refunds. Custodial between commit and settle, with a time-locked public fallback.</> },
          { k: "Phase C · non-custodial", s: "planned", v: "When Custom Rings or ring CPI allow program-controlled UTXOs: the launch PDA owns the ring account, no attestor, no custody." },
        ]}
      />
      <Note>
        <p>
          The full research, sources, trust model and contract plan are in <C>docs/PRIVACY.md</C>, maintained by the privacy workstream. This page does not
          override it.
        </p>
      </Note>
    </>
  );
}
