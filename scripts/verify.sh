#!/usr/bin/env bash
# Definition-of-done verification. Runs everything locally; deploys nothing.
#
#   scripts/verify.sh [--install] [--no-anchor] [--no-build] [--fast]
#
#   --install    run `pnpm install --frozen-lockfile` first
#   --no-anchor  skip anchor build/test even if the Solana toolchain is present
#   --no-build   skip `pnpm build` (e2e will then use whatever is already built)
#   --fast       shorthand for --no-anchor
# Logs for each step are written to .verify-logs/<step>.log
source "$(dirname "$0")/lib.sh"
set +e  # we collect failures instead of exiting on the first one

INSTALL=0; ANCHOR=1; BUILD=1
for a in "$@"; do
  case "$a" in
    --install) INSTALL=1 ;;
    --no-anchor|--fast) ANCHOR=0 ;;
    --no-build) BUILD=0 ;;
  esac
done

cd "$ROOT"
LOGDIR="$ROOT/.verify-logs"; mkdir -p "$LOGDIR"
NAMES=(); RESULTS=(); TIMES=()
FAILED=0

step() { # step <name> <cmd...>
  local name="$1"; shift
  local slug; slug="$(echo "$name" | tr ' /:' '___' | tr -cd '[:alnum:]_-')"
  local t0; t0=$(date +%s)
  printf '%s── %s%s\n' "$c_dim" "$name" "$c_off"
  "$@" >"$LOGDIR/$slug.log" 2>&1
  local rc=$?
  local dt=$(( $(date +%s) - t0 ))
  NAMES+=("$name"); TIMES+=("${dt}s")
  if [[ $rc -eq 0 ]]; then
    if grep -qE '^# (SKIP|skipped)|# skipped [1-9]' "$LOGDIR/$slug.log"; then RESULTS+=("PASS*"); else RESULTS+=("PASS"); fi
    printf '   %sPASS%s (%ss)\n' "$c_grn" "$c_off" "$dt"
  else
    RESULTS+=("FAIL"); FAILED=1
    printf '   %sFAIL%s (%ss) — tail of %s:\n' "$c_red" "$c_off" "$dt" "${LOGDIR#$ROOT/}/$slug.log"
    tail -25 "$LOGDIR/$slug.log" | sed 's/^/     /'
  fi
}
skip() { NAMES+=("$1"); RESULTS+=("SKIP"); TIMES+=("-"); printf '%s── %s%s\n   %sSKIP%s %s\n' "$c_dim" "$1" "$c_off" "$c_ylw" "$c_off" "$2"; }

need node; need pnpm
log "node $(node --version) · pnpm $(pnpm --version)"

[[ $INSTALL -eq 1 ]] && step "pnpm install" pnpm install --frozen-lockfile
step "build @sealed/shared" pnpm --filter @sealed/shared build
step "pnpm typecheck" pnpm typecheck
if [[ $BUILD -eq 1 ]]; then step "pnpm build" pnpm build; else skip "pnpm build" "--no-build"; fi
step "shared unit tests" pnpm --filter @sealed/shared test
if [[ -d packages/defi/dist/__tests__ ]]; then step "defi unit tests" pnpm --filter @sealed/defi test; else skip "defi unit tests" "no packages/defi/dist/__tests__"; fi
if ls apps/api/test/*.test.ts >/dev/null 2>&1; then step "api unit tests" pnpm --filter @sealed/api test; else skip "api unit tests" "no apps/api/test/*.test.ts"; fi
step "invariant tests" pnpm --filter @sealed/e2e test:invariants
step "e2e (api + web smoke)" pnpm --filter @sealed/e2e test:e2e

if [[ $ANCHOR -eq 1 ]] && command -v anchor >/dev/null 2>&1 && command -v solana >/dev/null 2>&1; then
  step "anchor build" bash -c "cd programs/sealed-launchpad && anchor build"
  if command -v solana-test-validator >/dev/null 2>&1; then
    step "anchor test" bash -c "cd programs/sealed-launchpad && pnpm test"
  else
    skip "anchor test" "solana-test-validator not on PATH"
  fi
else
  skip "anchor build" "solana/anchor not on PATH or --no-anchor"
  skip "anchor test" "solana/anchor not on PATH or --no-anchor"
fi

echo
echo "┌──────────────────────────────┬────────┬────────┐"
printf "│ %-28s │ %-6s │ %-6s │\n" "step" "result" "time"
echo "├──────────────────────────────┼────────┼────────┤"
for i in "${!NAMES[@]}"; do
  r="${RESULTS[$i]}"; col="$c_grn"; [[ "$r" == FAIL ]] && col="$c_red"; [[ "$r" == SKIP || "$r" == "PASS*" ]] && col="$c_ylw"
  printf "│ %-28s │ %s%-6s%s │ %-6s │\n" "${NAMES[$i]}" "$col" "$r" "$c_off" "${TIMES[$i]}"
done
echo "└──────────────────────────────┴────────┴────────┘"
echo "PASS* = passed with skipped sub-tests (see log).  Logs: .verify-logs/"
if [[ $FAILED -eq 0 ]]; then printf '%sVERIFY: PASS%s\n' "$c_grn" "$c_off"; exit 0; else printf '%sVERIFY: FAIL%s\n' "$c_red" "$c_off"; exit 1; fi
