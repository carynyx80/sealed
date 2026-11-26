import type { Metadata } from "next";
import {
  CREDIT_TIERS,
  DEFAULT_DRIP_COUNT,
  DEFAULT_DRIP_INTERVAL_SEC,
  MAX_DRIP_INTERVAL_SEC,
  MIN_DRIP_INTERVAL_SEC,
  computeCreditLine,
  dripAmount,
} from "@sealed/shared";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { A, Accent, C, DocHeader, Figures, Formula, H2, H3, Ledger, N, Note, P, StatusBadge, Table } from "@/components/docs/Prose";

export const metadata: Metadata = { title: "Buyback vault" };

const pct = (bps: number) => `${bps / 100}%`;
// Worked example: 1,000 USDC raised (6 decimals), premier tier, ample pool liquidity.
const RAISE = 1_000_000_000n;
const credit = computeCreditLine(RAISE, CREDIT_TIERS.premier, 10n ** 15n, 10n ** 15n);
const firstDrip = dripAmount(credit, DEFAULT_DRIP_COUNT, 0, credit);
const ui = (b: bigint) => (Number(b) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });

export default function BuybackVault() {
  return (
    <>
      <DocHeader
        n="04"
        kicker="Buyback vault"
        title={
          <>
            A buyback budget on <Accent>day one</Accent>, that nobody can withdraw.
          </>
        }
        lede="At graduation the Protocol Credit Pool advances a fee-credit line of 10 to 15% of the raise into a vault that can only buy the token and burn it. Pool fees repay the line later."
      >
        <StatusBadge status="live" />
        <StatusBadge status="offchain-passing" label="Offchain ledger · tests passing" />
        <StatusBadge status="chain-pending" />
      </DocHeader>

      <H2 id="credit" n="4.1">The credit line</H2>
      <Formula caption="fees.ts computeCreditLine · math.rs compute_credit_line">
        credit = min( total_raised × credit_bps / 10,000, credit_pool_available, max_credit_per_launch )
      </Formula>
      <Table
        head={["Tier", "credit_bps", "Credit as share of raise"]}
        rows={(Object.keys(CREDIT_TIERS) as Array<keyof typeof CREDIT_TIERS>).map((t) => [
          <C key="t">{t}</C>,
          <N key="b">{CREDIT_TIERS[t]}</N>,
          <N key="p">{pct(CREDIT_TIERS[t])}</N>,
        ])}
        caption="CREDIT_TIERS in @sealed/shared constants.ts. credit_bps outside 1,000 to 1,500 is rejected (InvalidCreditBps)."
      />
      <P>
        The cap by available liquidity means a thin Credit Pool advances less, never more than it holds. <C>max_credit_per_launch</C> is set once in{" "}
        <C>initialize_protocol</C>. Anyone can top up the pool with <C>fund_credit_pool</C>. If the credit comes out at zero, the launch skips straight to
        the flywheel.
      </P>

      <H2 id="drips" n="4.2">Drips</H2>
      <P>
        The vault is spent in <N>{DEFAULT_DRIP_COUNT}</N> equal slices by default, one every <N>{DEFAULT_DRIP_INTERVAL_SEC}</N> s (allowed{" "}
        <N>
          {MIN_DRIP_INTERVAL_SEC} to {MAX_DRIP_INTERVAL_SEC}
        </N>{" "}
        s). The last drip sweeps whatever remains, so the vault ends at exactly zero.
      </P>
      <Formula caption="fees.ts dripAmount">
        drip = drips_executed ≥ drip_count − 1 ? vault_balance : min( vault_initial / drip_count, vault_balance )
      </Formula>
      <P>
        Each drip is a fee-free buy through the graduation pool: the quote moves from the vault into the pool&apos;s quote reserve and the tokens bought are
        burned straight from the pool&apos;s token reserve. The first drip is due one interval after graduation (<C>next_drip_ts = graduated_ts +
        drip_interval</C>), then every interval after the previous drip.
      </P>
      <H3 id="example">Example</H3>
      <Figures
        items={[
          { value: ui(RAISE), unit: "USDC", label: "raised in the auction" },
          { value: ui(credit), unit: "USDC", label: `credit at premier (${pct(CREDIT_TIERS.premier)})` },
          { value: ui(firstDrip), unit: "USDC", label: `per drip × ${DEFAULT_DRIP_COUNT}` },
          { value: String((DEFAULT_DRIP_COUNT * DEFAULT_DRIP_INTERVAL_SEC) / 60), unit: "min", label: "until the vault is empty" },
        ]}
      />

      <H2 id="guarantees" n="4.3">Why it cannot be withdrawn</H2>
      <Ledger
        items={[
          { k: "Onchain mode", s: "chain-pending", v: <>The vault is a token account at PDA <C>[&quot;buyback_vault&quot;, launch]</C> whose authority is the launch PDA. The only instruction that moves funds out is <C>execute_buyback_drip</C>, which sends them to the pool&apos;s quote reserve. There is no admin, creator or arbitrary-destination path.</> },
          { k: "Tests that cover it", v: <>Anchor tests &ldquo;exposes exactly the contract instructions, no vault withdraw path&rdquo; and &ldquo;buyback vault cannot be withdrawn with a forged authority&rdquo; (both pass in the 18/18 anchor run).</> },
          { k: "Bounded cranks", v: <>Drips are permissionless but gated by <C>DripNotDue</C> and <C>VaultEmpty</C>. A hostile caller can only run a drip that is already due.</> },
          { k: "Offchain mode", s: "offchain-passing", v: <>The vault is a ledger account whose only allowed posting is a drip into the pool. This is a <strong>policy enforced by Sealed&apos;s backend</strong>, not by a program: in custodial mode you trust the operator to keep it. See <A href="/docs/custody">Custody</A>.</> },
        ]}
      />

      <H2 id="keeper" n="4.4">The keeper</H2>
      <P>
        Onchain, <C>apps/api/src/workers/buybackKeeper.ts</C> polls every 10 s for due drips, calls <C>execute_buyback_drip</C>, then{" "}
        <C>distribute_fees</C> when the indexer sees new fees. It is disabled without <C>KEEPER_SECRET_KEY</C>.
      </P>
      <Note title="Known gap" tone="warn">
        <p>
          The keeper passes accounts named <C>keeper</C>, <C>buybackVault</C>, <C>pool</C>, <C>poolQuote</C>, <C>poolToken</C> and <C>feeCollector</C>. The
          IDL names the signer <C>cranker</C> and also needs <C>token_mint</C> (drip) and <C>credit_vault</C>, <C>platform_ops_quote</C>,{" "}
          <C>treasury_quote</C> (distribute). Expect the onchain keeper to fail until those are wired. Status: <StatusBadge status="partial" />
        </p>
      </Note>
      <CodeBlock
        lang="ts"
        title="Drip schedule from shared helpers"
        code={`import { CREDIT_TIERS, DEFAULT_DRIP_COUNT, computeCreditLine, dripAmount } from "@sealed/shared";

const raise = 1_000_000_000n;                                   // 1,000 USDC in atoms
const credit = computeCreditLine(raise, CREDIT_TIERS.premier, poolBalance, maxPerLaunch);
let vault = credit;
for (let i = 0; i < DEFAULT_DRIP_COUNT; i++) {
  const d = dripAmount(credit, DEFAULT_DRIP_COUNT, i, vault);   // ${ui(firstDrip)} USDC each
  vault -= d;                                                   // final drip sweeps the remainder
}
// vault === 0n`}
      />
    </>
  );
}
