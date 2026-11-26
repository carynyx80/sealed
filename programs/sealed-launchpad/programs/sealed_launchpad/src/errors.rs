use anchor_lang::prelude::*;

/// Order of the first 23 variants matches PROGRAM_ERRORS in program.ts (codes 6000..6022).
#[error_code]
pub enum ErrorCode {
    #[msg("Creator allocation exceeds 2% of supply")]
    CreatorAllocationTooHigh,
    #[msg("Auction supply must be 20%..60% of supply")]
    InvalidAuctionSupply,
    #[msg("Credit bps must be 1000..1500")]
    InvalidCreditBps,
    #[msg("Invalid auction duration")]
    InvalidDuration,
    #[msg("Invalid drip interval or count")]
    InvalidDripInterval,
    #[msg("Commit window is closed")]
    CommitWindowClosed,
    #[msg("Reveal window is not open yet")]
    RevealWindowNotOpen,
    #[msg("Reveal window is closed")]
    RevealWindowClosed,
    #[msg("Commitment does not match revealed preimage")]
    CommitmentMismatch,
    #[msg("Price is not a valid tick")]
    InvalidTick,
    #[msg("Bid amount exceeds deposit")]
    BidExceedsDeposit,
    #[msg("Bid already revealed")]
    AlreadyRevealed,
    #[msg("Auction has not ended")]
    AuctionNotEnded,
    #[msg("Auction has not been cleared")]
    AuctionNotCleared,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("Launch already graduated")]
    AlreadyGraduated,
    #[msg("Buyback drip not due yet")]
    DripNotDue,
    #[msg("Buyback vault is empty")]
    VaultEmpty,
    #[msg("Slippage exceeded")]
    SlippageExceeded,
    #[msg("Wallet is a same-slot sniper and is ineligible")]
    SniperIneligible,
    #[msg("Insufficient stake")]
    InsufficientStake,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Unauthorized")]
    Unauthorized,
    // ---- program-only extras ----
    #[msg("Invalid launch parameters")]
    InvalidParams,
    #[msg("Launch is not in the required status")]
    InvalidStatus,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Launch is not live")]
    NotLive,
    #[msg("Invalid account")]
    InvalidAccount,
}
