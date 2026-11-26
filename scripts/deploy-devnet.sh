#!/usr/bin/env bash
# Build + deploy the Anchor program to Solana devnet, run the protocol init script,
# then write the program id into every env file.
#
#   scripts/deploy-devnet.sh [--yes] [--dry-run] [--skip-build] [--skip-init]
#
# Env: SOLANA_RPC_URL (default https://api.devnet.solana.com), ANCHOR_WALLET (default ~/.config/solana/id.json)
source "$(dirname "$0")/lib.sh" "$@"
load_root_env

SKIP_BUILD=0; SKIP_INIT=0
for a in "$@"; do [[ "$a" == "--skip-build" ]] && SKIP_BUILD=1; [[ "$a" == "--skip-init" ]] && SKIP_INIT=1; done

PROG_DIR="$ROOT/programs/sealed-launchpad"
RPC="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
[[ "$RPC" == *mainnet* ]] && die "refusing to run against a mainnet RPC ($RPC) — this script is devnet-only"
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
WALLET="${WALLET/#\~/$HOME}"
KEYPAIR="$PROG_DIR/target/deploy/sealed_launchpad-keypair.json"

need solana "install the Solana CLI (https://docs.anza.xyz/cli/install)"
need anchor "install anchor-cli 0.32.x (avm install 0.32.1)"
need pnpm
[[ -f "$WALLET" ]] || die "deployer keypair not found at $WALLET (solana-keygen new -o $WALLET)"

DEPLOYER="$(solana address -k "$WALLET")"
log "deployer  $DEPLOYER"
log "rpc       $RPC"

BAL="$(solana balance -u "$RPC" -k "$WALLET" 2>/dev/null | awk '{print $1}' || echo 0)"
log "balance   ${BAL} SOL"
if awk "BEGIN{exit !(${BAL:-0} < 4)}"; then
  warn "program deploys need ~4-6 SOL of rent on devnet. Try: solana airdrop 2 -u devnet $DEPLOYER (rate-limited) or https://faucet.solana.com"
fi

confirm "Deploy sealed_launchpad to DEVNET from $DEPLOYER?"

cd "$PROG_DIR"
if [[ "$SKIP_BUILD" == "0" ]]; then
  log "anchor build"
  run anchor build
fi
[[ -f "$KEYPAIR" ]] || die "program keypair missing: $KEYPAIR (anchor build creates it; keep it — it defines the program id)"
PROGRAM_ID="$(solana address -k "$KEYPAIR")"
log "program   $PROGRAM_ID"

# Keep declare_id!/Anchor.toml in sync with the keypair (no-op if already synced), rebuild if it changed.
if ! grep -q "$PROGRAM_ID" Anchor.toml; then
  warn "Anchor.toml program id differs from keypair — running anchor keys sync + rebuild"
  run anchor keys sync
  run anchor build
fi

log "anchor deploy → devnet"
run anchor deploy --provider.cluster "$RPC" --provider.wallet "$WALLET" --program-name sealed_launchpad --program-keypair "$KEYPAIR"

# Publish the IDL where the API/web look for it.
if [[ -f target/idl/sealed_launchpad.json ]]; then
  run mkdir -p idl
  run cp target/idl/sealed_launchpad.json idl/sealed_launchpad.json
  log "IDL copied to programs/sealed-launchpad/idl/"
fi

if [[ "$SKIP_INIT" == "0" ]]; then
  if [[ -f scripts/init-devnet.ts ]]; then
    log "init protocol config + credit pools + devnet quote mints (scripts/init-devnet.ts)"
    ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$WALLET" PROGRAM_ID="$PROGRAM_ID" run pnpm --filter @sealed/program init:devnet
  else
    warn "programs/sealed-launchpad/scripts/init-devnet.ts not found — skipping init"
  fi
fi

cd "$ROOT"
log "writing PROGRAM_ID into env files"
if [[ "${DRY_RUN:-0}" != "1" ]]; then
  upsert_env "$ROOT/.env" PROGRAM_ID "$PROGRAM_ID"
  upsert_env "$ROOT/apps/api/.env" PROGRAM_ID "$PROGRAM_ID"
  upsert_env "$ROOT/apps/api/.env" NETWORK devnet
  upsert_env "$ROOT/apps/api/.env" SOLANA_RPC_URL "$RPC"
  upsert_env "$ROOT/apps/web/.env.local" NEXT_PUBLIC_PROGRAM_ID "$PROGRAM_ID"
  upsert_env "$ROOT/apps/web/.env.local" NEXT_PUBLIC_NETWORK devnet
  upsert_env "$ROOT/apps/web/.env.local" NEXT_PUBLIC_RPC_URL "$RPC"
fi
log "done. Program $PROGRAM_ID on devnet — https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
log "next: set PROGRAM_ID / NEXT_PUBLIC_PROGRAM_ID on Railway + Vercel (scripts/deploy-api.sh, scripts/deploy-web.sh)"
