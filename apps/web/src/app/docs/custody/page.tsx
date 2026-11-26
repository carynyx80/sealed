import type { Metadata } from "next";
import { COMPANY_WALLET, DEPOSIT_MEMO_PREFIX, SIWS_STATEMENT, WITHDRAWAL_LIMITS } from "@sealed/shared";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { Sequence } from "@/components/docs/Diagrams";
import { A, Accent, C, DocHeader, Figure, Figures, H2, H3, Ledger, N, Note, OL, P, StatusBadge, Table, UL } from "@/components/docs/Prose";

export const metadata: Metadata = { title: "Custody" };

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

export default function Custody() {
  return (
    <>
      <DocHeader
        n="02"
        kicker="Custody"
        title={
          <>
            Offchain and <Accent>custodial</Accent>, by default.
          </>
        }
        lede="In the default execution mode Sealed holds your deposits in a company wallet and tracks what you own in a double-entry ledger. This page explains exactly how money gets in, how it gets out, and what you are trusting."
      >
        <StatusBadge status="offchain-passing" label="Ledger + SIWS · tests passing" />
        <StatusBadge status="dev" label="Payouts pending operator key" />
        <StatusBadge status="dev" label="Deposit detection pending HELIUS_API_KEY" />
      </DocHeader>

      <Note title="Status on the hosted API" tone="signal">
        <p>
          The custody code is built and its tests pass (API suite 87/87), and it is deployed on Railway with Postgres and Redis. Two operator secrets are
          not set yet: <C>COMPANY_WALLET_SECRET_KEY</C>, without which <C>payoutsEnabled</C> is false and no withdrawal is ever sent, and{" "}
          <C>HELIUS_API_KEY</C> (or <C>SOLANA_RPC_URL</C>), without which deposits are not detected and <C>POST /api/account/deposits</C> answers 503. The
          hosted API also runs with <C>DEMO_MODE=true</C>, which keeps the deposit watcher and payout worker off unless <C>CUSTODY_WORKERS=true</C> is set.
          Do not send real funds until <C>/api/custody/info</C> shows <C>payoutsEnabled: true</C>.
        </p>
      </Note>

      <Note title="Custody disclosure" tone="warn">
        <p>
          When you deposit, the funds leave your wallet and sit in the company wallet <C>{COMPANY_WALLET}</C>. Your balance is an entry in Sealed&apos;s
          ledger, not an on-chain token account you control. The operator can pause, delay or refuse withdrawals, and a compromised operator key could
          lose funds. There is no insurance and no audit. Deposit only what you can afford to lose. The non-custodial alternative is the{" "}
          <A href="/docs/program">onchain mode</A>, which is on the roadmap and not deployed.
        </p>
      </Note>

      <H2 id="model" n="2.1">The model in one paragraph</H2>
      <P>
        The backend runs auctions, clearing, the graduation pool, buyback drips, fee splits and holder rewards as postings in a Postgres double-entry
        ledger. Every posting debits one account and credits another, so the books always sum to zero. Real assets live in one place: the company
        wallet. Proof of reserves compares that wallet&apos;s on-chain balances with the sum of user liabilities in the ledger, live. The contract for all of
        this is <C>packages/shared/src/custody.ts</C>; the server code is in <C>apps/api/src/offchain/</C> (ledger, engine, auth, custody) and{" "}
        <C>apps/api/src/routes/</C> (<C>auth</C>, <C>account</C>, <C>trade</C>, <C>custody</C>, <C>admin</C>).
      </P>
      <Figures
        items={[
          { value: usd(WITHDRAWAL_LIMITS.autoApproveMaxUsd), label: "auto-approved withdrawal ceiling (USD-equivalent)" },
          { value: usd(WITHDRAWAL_LIMITS.dailyPerWalletUsd), label: "daily withdrawal limit per wallet" },
          { value: "1", label: "company wallet holding every deposit" },
          { value: "0", label: "on-chain transactions needed to bid or trade" },
        ]}
      />

      <H2 id="signin" n="2.2">Sign in with Solana</H2>
      <P>
        There are no passwords. You prove you own a wallet by signing a message; the signature costs nothing and sends no transaction.
      </P>
      <OL>
        <li>
          <C>POST /api/auth/nonce</C> with <C>{"{ wallet }"}</C> returns a nonce, the exact message to sign and an expiry.
        </li>
        <li>Your wallet signs the message (ed25519). The statement reads: &ldquo;{SIWS_STATEMENT}&rdquo;</li>
        <li>
          <C>POST /api/auth/verify</C> with the wallet, nonce and base58 signature returns a session token. Send it as{" "}
          <C>Authorization: Bearer &lt;token&gt;</C> on every account and trade call.
        </li>
      </OL>
      <P>
        Nonces expire after 5 minutes and are single-use. Sessions last 7 days; the server stores only a SHA-256 hash of the token.{" "}
        <C>GET /api/auth/session</C> returns <C>{'{ wallet }'}</C> for a valid token and <C>POST /api/auth/logout</C> revokes it. The nonce and verify
        calls are rate-limited per IP and per wallet (429).
      </P>

      <H2 id="deposits" n="2.3">Deposits</H2>
      <P>
        Each user has a stable deposit reference. A deposit is an ordinary on-chain transfer of SOL or an SPL token to the company wallet that carries
        the memo <C>{DEPOSIT_MEMO_PREFIX}&lt;depositRef&gt;</C>. The backend watches the wallet through Helius RPC, matches the memo, waits for the
        configured confirmations (<C>DEPOSIT_CONFIRMATIONS</C>, finalized commitment) and then credits your available balance.
      </P>
      <Figure caption="Deposit flow. If detection is slow you can nudge it by posting the transaction signature to /api/account/deposits (202 if not final yet, 404 if the transaction holds no deposit for your memo).">
        <Sequence
          lanes={["You", "Solana", "Sealed API", "Ledger"]}
          steps={[
            { from: 0, to: 2, label: "GET /api/account/deposit/USDC", note: "company wallet, memo, mint" },
            { from: 0, to: 1, label: "transfer to company wallet with memo sealed:<ref>" },
            { from: 2, to: 1, label: "Helius RPC: new signatures on the company wallet" },
            { from: 2, to: 2, label: "status detected → confirmed after finality" },
            { from: 2, to: 3, label: "credit available balance", note: "status credited" },
          ]}
        />
      </Figure>
      <Table
        head={["Deposit status", "Meaning"]}
        rows={[
          [<C key="s">detected</C>, "Transfer seen with a valid memo; not yet final."],
          [<C key="s">confirmed</C>, "Reached the required confirmations."],
          [<C key="s">credited</C>, "Posted to your ledger balance; spendable."],
          [<C key="s">rejected</C>, "Unknown memo, unsupported asset or failed transfer. The reason field says which."],
        ]}
      />
      <Note title="Get the memo right" tone="warn">
        <p>
          A transfer without the <C>{DEPOSIT_MEMO_PREFIX}</C> memo cannot be matched to you automatically. Mainnet tokenized-stock mints are unset in the
          quote-asset registry until the operator verifies them, so stock deposits are only accepted where a mint is configured.
        </p>
      </Note>

      <H2 id="trading" n="2.4">Bidding and trading against your balance</H2>
      <P>
        Once credited, a balance moves only by ledger postings. Committing a bid locks the deposit from your available quote balance; the commitment is
        the same keccak preimage as the onchain mode, with the bidder fixed to your signed-in wallet. Swaps, claims, staking and reward claims are API
        calls. Balances show <C>available</C> and <C>locked</C> (open bids and pending withdrawals).
      </P>
      <CodeBlock
        lang="http"
        title="Commit a sealed bid (offchain)"
        code={`POST /api/trade/commit
Authorization: Bearer <token>
Content-Type: application/json

{
  "launchId": "<launch id>",
  "commitment": "<64 hex: keccak256(wallet || u64le(maxPrice) || u64le(bidAmount) || salt)>",
  "deposit": 25,
  "sealedReveal": { "...": "optional SealedRevealEnvelope for auto-reveal" }
}

→ { "bidId": "...", "bidCount": 58 }`}
      />

      <H2 id="withdrawals" n="2.5">Withdrawals</H2>
      <P>
        <C>POST /api/account/withdrawals</C> with an asset, amount and destination (the client defaults it to your signed-in wallet). The amount is locked
        immediately. The payout worker then sends it from the company wallet.
      </P>
      <Ledger
        items={[
          { k: "Auto-approved", v: <>At or under <N>{usd(WITHDRAWAL_LIMITS.autoApproveMaxUsd)}</N> USD-equivalent and inside the <N>{usd(WITHDRAWAL_LIMITS.dailyPerWalletUsd)}</N> daily per-wallet limit.</> },
          { k: "Manual approval", v: <>Above either limit the request lands in <C>pending_approval</C>. An operator lists, approves (→ <C>queued</C>) or rejects it on <C>/api/admin/withdrawals</C> with the <C>x-admin-token</C> header (value <C>ADMIN_TOKEN</C>).</> },
          { k: "Payouts disabled", v: <>Until the operator sets <C>COMPANY_WALLET_SECRET_KEY</C> (and an RPC), <C>payoutsEnabled</C> is false and no payout worker runs: <C>queued</C> withdrawals wait, funds stay locked, and approving one only moves it to <C>queued</C>. Rejecting unlocks the funds.</> },
          { k: "USD valuation", v: "Limits use the reference prices in quoteAssets.ts, which are demo prices — a known simplification." },
        ]}
      />
      <Table
        head={["Withdrawal status", "Meaning"]}
        rows={[
          [<C key="s">queued</C>, "Accepted (auto-approved or operator-approved), waiting for the payout worker. Waits indefinitely while payouts are disabled."],
          [<C key="s">pending_approval</C>, "Over the auto-approve or daily limit; waiting for an operator."],
          [<C key="s">sending</C>, "Transaction built and submitted from the company wallet."],
          [<C key="s">sent</C>, "Confirmed on-chain; signature attached."],
          [<C key="s">failed</C>, "Submission failed; funds are unlocked back to available."],
          [<C key="s">rejected</C>, "Declined by an operator; reason attached."],
        ]}
      />

      <H2 id="por" n="2.6">Proof of reserves</H2>
      <P>
        <C>GET /api/custody/info</C> (no auth) returns, per asset, the company wallet&apos;s on-chain balance, the ledger&apos;s total liabilities to users, their
        ratio and an as-of timestamp (cached for 30 s; without an RPC the on-chain side cannot be read). A ratio ≥ 1 means every user balance is covered by assets you can verify yourself on a block explorer.
      </P>
      <CodeBlock
        lang="json"
        title="GET /api/custody/info"
        code={`{
  "companyWallet": "${COMPANY_WALLET}",
  "network": "devnet",
  "mode": "offchain",
  "payoutsEnabled": false,
  "proofOfReserves": [
    { "asset": "SOL",  "onchain": 412.8, "liabilities": 398.1, "ratio": 1.037, "asOfTs": 1795692450 },
    { "asset": "USDC", "onchain": 50210, "liabilities": 49877, "ratio": 1.006, "asOfTs": 1795692450 }
  ]
}`}
      />
      <H3 id="por-limits">What proof of reserves does not prove</H3>
      <UL>
        <li>That the ledger is complete. Liabilities are the operator&apos;s own figure; a hidden liability would not appear.</li>
        <li>That the assets will still be there tomorrow. It is a snapshot, not a lock.</li>
        <li>That the key is safe. Reserves can be moved by whoever holds <C>COMPANY_WALLET_SECRET_KEY</C>.</li>
      </UL>

      <H2 id="risks" n="2.7">Risks, plainly</H2>
      <Table
        head={["Risk", "What could happen", "Mitigation today"]}
        rows={[
          ["Operator key compromise", "Company wallet drained", "Key held only as a Railway secret; small hot balance recommended; no multisig yet"],
          ["Operator insolvency or misconduct", "Withdrawals refused", "Live proof of reserves; double-entry ledger; no legal protection"],
          ["Ledger bug", "Wrong balances or fills", "Same property-tested shared math as the program; ledger must sum to zero"],
          ["Deposit mismatch", "Funds not credited", "Memo matching, signature nudge endpoint, manual review"],
          ["Withdrawal delay", "Funds held for manual approval", "Published limits; status visible per withdrawal"],
          ["Mode drift", "Offchain rules differ from the program", "Both use @sealed/shared math; anti-snipe uses a 2 s window instead of a slot"],
        ]}
      />
    </>
  );
}
