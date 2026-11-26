import type { Metadata } from "next";
import { NO_REVEAL_SLASH_BPS, NUM_PRICE_TICKS, TOKEN_UNIT, computeClearing, settleBid, type ClearingInput } from "@sealed/shared";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { PreimageLayout, Sequence, TickHistogram } from "@/components/docs/Diagrams";
import { A, Accent, C, DocHeader, Figure, Formula, H2, H3, N, Note, OL, P, StatusBadge, Table, UL } from "@/components/docs/Prose";

export const metadata: Metadata = { title: "Sealed auction" };

/* Test vectors from packages/shared/src/__tests__/core.test.ts, computed live with the canonical functions. */
const base = { floorPrice: 100n, tickSize: 10n, numTicks: NUM_PRICE_TICKS, tokensForSale: 1_000n * TOKEN_UNIT, clearingCap: 10_000_000n };
const hist = (m: Record<number, bigint>) => Array.from({ length: NUM_PRICE_TICKS }, (_, i) => m[i] ?? 0n);
const A_IN: ClearingInput = { ...base, buckets: hist({ 5: 100_000n, 2: 100_000n }) };
const A_RES = computeClearing(A_IN);
const A_HI = settleBid(A_RES, base.floorPrice, base.tickSize, 5, 100_000n, 100_000n);
const A_LO = settleBid(A_RES, base.floorPrice, base.tickSize, 2, 100_000n, 120_000n);
const A_LOSER = settleBid(A_RES, base.floorPrice, base.tickSize, 1, 50_000n, 50_000n);

const VECTORS: Array<{ name: string; input: ClearingInput; note: string }> = [
  { name: "Oversubscribed", input: A_IN, note: "tick 5: 100,000 · tick 2: 100,000" },
  { name: "Undersubscribed", input: { ...base, buckets: hist({ 3: 10_000n }) }, note: "tick 3: 10,000" },
  { name: "Between ticks", input: { ...base, buckets: hist({ 10: 125_000n }) }, note: "tick 10: 125,000" },
  { name: "Hard cap", input: { ...base, clearingCap: 150_000n, buckets: hist({ 20: 300_000n, 15: 100_000n }) }, note: "cap 150,000 · tick 20: 300,000 · tick 15: 100,000" },
];

const s = (b: bigint) => b.toLocaleString("en-US");
const tokens = (b: bigint) => (Number(b) / Number(TOKEN_UNIT)).toLocaleString("en-US", { maximumFractionDigits: 6 });

export default function SealedAuction() {
  return (
    <>
      <DocHeader
        n="03"
        kicker="Sealed auction"
        title={
          <>
            Commit a hash. Reveal it later. Everyone pays <Accent>one</Accent> price.
          </>
        }
        lede="A sealed-bid, uniform-price auction over a 64-tick price grid. Prices and sizes stay hidden until the reveal window; the clearing algorithm is integer-exact and identical in TypeScript and Rust."
      >
        <StatusBadge status="offchain-passing" label="Clearing math · tests passing" />
        <StatusBadge status="demo" />
        <StatusBadge status="dev" label="Offchain ledger" />
        <StatusBadge status="chain-pending" />
      </DocHeader>

      <H2 id="commit" n="3.1">Commit</H2>
      <P>
        In the commit window a bidder locks a deposit and submits a 32-byte commitment. One bid per bidder per launch. The deposit must cover the bid
        amount; any excess comes back at settlement.
      </P>
      <Formula caption="commitment.ts · recomputed in reveal_bid (math.rs) over exactly these four slices">
        commitment = keccak256( bidder[32] ‖ max_price u64 LE ‖ bid_amount u64 LE ‖ salt[32] )
      </Formula>
      <Figure caption="The 80-byte preimage. The bidder pubkey binds the bid to its owner, so anyone may submit the reveal without being able to change it.">
        <PreimageLayout />
      </Figure>
      <P>The public sees the bid count, the number of escrowed wallets, total escrowed and the time left. The API never returns individual commitments, prices or sizes for launches in commit or reveal.</P>
      <CodeBlock
        lang="ts"
        title="Build a commitment with @sealed/shared"
        code={`import { computeCommitment, randomSalt, tickPrice, toHex } from "@sealed/shared";

const floor = 100n, tick = 10n;              // quote atoms per whole token
const maxPrice = tickPrice(floor, tick, 5);  // 150 — must sit on the grid
const salt = randomSalt();                   // 32 bytes; keep it secret, keep it safe

const commitment = computeCommitment({
  bidder: wallet.publicKey,                  // base58 string or PublicKey
  maxPrice,
  bidAmount: 100_000n,                       // quote atoms, ≤ deposit
  salt,
});
console.log(toHex(commitment));              // 64 hex chars`}
      />

      <H2 id="ticks" n="3.2">The tick grid</H2>
      <Formula>price(i) = floor_price + i × tick_size, 0 ≤ i &lt; {NUM_PRICE_TICKS}</Formula>
      <P>
        Prices are quote atoms per whole token (<N>{s(TOKEN_UNIT)}</N> token atoms). A max price off the grid fails reveal with <C>InvalidTick</C>. On
        reveal the bid amount is added to <C>histogram[tick]</C>; clearing reads only that 64-bucket histogram, so it costs the same whatever the
        number of bids.
      </P>

      <H2 id="reveal" n="3.3">Reveal and auto-reveal</H2>
      <P>
        In the reveal window anyone holding the preimage submits it. The commitment is recomputed; a mismatch fails with <C>CommitmentMismatch</C>, a
        bid amount above the deposit with <C>BidExceedsDeposit</C>.
      </P>
      <P>
        Missing the window costs <N>{NO_REVEAL_SLASH_BPS / 100}%</N> of the deposit, so Sealed offers an <strong>auto-reveal relayer</strong>. During
        commit the browser seals the preimage to the relayer&apos;s x25519 key with <C>nacl.box</C> and an ephemeral keypair, and the wallet signs{" "}
        <C>sealed-reveal:v1:&lt;launch&gt;:&lt;commitment&gt;</C>.
      </P>
      <Figure>
        <Sequence
          lanes={["Browser", "API relayer", "Ledger / program"]}
          steps={[
            { from: 0, to: 1, label: "GET /api/relayer/pubkey", note: "x25519 key + fee payer" },
            { from: 0, to: 0, label: "seal {maxPrice, bidAmount, salt}; sign the reveal message" },
            { from: 0, to: 1, label: "POST /api/relayer/reveals (envelope)" },
            { from: 1, to: 1, label: "verify signature, decrypt once to check it hashes to the commitment, discard plaintext" },
            { from: 1, to: 2, label: "at window open: decrypt again, reveal_bid", note: "up to 8 attempts" },
          ]}
        />
      </Figure>
      <UL>
        <li>The relayer can learn your bid early (it holds the key) and can withhold your reveal — you can always reveal yourself.</li>
        <li>It cannot change your bid (the keccak check binds it) and, onchain, cannot move funds (it only pays fees).</li>
      </UL>

      <H2 id="clearing" n="3.4">Uniform clearing</H2>
      <P>All maths is unsigned integer, rounding down in favour of refunds. With S = tokens for sale and B_k = Σ budgets at ticks ≥ k:</P>
      <OL>
        <li>
          <strong>Unconstrained price.</strong> Walk ticks from the top. Within band (p<sub>k−1</sub>, p<sub>k</sub>] the best feasible price is{" "}
          <C>c_k = min(p_k, B_k × UNIT / S)</C>. P is the largest c_k that lies inside its band and ≥ floor. If none does, the auction is undersubscribed:
          P = floor and every bid fills.
        </li>
        <li>
          <strong>Hard cap.</strong> If P × S exceeds <C>clearing_cap × UNIT</C>, P becomes <C>cap × UNIT / S</C> (never below floor) and every qualifying
          bid is pro-rated by cap ⁄ B<sub>Q</sub> (<C>pro_rata_all</C>).
        </li>
        <li>
          <strong>Fill.</strong> Otherwise bids priced above P fill fully; bids exactly at P (the marginal tick) share what is left:{" "}
          <C>(S × P / UNIT − B_above) / bucket[marginal]</C> (<C>full_above</C>).
        </li>
      </OL>
      <Formula caption="settleBid — per bid, at claim time">
        spent = bid_amount × fill_num / fill_den · tokens = spent × UNIT / P · refund = deposit − spent
      </Formula>

      <H3 id="worked">Worked example</H3>
      <P>
        Floor <N>100</N>, tick <N>10</N>, <N>1,000</N> tokens for sale, cap <N>{s(base.clearingCap)}</N> quote atoms. Two bids: <N>100,000</N> at tick 5
        (price 150) and <N>100,000</N> at tick 2 (price 120).
      </P>
      <Figure caption="Black fill = the part of each tick's budget that is spent at the clearing price. Computed at build time with computeClearing.">
        <TickHistogram floor={base.floorPrice} tick={base.tickSize} buckets={A_IN.buckets} result={A_RES} unitLabel="atoms" />
      </Figure>
      <OL>
        <li>Tick 5: B = 100,000 → c = min(150, 100,000 × 10⁶ ⁄ 10⁹) = 100, not above p₄ = 140. Infeasible.</li>
        <li>
          Tick 2: B = 200,000 → c = min(120, 200) = 120 &gt; p₁ = 110. Feasible, so P = <N>{s(A_RES.clearingPrice)}</N>.
        </li>
        <li>
          Value at P: 1,000 × 120 = 120,000. The tick-5 bid takes 100,000; the marginal tick-2 bucket gets the remaining 20,000 of 100,000 ({" "}
          <C>
            fill {s(A_RES.fillNum)}/{s(A_RES.fillDen)}
          </C>
          ).
        </li>
      </OL>
      <Table
        head={["Bid", "Deposit", "Spent", "Tokens", "Refund"]}
        rows={[
          ["tick 5 · 100,000", "100,000", <N key="a">{s(A_HI.spent)}</N>, <N key="b">{tokens(A_HI.tokens)}</N>, <N key="c">{s(A_HI.refund)}</N>],
          ["tick 2 · 100,000", "120,000", <N key="a">{s(A_LO.spent)}</N>, <N key="b">{tokens(A_LO.tokens)}</N>, <N key="c">{s(A_LO.refund)}</N>],
          ["tick 1 · 50,000 (hypothetical)", "50,000", <N key="a">{s(A_LOSER.spent)}</N>, <N key="b">{tokens(A_LOSER.tokens)}</N>, <N key="c">{s(A_LOSER.refund)}</N>],
        ]}
        caption="Both winners pay 120 per token, below the 150 the first bidder was willing to pay. A bid below P wins nothing and is refunded in full."
      />

      <H3 id="vectors">All test vectors</H3>
      <Table
        dense
        head={["Vector", "Buckets", "P", "Rule", "Fill", "Raised"]}
        rows={VECTORS.map((v) => {
          const r = computeClearing(v.input);
          return [
            v.name,
            v.note,
            <N key="p">{s(r.clearingPrice)}</N>,
            <C key="r">{r.rule}</C>,
            <N key="f">
              {s(r.fillNum)}/{s(r.fillDen)}
            </N>,
            <N key="t">{s(r.totalRaised)}</N>,
          ];
        })}
        caption="floor 100, tick 10, 1,000 tokens for sale. These vectors are asserted in packages/shared/src/__tests__/core.test.ts."
      />

      <H2 id="settlement" n="3.5">Refunds and slashing</H2>
      <Table
        head={["Case", "Tokens", "Quote returned"]}
        rows={[
          ["Auction failed (nothing revealed or raised)", "0", "full deposit"],
          ["Committed, never revealed", "0", <span key="a">deposit − {NO_REVEAL_SLASH_BPS / 100}% (slash to treasury)</span>],
          ["Revealed, below P", "0", "full deposit"],
          ["Revealed, above P", "bid_amount × UNIT / P", "deposit − bid_amount"],
          ["Revealed, at P (marginal)", "pro-rated spent × UNIT / P", "deposit − spent"],
        ]}
      />
      <P>
        Onchain, <C>claim_or_refund(stake)</C> settles one bid, closes the bid account and can stake the tokens directly. Graduation keeps a buffer of one
        atom per revealed bid in escrow so per-bid rounding never leaves a refund uncovered.
      </P>

      <H2 id="leaks" n="3.6">What a sealed bid does not hide</H2>
      <Note title="Deposit size" tone="warn">
        <p>
          Onchain, the deposit is a public SPL transfer and is stored in <C>SealedBid.deposit</C>, so it bounds your bid size from above. Pad it: escrow
          more than you intend to bid, in round numbers. Offchain, the deposit is a ledger lock that only the operator sees, but your original deposit to
          the company wallet is a public transfer. See <A href="/docs/privacy">Privacy</A>.
        </p>
        <p>
          Salts are the secret. In the browser they are stored encrypted (AES-GCM, key derived from a wallet signature) in IndexedDB. Lose the salt and
          miss the window, and the bid is slashed.
        </p>
      </Note>
    </>
  );
}
