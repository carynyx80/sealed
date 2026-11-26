import type { Metadata } from "next";
import { ACCOUNTS, INSTRUCTIONS, ONCHAIN_STATUS, PROGRAM_ERRORS, PROGRAM_ID, SEEDS } from "@sealed/shared";
import { Accent, C, DocHeader, H2, H3, N, Note, P, StatusBadge, Table } from "@/components/docs/Prose";

export const metadata: Metadata = { title: "Onchain program" };

const snake = (s: string) => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

/** Caller + account list per instruction, transcribed from programs/sealed-launchpad/idl/sealed_launchpad.json (* = signer). */
const IX_META: Record<keyof typeof INSTRUCTIONS, { caller: string; accounts: string; emits: string }> = {
  initializeProtocol: { caller: "admin, once", accounts: "admin*, protocol, system_program", emits: "—" },
  fundCreditPool: { caller: "anyone", accounts: "funder*, protocol, quote_mint, credit_pool, credit_vault, funder_quote", emits: "—" },
  createLaunch: { caller: "creator", accounts: "creator*, protocol, mint_authority, token_mint*, quote_mint, launch, escrow, stake_vault, rewards_vault, creator_token", emits: "LaunchCreated" },
  commitBid: { caller: "bidder, commit window", accounts: "bidder*, launch, bid, escrow, bidder_quote", emits: "BidCommitted" },
  revealBid: { caller: "anyone with the preimage, reveal window", accounts: "payer*, launch, bidder, bid", emits: "BidRevealed" },
  clearAuction: { caller: "anyone, after reveal_end", accounts: "cranker*, launch", emits: "AuctionCleared" },
  claimOrRefund: { caller: "bidder, after clear", accounts: "bidder*, protocol, launch, bid (closed), token_mint, mint_authority, escrow, bidder_quote, bidder_token, treasury_quote, position, stake_vault, anti_snipe", emits: "—" },
  graduateAndOpenCredit: { caller: "anyone, after clear", accounts: "cranker*, protocol, launch, token_mint, mint_authority, quote_mint, escrow, pool, pool_quote, pool_token, buyback_vault, fee_collector, credit_pool, credit_vault", emits: "Graduated (+ FlywheelActivated if credit = 0)" },
  swap: { caller: "anyone, live", accounts: "user*, protocol, launch, token_mint, pool, pool_quote, pool_token, fee_collector, user_quote, user_token, anti_snipe", emits: "SwapEvent, SniperFlagged" },
  executeBuybackDrip: { caller: "anyone, when due", accounts: "cranker*, launch, token_mint, pool, pool_quote, pool_token, buyback_vault", emits: "BuybackDrip" },
  distributeFees: { caller: "anyone, live", accounts: "cranker*, protocol, launch, credit_pool, credit_vault, fee_collector, rewards_vault, platform_ops_quote, treasury_quote", emits: "FeesDistributed, FlywheelActivated" },
  stake: { caller: "holder (not a sniper)", accounts: "owner*, launch, position, stake_vault, owner_token, anti_snipe", emits: "—" },
  unstake: { caller: "holder", accounts: "owner*, launch, position, stake_vault, owner_token", emits: "—" },
  claimRewards: { caller: "holder (not a sniper)", accounts: "owner*, launch, position, rewards_vault, owner_quote, anti_snipe", emits: "—" },
};

const SEED_SUFFIX: Record<keyof typeof SEEDS, string> = {
  protocol: "—",
  creditPool: "quote_mint",
  launch: "token_mint",
  bid: "launch, bidder",
  escrow: "launch",
  vault: "launch",
  feeCollector: "launch",
  pool: "launch",
  poolQuote: "launch",
  poolToken: "launch",
  antiSnipe: "launch, wallet",
  position: "launch, owner",
  rewardsVault: "launch",
  mintAuthority: "launch",
};

const EVENTS: Array<[string, string]> = [
  ["LaunchCreated", "launch, mint, creator, quote_mint"],
  ["BidCommitted", "launch, bid_count, total_escrowed — aggregates only"],
  ["BidRevealed", "launch, revealed_count"],
  ["AuctionCleared", "launch, clearing_price, total_raised, tokens_sold"],
  ["Graduated", "launch, slot, credit_line"],
  ["SwapEvent", "launch, trader, is_buy, amount_in, amount_out, fee, slot, is_sniper"],
  ["BuybackDrip", "launch, quote_spent, tokens_burned, drip_index, next_drip_ts"],
  ["FeesDistributed", "launch, credit_repay, platform_ops, holders, platform_buyback_burn, treasury, credit_outstanding_after"],
  ["FlywheelActivated", "launch"],
  ["SniperFlagged", "launch, wallet, slot"],
];

const EXTRA_ERRORS = ["InvalidParams", "InvalidStatus", "ZeroAmount", "NotLive", "InvalidAccount"];

export default function ProgramReference() {
  return (
    <>
      <DocHeader
        n="08"
        kicker="Onchain program"
        title={
          <>
            <Accent>sealed_launchpad</Accent>, the non-custodial mode.
          </>
        }
        lede="The Anchor program is the roadmap execution mode: every rule on these pages enforced by Solana instead of by Sealed's backend. It is implemented with a full lifecycle test suite, but it is not built or deployed anywhere yet."
      >
        <StatusBadge status="chain-pending" />
        <StatusBadge status="planned" label="Onchain mode — roadmap" />
      </DocHeader>

      <Note title="Deployment status" tone="warn">
        <p>
          Program id <C>{PROGRAM_ID}</C> (keypair in <C>target/deploy</C>) has <strong>no account on devnet</strong> as of 2026-11-26, and no{" "}
          <C>.so</C> has been built in this workspace. Anchor 0.32, Solana 2.2. The IDL is committed at <C>programs/sealed-launchpad/idl/sealed_launchpad.json</C>.
        </p>
      </Note>

      <H2 id="instructions" n="8.1">Instructions</H2>
      <P>
        Exactly these 14 instructions exist. None moves funds out of <C>buyback_vault</C> except <C>execute_buyback_drip</C>, and the test suite asserts
        the list.
      </P>
      <Table
        dense
        head={["Instruction", "Caller", "Args", "Accounts (* signer)", "Emits"]}
        colClass={["whitespace-nowrap", "min-w-[9rem]", "min-w-[14rem]", "min-w-[18rem]", "min-w-[8rem]"]}
        rows={(Object.keys(INSTRUCTIONS) as Array<keyof typeof INSTRUCTIONS>).map((k) => [
          <C key="n">{snake(k)}</C>,
          IX_META[k].caller,
          <span key="a" className="font-mono text-[12px]">
            {INSTRUCTIONS[k].args.length ? INSTRUCTIONS[k].args.join(", ") : "—"}
          </span>,
          <span key="c" className="font-mono text-[12px]">
            {IX_META[k].accounts}
          </span>,
          IX_META[k].emits,
        ])}
        caption="Args from INSTRUCTIONS in packages/shared/src/program.ts; accounts transcribed from the IDL. The table scrolls sideways on small screens."
      />
      <H3 id="checks">Key checks</H3>
      <Table
        dense
        head={["Instruction", "Rejects with"]}
        rows={[
          [<C key="i">create_launch</C>, "CreatorAllocationTooHigh (> 200 bps), InvalidAuctionSupply, InvalidCreditBps, InvalidDuration, InvalidDripInterval, InvalidParams (cap < floor × supply)"],
          [<C key="i">commit_bid</C>, "CommitWindowClosed, ZeroAmount; one bid PDA per (launch, bidder)"],
          [<C key="i">reveal_bid</C>, "RevealWindowNotOpen, RevealWindowClosed, AlreadyRevealed, CommitmentMismatch, InvalidTick, BidExceedsDeposit"],
          [<C key="i">clear_auction</C>, "InvalidStatus, AuctionNotEnded"],
          [<C key="i">graduate_and_open_credit</C>, "AuctionNotCleared, AlreadyGraduated"],
          [<C key="i">execute_buyback_drip</C>, "NotLive, DripNotDue, VaultEmpty"],
          [<C key="i">swap</C>, "NotLive, SlippageExceeded, ZeroAmount"],
          [<C key="i">stake / claim_rewards</C>, "SniperIneligible, InsufficientStake (unstake)"],
        ]}
      />

      <H2 id="status" n="8.2">Launch status</H2>
      <Table
        dense
        head={["u8", "On-chain", "API status"]}
        rows={(Object.entries(ONCHAIN_STATUS) as Array<[string, number]>).map(([k, v]) => [
          <N key="v">{v}</N>,
          <C key="k">{k}</C>,
          { Open: "commit → reveal → clearing (by timestamp)", Cleared: "clearing", Failed: "failed", Live: "live", Flywheel: "flywheel" }[k] ?? "",
        ])}
      />

      <H2 id="accounts" n="8.3">Accounts</H2>
      {(Object.keys(ACCOUNTS) as Array<keyof typeof ACCOUNTS>).map((k) => (
        <div key={k}>
          <H3 id={`acc-${k}`}>{k}</H3>
          <p className="mt-3 font-mono text-[12.5px] leading-[1.8] text-ink-soft [overflow-wrap:anywhere]">{ACCOUNTS[k].join(" · ")}</p>
        </div>
      ))}
      <P>
        Program-only fields appended after the contract list: <C>LaunchAccount</C> also stores <C>auction_supply_bps</C>, <C>creator_allocation_bps</C>,{" "}
        <C>pool_quote_seeded</C>, <C>name</C>, <C>ticker</C>, <C>uri</C>; <C>HolderPosition</C> adds <C>unclaimed</C>. <C>AntiSnipeEntry</C> is created by hand inside{" "}
        <C>swap</C> and is not in the IDL accounts list.
      </P>

      <H2 id="pdas" n="8.4">PDAs and seeds</H2>
      <Table
        dense
        head={["Account", "Seeds"]}
        rows={[
          ...(Object.keys(SEEDS) as Array<keyof typeof SEEDS>).map((k) => [
            k,
            <span key="s" className="font-mono text-[12px]">
              &quot;{SEEDS[k]}&quot;{SEED_SUFFIX[k] !== "—" ? `, ${SEED_SUFFIX[k]}` : ""}
            </span>,
          ]),
          ["creditVault (program-only)", <span key="s" className="font-mono text-[12px]">&quot;credit_vault&quot;, quote_mint</span>],
          ["stakeVault (program-only)", <span key="s" className="font-mono text-[12px]">&quot;stake_vault&quot;, launch</span>],
        ]}
        caption="SEEDS in constants.ts, byte-identical to constants.rs. Derive them with pdas.* from @sealed/shared."
      />

      <H2 id="events" n="8.5">Events</H2>
      <Table dense head={["Event", "Fields"]} rows={EVENTS.map(([n, f]) => [<C key="n">{n}</C>, <span key="f" className="font-mono text-[12px]">{f}</span>])} />

      <H2 id="errors" n="8.6">Errors</H2>
      <Table
        dense
        head={["Code", "Name"]}
        rows={[...PROGRAM_ERRORS, ...EXTRA_ERRORS].map((n, i) => [<N key="c">{6000 + i}</N>, <C key="n">{n}</C>])}
        caption="6000–6022 follow PROGRAM_ERRORS in program.ts; 6023–6027 are program-only."
      />

      <H2 id="tests" n="8.7">Tests</H2>
      <P>
        <C>programs/sealed-launchpad/tests/sealed-launchpad.ts</C> covers: the instruction list (no vault withdraw path), the 2% creator cap, commit and
        escrow, early and mismatched reveals, uniform clearing against shared <C>computeClearing</C>, winner/loser/non-revealer settlement, a graduation +
        same-slot buy in one transaction (sniper recorded), drip timing and burn, sniper staking rejection, forged-authority vault withdrawal, 80/20
        repayment flipping to Flywheel at zero, staker rewards with zero accrual for the sniper, unstake, and a failed auction with full refunds.{" "}
        <C>math.rs</C> has 14 Rust unit tests. None has been run in this workspace yet: run <C>pnpm anchor:test</C>.
      </P>
    </>
  );
}
