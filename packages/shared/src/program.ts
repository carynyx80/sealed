/**
 * On-chain program interface contract (Anchor program `sealed_launchpad`).
 * The Rust program MUST expose exactly these instruction names (snake_case in Rust, camelCase in the IDL client)
 * with these args, and these account structs. Amounts are u64 atoms unless noted.
 *
 * Venue decision: graduation seeds an INTERNAL constant-product pool owned by the program (no LP tokens are
 * minted and there is no remove-liquidity instruction ⇒ liquidity is permanently locked). Routing all swaps
 * through `swap` is what makes fee routing to the Fee Collector PDA and same-slot anti-snipe detection
 * enforceable on-chain. A Raydium CPMM migration adapter lives off-chain in apps/web/src/lib/defi/raydium.ts.
 *
 * NON-WITHDRAWABLE VAULT: there is NO instruction that transfers from `buyback_vault` to an arbitrary wallet.
 * The only outflows are `execute_buyback_drip` (vault → pool quote reserve, tokens out → burned) — enforced by
 * PDA ownership + account constraints.
 */

export const INSTRUCTIONS = {
  /** admin, once. */
  initializeProtocol: {
    args: ["treasury: Pubkey", "platform_ops: Pubkey", "keeper: Pubkey", "is_mainnet: bool", "max_credit_per_launch: u64"],
  },
  /** anyone; deposits quote into the CreditPool for `quote_mint` (creates pool PDA if needed). */
  fundCreditPool: { args: ["amount: u64"] },
  /** creator; creates token mint (6 decimals, mint authority = mint_authority PDA), mints creator allocation (≤2%), records params. */
  createLaunch: {
    args: [
      "name: String", "ticker: String", "uri: String",
      "total_supply: u64 (token atoms)", "creator_allocation_bps: u16 (≤200)", "auction_supply_bps: u16 (2000..=6000)",
      "credit_bps: u16 (1000..=1500)",
      "commit_duration_sec: i64", "reveal_duration_sec: i64",
      "floor_price: u64", "tick_size: u64", "target_raise: u64", "clearing_cap: u64",
      "drip_interval_sec: i64 (120..=300)", "drip_count: u16",
    ],
  },
  /** bidder; transfers `deposit` quote into escrow PDA and stores commitment. One bid per bidder per launch. Commit window only. */
  commitBid: { args: ["commitment: [u8;32]", "deposit: u64"] },
  /** ANYONE (bidder or relayer) during reveal window; verifies keccak preimage, tick validity, bid_amount ≤ deposit; adds to histogram. */
  revealBid: { args: ["max_price: u64", "bid_amount: u64", "salt: [u8;32]"] },
  /** permissionless after reveal_end; computes uniform clearing price from histogram (clearing.ts algorithm). Sets status Cleared or Failed. */
  clearAuction: { args: [] },
  /** bidder; after clear. Winner receives tokens (+ optional auto-stake), refund = deposit − spent. Unrevealed: refund deposit − 1% slash. Failed: full refund. Closes bid account. */
  claimOrRefund: { args: ["stake: bool"] },
  /** permissionless after clear; seeds internal pool with total_raised quote + pool token allocation, advances credit (raise*credit_bps, capped) from CreditPool → buyback_vault, sets graduation_slot/ts, first next_drip_ts = now + drip_interval. */
  graduateAndOpenCredit: { args: [] },
  /** anyone; CPMM swap with POOL_FEE_BPS fee (in quote) sent to fee_collector. If buy && slot == graduation_slot ⇒ init AntiSnipeEntry for signer. */
  swap: { args: ["amount_in: u64", "min_amount_out: u64", "is_buy: bool"] },
  /** permissionless (keeper incentivised) when now ≥ next_drip_ts: swaps drip quote from vault through pool (no fee), burns tokens out. */
  executeBuybackDrip: { args: [] },
  /** permissionless; splits fee_collector balance per fees.ts splitFees (repay → CreditPool, ops → platform_ops ATA, holders → rewards_vault & reward_per_share, platform burn → platform_ops, treasury → treasury ATA). Flips to Flywheel when outstanding hits 0. */
  distributeFees: { args: [] },
  /** holder; stake launch tokens into HolderPosition (rejected for AntiSnipeEntry wallets via `anti_snipe` account check). */
  stake: { args: ["amount: u64"] },
  unstake: { args: ["amount: u64"] },
  /** holder; claims accrued quote rewards from rewards_vault. Snipers have 0 accrual. */
  claimRewards: { args: [] },
} as const;

export type InstructionName = keyof typeof INSTRUCTIONS;

/** On-chain enum LaunchStatus (u8). Maps to API LaunchStatus: Commit/Reveal are time-derived from Open. */
export const ONCHAIN_STATUS = { Open: 0, Cleared: 1, Failed: 2, Live: 3, Flywheel: 4 } as const;

export const ACCOUNTS = {
  ProtocolConfig: ["admin", "treasury", "platform_ops", "keeper", "is_mainnet", "max_credit_per_launch", "launch_count", "snipers_blocked", "bump"],
  CreditPool: ["quote_mint", "total_deposited", "outstanding", "total_advanced", "total_repaid", "vault (token acct PDA)", "bump"],
  LaunchAccount: [
    "creator", "token_mint", "quote_mint", "status", "total_supply", "creator_allocation", "tokens_for_sale", "pool_token_allocation",
    "credit_bps", "commit_start_ts", "commit_end_ts", "reveal_end_ts", "floor_price", "tick_size", "target_raise", "clearing_cap",
    "bid_count", "revealed_count", "total_escrowed", "histogram: [u64; 64]",
    "clearing_price", "marginal_tick: i16", "fill_rule: u8", "fill_num: u64", "fill_den: u64", "total_raised", "tokens_sold",
    "graduation_slot", "graduated_ts", "credit_line", "credit_outstanding", "drip_interval_sec", "drip_count", "drips_executed",
    "next_drip_ts", "vault_initial", "tokens_burned", "fees_collected", "reward_per_share: u128 (scaled 1e12)", "total_staked", "bump",
  ],
  SealedBid: ["launch", "bidder", "commitment: [u8;32]", "deposit", "revealed", "max_price", "bid_amount", "tick: u8", "claimed", "bump"],
  Pool: ["launch", "quote_reserve", "token_reserve", "bump"],
  AntiSnipeEntry: ["launch", "wallet", "slot", "bump"],
  HolderPosition: ["launch", "owner", "staked", "reward_debt: u128", "claimed", "bump"],
} as const;

/** Anchor error names the clients rely on for UX messaging. */
export const PROGRAM_ERRORS = [
  "CreatorAllocationTooHigh", "InvalidAuctionSupply", "InvalidCreditBps", "InvalidDuration", "InvalidDripInterval",
  "CommitWindowClosed", "RevealWindowNotOpen", "RevealWindowClosed", "CommitmentMismatch", "InvalidTick", "BidExceedsDeposit",
  "AlreadyRevealed", "AuctionNotEnded", "AuctionNotCleared", "AlreadyClaimed", "AlreadyGraduated", "DripNotDue", "VaultEmpty",
  "SlippageExceeded", "SniperIneligible", "InsufficientStake", "MathOverflow", "Unauthorized",
] as const;
