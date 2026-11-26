#!/usr/bin/env bash
# Deploy apps/api to Railway (Dockerfile build from the monorepo root; see apps/api/railway.json).
#
#   scripts/deploy-api.sh [--yes] [--dry-run]
#
# First time:  railway login && railway init (or railway link) && add Postgres + Redis plugins,
#              then set service variables from apps/api/.env.example
#              (DATABASE_URL=${{Postgres.DATABASE_URL}}, REDIS_URL=${{Redis.REDIS_URL}}, …).
# Env: RAILWAY_TOKEN (CI), RAILWAY_SERVICE (default sealed-api), RAILWAY_ENVIRONMENT (default production)
source "$(dirname "$0")/lib.sh" "$@"
load_root_env
need railway "npm i -g @railway/cli"

SERVICE="${RAILWAY_SERVICE:-sealed-api}"
ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"
[[ -f "$ROOT/apps/api/railway.json" ]] || die "apps/api/railway.json missing"

cd "$ROOT"
# Railway reads railway.json from the repo root by default; point it at the API config.
export RAILWAY_CONFIG_FILE="apps/api/railway.json"

if [[ -z "${RAILWAY_TOKEN:-}" ]]; then railway whoami >/dev/null 2>&1 || die "not logged in — run 'railway login' or set RAILWAY_TOKEN"; fi

confirm "railway up → service '$SERVICE' ($ENVIRONMENT)?"
log "uploading monorepo build context to Railway"
run railway up --service "$SERVICE" --environment "$ENVIRONMENT" --detach
log "deploy started. Health: https://<your-domain>/api/health  ·  logs: railway logs --service $SERVICE"
