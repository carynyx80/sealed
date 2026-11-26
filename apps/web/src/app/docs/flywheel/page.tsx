import type { Metadata } from "next";
import { ANTI_SNIPE_WINDOW_SEC, FLYWHEEL_SPLIT, POOL_FEE_BPS, REPAY_SPLIT, splitFees } from "@sealed/shared";
import { FeeSplitDiagram } from "@/components/docs/Diagrams";
import { Accent, C, DocHeader, Figure, Formula, H2, H3, Ledger, N, Note, P, StatusBadge, Table, UL } from "@/components/docs/Prose";

export const metadata: Metadata = { title: "Flywheel" };

const pct = (bps: number) => `${bps / 100}%`;
const CASES: Array<{ fees: bigint; outstanding: bigint; label: string }> = [
  { fees: 1000n, outstanding: 10_000n, label: "Repaying" },
  { fees: 1000n, outstanding: 300n, label: "Crossover batch" },
  { fees: 1000n, outstanding: 0n, label: "Flywheel" },
];
const s = (b: bigint) => b.toLocaleString("en-US");

export default function Flywheel() {
  return (
    <>
      <DocHeader
        n="05"
        kicker="Flywheel"
        title={
          <>
            Fees repay the credit, then flow to holders <Accent>for good</Accent>.
          </>
        }
        lede={`Every swap through the graduation pool pays a ${pct(POOL_FEE_BPS)} fee in the quote asset. One function, splitFees, decides where each atom goes, and it flips phase at exactly zero outstanding credit.`}
      >
        <StatusBadge status="offchain-passing" label="splitFees · tests passing" />
        <StatusBadge status="live" />
        <StatusBadge status="offchain-passing" label="Offchain ledger · tests passing" />
        <StatusBadge status="chain-pending" />
      </DocHeader>

      <H2 id="phases" n="5.1">Two phases</H2>
      <Figure>
        <FeeSplitDiagram />
      </Figure>

      <H2 id="formulas" n="5.2">The formulas</H2>
      <P>Integer quote atoms, rounding down; rounding dust goes to treasury so the parts always sum to the input.</P>
      <H3 id="repaying">While credit is outstanding</H3>
      <Formula>
        repay_share = fees × {REPAY_SPLIT.creditRepayBps} / 10,000
        <br />
        credit_repay = min(repay_share, outstanding)
        <br />
        platform_ops = fees × {REPAY_SPLIT.platformBurnOpsBps} / 10,000
        <br />
        flywheel_base = repay_share − credit_repay <span className="text-ink-muted">// overflow in the crossover batch</span>
      </Formula>
      <H3 id="after">Once outstanding is zero</H3>
      <Formula>
        flywheel_base = fees
        <br />
        holders = flywheel_base × {FLYWHEEL_SPLIT.holderPayoutBps} / 10,000
        <br />
        platform_buyback_burn = flywheel_base × {FLYWHEEL_SPLIT.platformBuybackBurnBps} / 10,000
        <br />
        treasury = fees − credit_repay − platform_ops − holders − platform_buyback_burn
      </Formula>

      <H3 id="examples">Worked cases</H3>
      <Table
        head={["Case", "Fees", "Outstanding", "Repay", "Ops", "Holders", "Burn", "Treasury", "After"]}
        dense
        rows={CASES.map((c) => {
          const r = splitFees(c.fees, c.outstanding);
          return [
            c.label,
            <N key="0">{s(c.fees)}</N>,
            <N key="1">{s(c.outstanding)}</N>,
            <N key="2">{s(r.creditRepay)}</N>,
            <N key="3">{s(r.platformOps)}</N>,
            <N key="4">{s(r.holders)}</N>,
            <N key="5">{s(r.platformBuybackBurn)}</N>,
            <N key="6">{s(r.treasury)}</N>,
            <N key="7">{s(r.creditOutstandingAfter)}</N>,
          ];
        })}
        caption="Computed with splitFees at build time; the same cases are asserted in core.test.ts. In the crossover batch the 500 atoms of the 80% share left after repaying 300 are split by the flywheel ratios."
      />

      <H2 id="where" n="5.3">Where each share goes</H2>
      <Ledger
        items={[
          { k: "Credit repayment", v: <>Back to the Credit Pool vault (<C>credit_vault</C>), reducing <C>outstanding</C>. Recycled into the next launch&apos;s credit line.</> },
          { k: "Platform ops (20%) and platform buyback-burn (35%)", v: <>Both are sent in the quote asset to the <C>platform_ops</C> token account. Buying and burning a platform token with it happens outside the program and is not implemented yet.</>, s: "planned", sLabel: "Platform-token burn · planned" },
          { k: "Holders (50%)", v: <>Sent to the launch&apos;s <C>rewards_vault</C> and accrued per staked token: <C>reward_per_share += holders × 10¹² / total_staked</C>. Holders claim with <C>claim_rewards</C>.</> },
          { k: "Treasury (15% + dust)", v: <>The <C>treasury</C> token account set at <C>initialize_protocol</C>.</> },
        ]}
      />
      <Note title="Holder rewards require staking">
        <p>
          Rewards accrue to <strong>staked</strong> tokens only, not to every wallet that holds the token. If nothing is staked when fees are distributed,
          the holder share goes to treasury in that batch. Winners can stake directly at claim time with <C>claim_or_refund(stake = true)</C>.
        </p>
      </Note>

      <H2 id="antisnipe" n="5.4">The anti-snipe rule</H2>
      <P>
        Bots that buy the instant a pool opens extract value from everyone else. Sealed does not stop the buy, it removes the reward:
      </P>
      <UL>
        <li>
          <strong>Onchain:</strong> a buy in the same slot as <C>graduation_slot</C> creates an <C>AntiSnipeEntry</C> PDA for that wallet and emits{" "}
          <C>SniperFlagged</C>. That wallet&apos;s <C>stake</C>, <C>claim_rewards</C> and staking at claim fail with <C>SniperIneligible</C>.
        </li>
        <li>
          <strong>Offchain:</strong> buys executed within <N>{ANTI_SNIPE_WINDOW_SEC}</N> s of graduation are flagged (<C>ANTI_SNIPE_WINDOW_SEC</C>), listed
          in <C>sniperFlags</C> on the account, and earn <N>0%</N> holder rewards.
        </li>
        <li>The flag is permanent per launch and wallet. It does not apply to other launches.</li>
      </UL>
      <Note title="Limits of the rule" tone="warn">
        <p>A sniper can buy from a fresh wallet and transfer tokens to another wallet later; the rule binds the wallet that bought, not the tokens.</p>
      </Note>
    </>
  );
}
