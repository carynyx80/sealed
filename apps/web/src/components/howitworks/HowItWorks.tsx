import Link from "next/link";
import type { ReactNode } from "react";
import { FadeIn } from "@/components/motion/FadeIn";
import { ArrowRight } from "@/components/ui/Icons";
import { EXAMPLE, FACTS, fmtNum, fmtPrice } from "./facts";
import {
  AntiSnipeFigure,
  ClaimFigure,
  ClearingFigure,
  DepositFigure,
  FeesFigure,
  LoopFigure,
  RevealFigure,
  SealFigure,
  SignFigure,
  VaultFigure,
  WithdrawFigure,
} from "./Illustrations";
import { StepIndex } from "./StepIndex";
import { StepSection, type StepProps } from "./StepSection";

const A = ({ children }: { children: ReactNode }) => <span className="accent">{children}</span>;
const pc = (bps: number) => `${bps / 100}%`;

const winC = EXAMPLE.bids.find((b) => b.maxPrice === EXAMPLE.price)!;
const top = EXAMPLE.bids[0]!;
const lose = EXAMPLE.bids.find((b) => !b.won)!;

function WorkedExample() {
  return (
    <div className="mt-6 overflow-hidden rounded-card border border-rule bg-sheet">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule px-4 py-3 sm:px-6">
        <span className="eyebrow">Worked example</span>
        <span className="num text-[12px] text-ink-slate">
          {fmtNum(EXAMPLE.forSale)} tokens for sale · floor {fmtPrice(EXAMPLE.floor)} USDC
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[320px] text-left text-[13px]">
          <thead>
            <tr className="border-b border-rule font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-muted">
              <th scope="col" className="px-4 py-2 font-normal sm:px-6">Bid</th>
              <th scope="col" className="px-2 py-2 text-right font-normal">Max price</th>
              <th scope="col" className="px-2 py-2 text-right font-normal">Amount</th>
              <th scope="col" className="px-4 py-2 text-right font-normal sm:px-6">Result</th>
            </tr>
          </thead>
          <tbody className="num">
            {EXAMPLE.bids.map((b) => (
              <tr key={b.who} className="border-b border-rule last:border-b-0">
                <td className="px-4 py-2.5 text-ink sm:px-6">{b.who}</td>
                <td className="px-2 py-2.5 text-right text-ink">{fmtPrice(b.maxPrice)}</td>
                <td className="px-2 py-2.5 text-right text-ink">{fmtNum(b.amount)}</td>
                <td className={`px-4 py-2.5 text-right sm:px-6 ${b.won ? "text-ink" : "text-ink-muted"}`}>
                  {b.won ? `${fmtNum(b.tokens)} tokens` : `refund ${fmtNum(b.refund)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-rule px-4 py-3 text-[13px] leading-relaxed text-ink-slate sm:px-6">
        Bids A, B and C offer {fmtNum(EXAMPLE.raised)} USDC together, exactly enough for every token at{" "}
        <span className="num text-ink">{fmtPrice(EXAMPLE.price)}</span>. So that is the price. A was willing to pay {fmtPrice(top.maxPrice)} but pays{" "}
        {fmtPrice(EXAMPLE.price)}, so A&apos;s {fmtNum(top.amount)} USDC buys {fmtNum(top.tokens)} tokens. Computed with the same clearing code the auction uses.
      </p>
    </div>
  );
}

const STEPS: StepProps[] = [
  {
    id: "sign-in",
    n: "01",
    label: "Connect and sign in",
    title: (
      <>
        Connect your wallet and <A>sign</A> once.
      </>
    ),
    children: (
      <>
        <p>Pick Phantom, Solflare or any Solana wallet. Sealed asks you to sign a short text message that proves the wallet is yours.</p>
        <p>Signing is free. It is not a transaction: nothing moves and there is no network fee.</p>
      </>
    ),
    facts: [
      ["Network fee", "0 SOL"],
      ["Transaction", "None"],
      ["What you sign", "A plain text message"],
    ],
    figure: <SignFigure />,
    caption: "Signing a message proves you own the wallet. It cannot spend anything.",
  },
  {
    id: "deposit",
    n: "02",
    label: "Deposit",
    title: (
      <>
        Fund your Sealed <A>balance.</A>
      </>
    ),
    children: (
      <>
        <p>
          To bid, move {FACTS.assetsLabel} into your Sealed balance. You send a normal transfer to the Sealed company wallet with your personal memo attached, so we know it
          is yours. Once Solana marks the transfer as final, the amount appears in your balance.
        </p>
        <p className="rounded-card border border-rule bg-paper-deep px-4 py-3 text-[14px] text-ink-soft">
          <strong className="font-semibold text-ink">In plain words:</strong> Sealed is custodial. While money sits in your Sealed balance, it is held in the company wallet
          and tracked in our ledger, not in your own wallet. Only deposit what you are comfortable trusting us with.
        </p>
      </>
    ),
    facts: [
      ["Assets", FACTS.assets.join(", ")],
      ["Send to", <span key="w" title={FACTS.companyWallet}>{FACTS.companyWalletShort}</span>],
      ["Memo", "sealed:your code"],
      ["Credited", "After finality"],
    ],
    figure: <DepositFigure />,
    caption: "Your memo links the transfer to your account. Without it, a deposit cannot be matched automatically.",
    flip: true,
  },
  {
    id: "bid",
    n: "03",
    label: "Sealed bid",
    title: (
      <>
        Place a bid nobody can <A>see.</A>
      </>
    ),
    children: (
      <>
        <p>Choose the highest price you would pay per token and how much you want to spend.</p>
        <p>
          The app mixes those two numbers with a random secret into a fingerprint: a one-way code, also called a commitment. Only the fingerprint is stored. Other bidders
          and the public cannot see your price or your size. The amount is locked from your balance until the auction clears.
        </p>
      </>
    ),
    facts: [
      ["Bidding window", `${FACTS.commitMin} to ${FACTS.commitMax} min`],
      ["What is stored", "A fingerprint only"],
      ["Your amount", "Locked until clearing"],
    ],
    figure: <SealFigure />,
    caption: "Every bid looks the same from outside. Nobody can copy a big bidder or price just above them.",
  },
  {
    id: "reveal",
    n: "04",
    label: "Reveal",
    title: (
      <>
        Open your bid when the window <A>opens.</A>
      </>
    ),
    children: (
      <>
        <p>When bidding closes, a short reveal window begins. Revealing shows your real price and amount so they can be counted.</p>
        <p>
          With auto-reveal on, Sealed does this for you the moment the window opens. Prefer to do it yourself? Come back during the window and press Reveal.
        </p>
      </>
    ),
    facts: [
      ["Reveal window", `${FACTS.revealMin} min`],
      ["Auto-reveal", "On by default"],
      ["Missed reveal", `${FACTS.noRevealSlash} kept, rest returned`],
    ],
    figure: <RevealFigure />,
    caption: "The fingerprint proves your revealed numbers are the ones you sealed. They cannot be changed after the fact.",
    flip: true,
  },
  {
    id: "clearing",
    n: "05",
    label: "One clearing price",
    title: (
      <>
        Everyone who wins pays <A>one</A> price.
      </>
    ),
    children: (
      <>
        <p>
          Revealed bids are sorted from the highest price down. Sealed walks down the list until the bids above a price can buy every token for sale. That is the clearing
          price.
        </p>
        <p>Everyone at or above it wins and pays exactly that price, even if they offered more. Bids below it are refunded in full.</p>
      </>
    ),
    facts: [
      ["Price for winners", "The same for all"],
      ["Bid higher?", "You still pay the clearing price"],
      ["Tie at the price", "Shared in proportion"],
    ],
    figure: <ClearingFigure />,
    caption: `Real numbers from the worked example below: the line settles at ${fmtPrice(EXAMPLE.price)} USDC.`,
    extra: <WorkedExample />,
  },
  {
    id: "claim",
    n: "06",
    label: "Claim and refund",
    title: (
      <>
        Claim your tokens, keep the <A>change.</A>
      </>
    ),
    children: (
      <>
        <p>After clearing, press Claim. Winning amounts turn into tokens at the clearing price and land in your Sealed balance.</p>
        <p>Anything you did not spend, including a whole bid that came in below the price, goes straight back to your balance too.</p>
      </>
    ),
    facts: [
      ["Tokens", "Amount spent ÷ clearing price"],
      ["Refund", "Deposit minus amount spent"],
      ["Where", "Your Sealed balance"],
    ],
    figure: <ClaimFigure />,
    caption: `From the example: bid ${winC.who} receives ${fmtNum(winC.tokens)} tokens, bid ${lose.who} gets its ${fmtNum(lose.refund)} USDC back.`,
    flip: true,
  },
  {
    id: "vault",
    n: "07",
    label: "Day-one buyback vault",
    night: true,
    title: (
      <>
        A buyback vault from day <A>one.</A>
      </>
    ),
    children: (
      <>
        <p>
          When a launch starts trading, Sealed advances a credit line worth {FACTS.creditMin} to {FACTS.creditMax} of the raise into a locked vault.
        </p>
        <p>
          Every {FACTS.dripEvery} minutes the vault drips a small slice into the market, buys the token and burns it, which removes it from circulation for good. The vault
          has no withdraw button for anyone. It can only buy and burn.
        </p>
      </>
    ),
    facts: [
      ["Vault size", `${FACTS.creditMin} to ${FACTS.creditMax} of raise`],
      ["One drip every", `${FACTS.dripEvery} min`],
      ["Number of drips", `${FACTS.dripCount}, about ${FACTS.dripHours} h`],
      ["Withdrawals", "None"],
    ],
    figure: <VaultFigure />,
    caption: "Steady buying from the first trade, instead of a promise to buy back later.",
  },
  {
    id: "fees",
    n: "08",
    label: "Fees and flywheel",
    title: (
      <>
        Fees repay the credit, then feed the <A>flywheel.</A>
      </>
    ),
    children: (
      <>
        <p>
          Every trade in the launch pool pays a {FACTS.poolFee} fee. Until the credit is paid back, {pc(FACTS.repayBps)} of fees repay it and {pc(FACTS.opsBps)} cover
          platform operations.
        </p>
        <p>
          Once it is fully repaid, the split changes for good: {pc(FACTS.holdersBps)} to holders who stake, {pc(FACTS.burnBps)} to buyback and burn, {pc(FACTS.treasuryBps)}{" "}
          to the treasury.
        </p>
      </>
    ),
    facts: [
      ["Pool fee", FACTS.poolFee],
      ["Until repaid", `${FACTS.repayBps / 100} / ${FACTS.opsBps / 100}`],
      ["After repaid", `${FACTS.holdersBps / 100} / ${FACTS.burnBps / 100} / ${FACTS.treasuryBps / 100}`],
      ["Holder rewards", "To staked tokens"],
    ],
    figure: <FeesFigure />,
    caption: "Bars are drawn to scale from the protocol settings.",
    flip: true,
  },
  {
    id: "anti-snipe",
    n: "09",
    label: "Anti-snipe",
    title: (
      <>
        Snipers get <A>nothing</A> extra.
      </>
    ),
    children: (
      <>
        <p>Bots like to buy in the very first instant a token starts trading.</p>
        <p>
          On Sealed, any buy in the first {FACTS.antiSnipeSec} seconds after trading opens is flagged. Those wallets can still trade, but they never earn holder rewards for
          that launch.
        </p>
      </>
    ),
    facts: [
      ["Window", `First ${FACTS.antiSnipeSec} s`],
      ["Holder rewards", "0% for flagged wallets"],
      ["Trading", "Still allowed"],
    ],
    figure: <AntiSnipeFigure />,
    caption: "Rewards go to people who buy and hold, not to whoever is fastest at the start.",
  },
  {
    id: "withdraw",
    n: "10",
    label: "Withdraw",
    title: (
      <>
        Take it back to your <A>wallet.</A>
      </>
    ),
    children: (
      <>
        <p>
          Withdraw {FACTS.assetsLabel} from your Sealed balance to your wallet. Amounts up to {FACTS.autoWithdrawMax} are sent automatically. Larger ones wait for a manual
          approval by the team. That is a safety check, not a fee.
        </p>
        <p>
          Proof of reserves, on your account page, compares what the company wallet holds on chain with what Sealed owes users.
        </p>
      </>
    ),
    facts: [
      ["Automatic", `Up to ${FACTS.autoWithdrawMax}`],
      ["Daily per wallet", `${FACTS.dailyWithdrawMax}, then review`],
      ["Sealed fee", "None"],
      ["Proof of reserves", "On chain vs owed"],
    ],
    figure: <WithdrawFigure />,
    caption: "Limits are in US dollar value at the current price.",
    flip: true,
  },
];

const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: "Is my bid really private?",
    a: (
      <>
        Until the reveal window, other bidders and the public only see a fingerprint, and it cannot be turned back into your price or amount. One honest caveat: Sealed
        runs the auction on its own servers, and with auto-reveal on you give Sealed a sealed copy of your bid so it can reveal on time. If you would rather nobody holds
        it, switch auto-reveal off and reveal yourself.
      </>
    ),
  },
  {
    q: "Who holds my funds?",
    a: (
      <>
        Sealed does. Deposits go to the company wallet <span className="num break-all text-ink">{FACTS.companyWallet}</span> and your balance is tracked in our ledger.
        That is what custodial means. Proof of reserves on your account page shows what the wallet holds against what is owed to users.
      </>
    ),
  },
  {
    q: "What does it cost?",
    a: (
      <>
        Signing in is free. A deposit costs the normal Solana network fee from your wallet. Bidding, revealing and claiming cost nothing. Trades in a launch pool pay a{" "}
        {FACTS.poolFee} fee, which repays the buyback credit and then funds holders. Withdrawals carry no Sealed fee. The only penalty is {FACTS.noRevealSlash} of a bid
        that is never revealed.
      </>
    ),
  },
  {
    q: "What if I don't reveal?",
    a: (
      <>
        Auto-reveal is on by default, so Sealed reveals for you. If you turned it off and miss the {FACTS.revealMin} minute window, your bid is not counted and{" "}
        {FACTS.noRevealSlash} of its deposit is kept. The rest returns to your balance.
      </>
    ),
  },
  {
    q: "Can the creator dump on buyers?",
    a: (
      <>
        A creator can receive at most {FACTS.creatorMax} of supply, and that cap is enforced. They cannot mint more tokens or touch the money raised or the vault. They can
        sell their own share like anyone else, so check the creator share on each launch before you bid.
      </>
    ),
  },
  {
    q: "Can the buyback vault be withdrawn?",
    a: <>No. The vault has no withdraw action for anyone. Its only move is to buy the token and burn it, one drip every {FACTS.dripEvery} minutes until it is empty.</>,
  },
  {
    q: "Which assets are supported?",
    a: (
      <>
        {FACTS.assets.join(" and ")} on Solana mainnet. Tokenized stocks such as {FACTS.comingSoon.slice(0, 3).join(", ")} are coming soon. They use a newer token standard
        that our custody does not support yet, so they stay switched off until it does.
      </>
    ),
  },
  {
    q: "Is it audited?",
    a: (
      <>
        No. There is no external audit and no insurance yet. The auction math is open and tested, and the{" "}
        <Link href="/docs/security" className="text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink">
          security notes
        </Link>{" "}
        list the known limits. Only deposit what you can afford to lose.
      </>
    ),
  },
];

export function HowItWorks() {
  const index = STEPS.map((s) => ({ id: s.id, n: s.n, label: s.label }));
  return (
    <>
      {/* hero */}
      <section className="pb-12 pt-6 sm:pb-16 sm:pt-8" aria-labelledby="hiw-title">
        <div className="flex items-center justify-between gap-4 border-b border-ink pb-2.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-slate">
          <span>§ 00 · How it works</span>
          <span className="hidden sm:inline">Solana mainnet · 10 steps</span>
          <span className="sm:hidden">10 steps</span>
        </div>
        <div className="mt-10 grid items-center gap-12 sm:mt-14 lg:grid-cols-12 lg:gap-8">
          <div className="lg:col-span-6">
            <h1 id="hiw-title" className="font-display text-[clamp(2.75rem,6.4vw,5.75rem)] font-bold leading-[0.92] tracking-[-0.05em] text-ink">
              From your first bid to the first <span className="accent tracking-[-0.03em]">burn.</span>
            </h1>
            <p className="mt-8 max-w-[34rem] text-[17px] leading-relaxed text-ink-slate">
              Sealed is a token launchpad on Solana where bids stay private until the auction closes, every winner pays the same price, and a locked vault starts buying back
              and burning the token from the first minute of trading.
            </p>
            <dl className="mt-10 grid max-w-xl grid-cols-1 border-t border-rule sm:grid-cols-3">
              {[
                ["Bids", "Sealed until reveal"],
                ["Price", "One for every winner"],
                ["Vault", `${FACTS.creditMin} to ${FACTS.creditMax} of raise`],
              ].map(([k, v], i) => (
                <div key={k} className={`border-b border-rule py-3.5 sm:border-b-0 ${i > 0 ? "sm:border-l sm:pl-5" : ""} ${i < 2 ? "sm:pr-5" : ""}`}>
                  <dt className="eyebrow">{k}</dt>
                  <dd className="mt-1.5 text-sm text-ink">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-6 max-w-[34rem] text-[13px] leading-relaxed text-ink-muted">
              Custodial service: deposits are held in the Sealed company wallet while you use the app. Step 02 explains what that means.
            </p>
          </div>
          <FadeIn className="mx-auto w-full max-w-[560px] lg:col-span-6 lg:max-w-none">
            <LoopFigure stepIds={index.map((i) => i.id)} />
          </FadeIn>
        </div>
      </section>

      {/* steps */}
      <div className="xl:grid xl:grid-cols-12 xl:gap-10">
        <aside className="hidden xl:col-span-2 xl:block">
          <StepIndex items={index} />
        </aside>
        <div className="xl:col-span-10">
          {STEPS.map((s) => (
            <StepSection key={s.id} {...s} />
          ))}

          {/* FAQ */}
          <section id="faq" aria-labelledby="faq-title" className="scroll-mt-2 border-t border-ink py-14 sm:py-20">
            <div className="grid gap-10 lg:grid-cols-12">
              <div className="lg:col-span-4">
                <p className="section-mark uppercase">§ 11 · Questions</p>
                <h2 id="faq-title" className="mt-6 text-display-md text-ink">
                  Straight <A>answers.</A>
                </h2>
                <p className="mt-5 max-w-sm text-[15px] leading-relaxed text-ink-slate">The things people ask before their first bid, including the uncomfortable ones.</p>
              </div>
              <div className="lg:col-span-8">
                <ul className="border-t border-ink">
                  {FAQ.map((f, i) => (
                    <li key={f.q} className="border-b border-rule">
                      <details className="group py-1" open={i === 0}>
                        <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-6 py-3 text-[17px] font-semibold tracking-[-0.01em] text-ink [&::-webkit-details-marker]:hidden">
                          <span className="flex items-baseline gap-4">
                            <span className="num text-[11px] font-normal text-ink-muted">{String(i + 1).padStart(2, "0")}</span>
                            {f.q}
                          </span>
                          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden className="shrink-0 text-ink transition-transform group-open:rotate-45">
                            <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.25" fill="none" />
                          </svg>
                        </summary>
                        <p className="max-w-2xl pb-5 pl-[1.9rem] text-[15px] leading-relaxed text-ink-slate">{f.a}</p>
                      </details>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* CTA band */}
      <section aria-labelledby="hiw-cta" className="bleed bg-night text-night-text">
        <div className="shell py-16 sm:py-24">
          <div className="flex items-center justify-between gap-4 border-b border-night-rule pb-3 font-mono text-[10.5px] uppercase tracking-[0.08em] text-night-muted">
            <span>§ 12 · Next</span>
            <span>Solana mainnet</span>
          </div>
          <div className="mt-10 grid gap-10 lg:grid-cols-12 lg:items-end">
            <h2 id="hiw-cta" className="text-display-lg text-night-text lg:col-span-7">
              Seen enough? The lobby is <A>open.</A>
            </h2>
            <div className="flex flex-wrap items-center gap-x-7 gap-y-4 lg:col-span-5 lg:justify-end">
              <Link href="/" className="inline-flex h-12 items-center gap-2 rounded-full bg-night-text px-6 text-sm font-semibold text-night transition hover:-translate-y-px hover:bg-white">
                Enter the lobby <ArrowRight width={15} height={15} />
              </Link>
              <Link
                href="/docs"
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-night-text underline decoration-night-muted decoration-1 underline-offset-[6px] transition hover:decoration-night-text"
              >
                Read the docs
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
