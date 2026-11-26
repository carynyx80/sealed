#!/usr/bin/env bash
# Shared helpers for scripts/*.sh (sourced, not executed).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
log()  { printf '%s▸%s %s\n' "$c_grn" "$c_off" "$*"; }
warn() { printf '%s!%s %s\n' "$c_ylw" "$c_off" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1' on PATH${2:+ — $2}"; }

# DRY_RUN=1 prints commands instead of running them.
run() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then printf '%s[dry-run]%s %s\n' "$c_dim" "$c_off" "$*"; else "$@"; fi
}

# Ask before doing anything that costs money / touches a remote. Skip with --yes or YES=1.
confirm() {
  [[ "${YES:-0}" == "1" || "${DRY_RUN:-0}" == "1" ]] && return 0
  read -r -p "$1 [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || die "aborted"
}

# Load ROOT/.env if present (without overriding already-exported vars).
load_root_env() {
  if [[ -f "$ROOT/.env" ]]; then
    while IFS='=' read -r k v; do
      [[ -z "$k" || "$k" == \#* ]] && continue
      [[ -z "${!k:-}" ]] && export "$k=$v"
    done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ROOT/.env")
  fi
}

# upsert_env FILE KEY VALUE — replace or append KEY=VALUE.
upsert_env() {
  local file="$1" key="$2" val="$3"
  touch "$file"
  if grep -qE "^${key}=" "$file"; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k {print k"="v; next} {print}' "$file" > "$tmp" && mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >> "$file"
  fi
}

for a in "$@"; do [[ "$a" == "--yes" || "$a" == "-y" ]] && export YES=1; [[ "$a" == "--dry-run" ]] && export DRY_RUN=1; done
true
