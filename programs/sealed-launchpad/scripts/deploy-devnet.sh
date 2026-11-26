#!/usr/bin/env bash
# Build (production feature set — NO test-mode) and deploy sealed_launchpad to devnet,
# then initialise the protocol + mock quote mints (scripts/init-devnet.ts).
#
# Requirements: solana CLI + anchor-cli on PATH, a funded devnet wallet at $WALLET
# (default ~/.config/solana/id.json; `solana airdrop 5 --url devnet` if needed).
# Program id is fixed by target/deploy/sealed_launchpad-keypair.json:
#   71geDPZMKfjJnKE4an15QyyH5TyFG1w7XEL5tUkp5Tpy
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."

WALLET="${WALLET:-$HOME/.config/solana/id.json}"
RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"

echo "==> wallet $(solana address -k "$WALLET") balance: $(solana balance -k "$WALLET" --url "$RPC_URL")"
echo "==> anchor build (no test-mode)"
anchor build
mkdir -p idl && cp target/idl/sealed_launchpad.json idl/sealed_launchpad.json

echo "==> deploying to devnet"
anchor deploy --provider.cluster "$RPC_URL" --provider.wallet "$WALLET"

echo "==> initialising protocol, mock mints and credit pools"
ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$WALLET" \
  pnpm exec ts-node --transpile-only -P tsconfig.json scripts/init-devnet.ts

echo "==> done. Mints written to devnet-mints.json"
