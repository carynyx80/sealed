/**
 * Mainnet copy shared by several docs pages: the real-funds custodial risk disclosure and the list of mainnet
 * changes that are rolling out. Numbers come from @sealed/shared so the docs never drift from the code.
 */
import {
  COMPANY_WALLET,
  MAX_COMMIT_DURATION_SEC,
  MIN_COMMIT_DURATION_SEC_MAINNET,
  STOCK_QUOTE_ASSETS,
  WITHDRAWAL_LIMITS,
} from "@sealed/shared";
import { A, C, Ledger, Note } from "./Prose";

/** Solana Explorer / Solscan links. Mainnet is the default cluster, so no `?cluster=` parameter. */
export const explorerAddress = (address: string) => `https://explorer.solana.com/address/${address}`;
export const solscanAddress = (address: string) => `https://solscan.io/account/${address}`;
export const COMPANY_WALLET_EXPLORER = explorerAddress(COMPANY_WALLET);

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
export const MAINNET_COMMIT_WINDOW = `${MIN_COMMIT_DURATION_SEC_MAINNET / 60} to ${MAX_COMMIT_DURATION_SEC / 60} min`;
export const STOCK_SYMBOLS = STOCK_QUOTE_ASSETS.map((q) => q.symbol).join(", ");

/** Prominent disclosure for real funds. Render near the top of any page that talks about depositing. */
export function RealFundsDisclosure() {
  return (
    <Note title="Real funds · custodial risk disclosure" tone="warn">
      <p>
        <strong>Sealed is custodial and runs on Solana mainnet with real funds.</strong> When you deposit, real SOL or USDC leaves your wallet and is
        held by the company in <A href={COMPANY_WALLET_EXPLORER}>{COMPANY_WALLET}</A>. What you own on Sealed is an entry in the company&apos;s ledger, not
        a token account you control.
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          <strong>The company holds your funds.</strong> The operator can pause, delay or refuse withdrawals, and anyone who obtains the company wallet
          key could move every deposit. There is no insurance, no deposit guarantee and no multisig yet.
        </li>
        <li>
          <strong>Withdrawals may need manual approval.</strong> Requests above {usd(WITHDRAWAL_LIMITS.autoApproveMaxUsd)} USD-equivalent, above{" "}
          {usd(WITHDRAWAL_LIMITS.dailyPerWalletUsd)} per wallet per day, or made while no fresh live price is available wait for an operator. Payouts
          also pause, with a stated reason, when the company wallet lacks SOL for network fees.
        </li>
        <li>
          <strong>Only SOL and USDC can be withdrawn.</strong> Tokens bought or won on Sealed exist only as Sealed ledger balances and cannot be withdrawn
          on-chain yet.
        </li>
        <li>
          <strong>Proof of reserves is a snapshot.</strong> <C>GET /api/custody/info</C> compares the company wallet&apos;s on-chain balances, which you can
          check on the Explorer, with ledger liabilities. It does not prove the ledger is complete or that the key is safe.
        </li>
        <li>
          <strong>Not audited.</strong> Neither the custodial backend nor the Anchor program has had a third-party audit, and the non-custodial program is
          not deployed.
        </li>
        <li>
          <strong>Your jurisdiction, your responsibility.</strong> Sealed is not a bank, broker or licensed custodian, and nothing here is investment
          advice. You are responsible for making sure that using Sealed, and the assets you trade on it, is lawful where you live, including securities,
          tax and sanctions rules. Do not use Sealed where it is prohibited.
        </li>
      </ul>
      <p>Deposit only what you can afford to lose.</p>
    </Note>
  );
}

/** The mainnet switch, item by item. Everything is labelled "rolling out" until it can be checked on the hosted API. */
export function MainnetRollout() {
  return (
    <Ledger
      items={[
        { k: "Network", s: "rolling", v: <>API <C>NETWORK=mainnet</C>, web <C>NEXT_PUBLIC_NETWORK=mainnet</C>. Confirm with <C>network</C> in <C>GET /api/health</C> and <C>GET /api/custody/info</C>.</> },
        { k: "Privacy Rings", s: "rolling", v: <>Helius Privacy Rings run in the API through the official <C>@heliuslabs/spr</C> SDK, behind <C>PRIVACY_RING_ENABLED</C> (on in production). Private deposits and withdrawals switch on once the company private address is registered.</> },
        { k: "Quote assets", s: "rolling", v: <>SOL and USDC are enabled. Tokenized stocks ({STOCK_SYMBOLS}) are <strong>coming soon</strong>: their mainnet mints are not verified yet, so they cannot be deposited or used as a quote asset.</> },
        { k: "Withdrawal limits", s: "rolling", v: <>USD limits use live prices from the Jupiter Price API. If no fresh price is available the withdrawal fails safe to <C>pending_approval</C> instead of being auto-approved.</> },
        { k: "Payout pause", s: "rolling", v: "When the company wallet does not hold enough SOL for transaction fees, payouts pause and report a reason; queued withdrawals wait with funds locked until it is topped up." },
        { k: "Browser RPC proxy", s: "rolling", v: <><C>POST /api/rpc</C> forwards allowlisted JSON-RPC methods for the web app, rate-limited per client. The RPC provider key stays on the server and is never sent to the browser.</> },
        { k: "Admin approvals", s: "rolling", v: <>Approving or rejecting withdrawals and seeding the credit pool require <C>ADMIN_TOKEN</C> (header <C>x-admin-token</C>); without it the admin routes refuse every request.</> },
        { k: "Auction timing", s: "rolling", v: <>Launches on mainnet require a {MAINNET_COMMIT_WINDOW} commit window, enforced by the API.</> },
        { k: "Launched tokens", s: "rolling", v: "Custodial Sealed ledger balances. Trade, stake and claim them on Sealed; on-chain withdrawal of launched tokens is not available yet. Only SOL and USDC withdraw." },
        { k: "Anchor program", s: "planned", v: "Roadmap only. Not deployed." },
      ]}
    />
  );
}
