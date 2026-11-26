#!/usr/bin/env bash
# Deploy apps/web to Vercel (project root directory = apps/web; see apps/web/vercel.json).
#
#   scripts/deploy-web.sh [--yes] [--dry-run] [--preview]
#
# First time:  vercel login && (cd apps/web && vercel link). In the Vercel project set
#              Root Directory = apps/web and add NEXT_PUBLIC_* vars from apps/web/.env.example.
# Env: VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID (CI)
source "$(dirname "$0")/lib.sh" "$@"
load_root_env
need vercel "npm i -g vercel"

PROD="--prod"
for a in "$@"; do [[ "$a" == "--preview" ]] && PROD=""; done
TOKEN_ARGS=()
[[ -n "${VERCEL_TOKEN:-}" ]] && TOKEN_ARGS=(--token "$VERCEL_TOKEN")

cd "$ROOT/apps/web"
[[ -f vercel.json ]] || die "apps/web/vercel.json missing"
confirm "vercel deploy ${PROD:-(preview)} from apps/web?"
log "vercel deploy (remote build uses vercel.json install/build commands from the monorepo root)"
run vercel deploy $PROD --yes "${TOKEN_ARGS[@]+"${TOKEN_ARGS[@]}"}"
