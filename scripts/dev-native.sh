#!/usr/bin/env bash
# Run the embedded Lobu stack natively.
#
# What runs:
#   - server (Hono + tsx watch) on :$PORT (default 8787)
#   - embedded gateway (in-process) with HTTP egress proxy on :$WORKER_PROXY_PORT (default 8118)
#   - agent turns (run as isolate jobs in the connector-worker)
#   - Vite dev middleware for web on the same :$PORT (HMR via WS)
#
# Requires, managed outside this script:
#   - Postgres reachable via DATABASE_URL in .env
#
# Per-worktree port overrides: drop a gitignored `.env.local` in the repo root
# with `PORT=8788` and `WORKER_PROXY_PORT=8119` (or similar) to run multiple
# worktrees side-by-side without colliding on :8787 / :8118. .env.local takes
# precedence over .env.
#
# Skipped vs production: external managed services and cloud backfill workers.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- Preflight -------------------------------------------------------------

command -v bun >/dev/null || { echo "bun is required: curl -fsSL https://bun.sh/install | bash"; exit 1; }

# Lobu's SDK sandbox (query_sdk / run_sdk) depends on isolated-vm@6, which has
# not shipped Node 25+ support yet (upstream: laverdet/isolated-vm#553). The
# call-site gate in packages/server/src/sandbox/run-script.ts only surfaces
# this when an agent invokes the sandbox; we fail fast here so `make dev`
# itself refuses to boot under an unsupported Node major.
node_supported() {
  local bin=$1
  [ -x "$bin" ] || return 1
  local major
  major=$("$bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo "")
  [ -n "$major" ] && [ "$major" -ge 22 ] && [ "$major" -lt 25 ]
}

if ! node_supported "$(command -v node || true)"; then
  for candidate in /opt/homebrew/opt/node@22/bin /opt/homebrew/opt/node@23/bin /opt/homebrew/opt/node@24/bin /usr/local/opt/node@22/bin /usr/local/opt/node@23/bin /usr/local/opt/node@24/bin; do
    if node_supported "$candidate/node"; then
      echo "↪︎  Using $($candidate/node -v) from $candidate (system node is unsupported)"
      export PATH="$candidate:$PATH"
      break
    fi
  done
fi

if ! node_supported "$(command -v node || true)"; then
  current=$(node -v 2>/dev/null || echo 'unknown')
  echo "❌ Unsupported Node.js runtime: $current (required: 22.x–24.x)"
  echo "   isolated-vm has no Node 25+ build yet — see https://github.com/laverdet/isolated-vm/issues/553"
  echo "   Quick fix on macOS: brew install node@22 (this script auto-detects Homebrew node@22-24)"
  echo "   Or use a version manager (nvm, fnm, mise, asdf, volta) that honours .nvmrc / .node-version."
  exit 1
fi

if [ ! -f .env ]; then
  echo "❌ .env not found at $REPO_ROOT/.env"
  echo "   Copy from .env.example or run: npx @lobu/cli@latest"
  exit 1
fi

if [ ! -d packages/core/dist ] || [ ! -d packages/connector-sdk/dist ]; then
  echo "📦 Building workspace packages (one-time)…"
  make build-packages
fi

# Interactive cards run in a self-contained MCP App iframe rather than Vite's
# SPA graph. Build that payload before boot so approvals/questions never render
# the server's 404 response on a fresh worktree. The build is intentionally
# repeated: Vite HMR cannot update this separately-built iframe bundle.
echo "📦 Building Owletto interaction app…"
( cd packages/owletto && bun run build:mcp-apps )

# --- Env -------------------------------------------------------------------

# Preserve explicit environment overrides from the caller while still loading
# local defaults/secrets from .env. This matters for scripts/run-e2e.sh, which
# points DATABASE_URL at an isolated test database; sourcing .env must not send
# the app server to a different DB than the test helpers use.
_PRESET_DATABASE_URL_SET="${DATABASE_URL+x}"
_PRESET_DATABASE_URL="${DATABASE_URL-}"
_PRESET_PGSSLMODE_SET="${PGSSLMODE+x}"
_PRESET_PGSSLMODE="${PGSSLMODE-}"
_PRESET_HOST_SET="${HOST+x}"
_PRESET_HOST="${HOST-}"
_PRESET_PORT_SET="${PORT+x}"
_PRESET_PORT="${PORT-}"
_PRESET_WORKER_PROXY_PORT_SET="${WORKER_PROXY_PORT+x}"
_PRESET_WORKER_PROXY_PORT="${WORKER_PROXY_PORT-}"
_PRESET_PUBLIC_GATEWAY_URL_SET="${PUBLIC_GATEWAY_URL+x}"
_PRESET_PUBLIC_GATEWAY_URL="${PUBLIC_GATEWAY_URL-}"
_PRESET_LOBU_PROVIDER_REGISTRY_PATH_SET="${LOBU_PROVIDER_REGISTRY_PATH+x}"
_PRESET_LOBU_PROVIDER_REGISTRY_PATH="${LOBU_PROVIDER_REGISTRY_PATH-}"
_PRESET_FAKE_LLM_API_KEY_SET="${FAKE_LLM_API_KEY+x}"
_PRESET_FAKE_LLM_API_KEY="${FAKE_LLM_API_KEY-}"
_PRESET_FAKE_LLM_BASE_URL_SET="${FAKE_LLM_BASE_URL+x}"
_PRESET_FAKE_LLM_BASE_URL="${FAKE_LLM_BASE_URL-}"

set -a
# shellcheck disable=SC1091
source .env
# .env.local is gitignored and intended for per-worktree overrides
# (e.g. PORT/WORKER_PROXY_PORT so two worktrees can run side-by-side).
if [ -f .env.local ]; then
  # shellcheck disable=SC1091
  source .env.local
fi
set +a

if [[ -n "$_PRESET_DATABASE_URL_SET" ]]; then export DATABASE_URL="$_PRESET_DATABASE_URL"; fi
if [[ -n "$_PRESET_PGSSLMODE_SET" ]]; then export PGSSLMODE="$_PRESET_PGSSLMODE"; fi
if [[ -n "$_PRESET_HOST_SET" ]]; then export HOST="$_PRESET_HOST"; fi
if [[ -n "$_PRESET_PORT_SET" ]]; then export PORT="$_PRESET_PORT"; fi
if [[ -n "$_PRESET_WORKER_PROXY_PORT_SET" ]]; then export WORKER_PROXY_PORT="$_PRESET_WORKER_PROXY_PORT"; fi
if [[ -n "$_PRESET_PUBLIC_GATEWAY_URL_SET" ]]; then export PUBLIC_GATEWAY_URL="$_PRESET_PUBLIC_GATEWAY_URL"; fi
if [[ -n "$_PRESET_LOBU_PROVIDER_REGISTRY_PATH_SET" ]]; then export LOBU_PROVIDER_REGISTRY_PATH="$_PRESET_LOBU_PROVIDER_REGISTRY_PATH"; fi
if [[ -n "$_PRESET_FAKE_LLM_API_KEY_SET" ]]; then export FAKE_LLM_API_KEY="$_PRESET_FAKE_LLM_API_KEY"; fi
if [[ -n "$_PRESET_FAKE_LLM_BASE_URL_SET" ]]; then export FAKE_LLM_BASE_URL="$_PRESET_FAKE_LLM_BASE_URL"; fi

export NODE_ENV="${NODE_ENV:-development}"
export ENVIRONMENT="${ENVIRONMENT:-development}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8787}"
export WORKER_PROXY_PORT="${WORKER_PROXY_PORT:-8118}"
# Agent API base (mounted at /lobu). SPA is pathless at the origin — see
# scripts/lib/dev-app-url.sh. Do not open …/lobu in a browser for the UI.
export PUBLIC_GATEWAY_URL="${PUBLIC_GATEWAY_URL:-http://localhost:${PORT}/lobu}"
export LOBU_PROVIDER_REGISTRY_PATH="${LOBU_PROVIDER_REGISTRY_PATH:-$REPO_ROOT/config/providers.json}"
export LOBU_DEV_PROJECT_PATH="${LOBU_DEV_PROJECT_PATH:-$REPO_ROOT}"
export LOBU_WORKSPACE_ROOT="${LOBU_WORKSPACE_ROOT:-$REPO_ROOT/workspaces}"

mkdir -p "$LOBU_WORKSPACE_ROOT"

# shellcheck source=scripts/lib/dev-app-url.sh
. "$REPO_ROOT/scripts/lib/dev-app-url.sh"

# --- Run -------------------------------------------------------------------

# Backend is selected by the DATABASE_URL *scheme*, not its mere presence: only
# a postgres:// URL takes the external path. An unset URL or a file:// path runs
# embedded Postgres. This lets `DATABASE_URL=file://<dir>` point at an alternate
# data dir (another worktree's, a snapshot) without being mis-routed to the
# external branch and its sslmode=require default — the trap that made "run it
# against existing data" fall over.
case "${DATABASE_URL:-}" in
  postgres://* | postgresql://*) _LOBU_EMBEDDED=0 ;;
  *)                             _LOBU_EMBEDDED=1 ;;
esac

if [ "$_LOBU_EMBEDDED" = 1 ]; then
  # Default the data root when none was given. Override with LOBU_DEV_DATA_ROOT
  # (or pass DATABASE_URL=file://<dir>) to run multiple isolated instances from
  # ONE repo root — each gets its own cluster + lock. Pair with PORT /
  # WORKER_PROXY_PORT overrides so the rails don't collide:
  #   LOBU_DEV_DATA_ROOT=/tmp/lobu-a PORT=8930 WORKER_PROXY_PORT=8130 make dev
  #   LOBU_DEV_DATA_ROOT=/tmp/lobu-b PORT=8931 WORKER_PROXY_PORT=8131 make dev
  # The embedded PG port is auto-picked free per instance, so it never clashes.
  if [ -z "${DATABASE_URL:-}" ]; then
    DEV_DATA_ROOT="${LOBU_DEV_DATA_ROOT:-$REPO_ROOT/.lobu-dev}"
    export DATABASE_URL="file://${DEV_DATA_ROOT}"
  else
    DEV_DATA_ROOT="${DATABASE_URL#file://}"
  fi
  export PGSSLMODE="${PGSSLMODE:-disable}"
  mkdir -p "$DEV_DATA_ROOT"
  echo "→ embedded Postgres   cluster: $DEV_DATA_ROOT/.lobu/pgdata"
  echo "→ server on http://${HOST}:${PORT}   (Vite HMR in-process)"
  lobu_dev_print_app_url
  echo "→ first run: sign up in the app to claim its single account (LOBU_SINGLE_USER=1)"
  echo "→ then run \`lobu apply\` from a project dir to sync its lobu.config.ts"
  echo ""
  if [[ "${OPEN:-}" == "1" || "${OPEN:-}" == "true" ]]; then
    lobu_dev_schedule_open
  fi
  exec bun run --filter '@lobu/server' dev:local
fi

# External Postgres (postgres:// URL). Point this at a running instance's
# embedded cluster to SHARE its data with a second app (no extra lock): pin the
# primary's PG port, then attach —
#   LOBU_PG_PORT=5544 make dev                                  # primary
#   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5544/postgres \
#     PORT=8931 WORKER_PROXY_PORT=8131 make dev                 # shares its data
# Default sslmode by host: a local Postgres (brew, a container) speaks no TLS,
# so localhost defaults to `disable`; anything remote defaults to `require`.
# This is the local-dev launcher only — prod/cloud paths are untouched. An
# explicit PGSSLMODE always wins.
# Host from postgres://[user[:pass]@]host[:port][/db][?params], incl. [IPv6].
_lobu_db_rest="${DATABASE_URL#*://}"; _lobu_db_rest="${_lobu_db_rest##*@}"
case "$_lobu_db_rest" in
  '['*) _lobu_db_host="${_lobu_db_rest#\[}"; _lobu_db_host="${_lobu_db_host%%]*}" ;;
  *)    _lobu_db_host="${_lobu_db_rest%%[:/?]*}" ;;
esac
case "$_lobu_db_host" in
  localhost | 127.0.0.1 | ::1) export PGSSLMODE="${PGSSLMODE:-disable}" ;;
  *)                           export PGSSLMODE="${PGSSLMODE:-require}" ;;
esac

echo "→ external Postgres (sslmode=${PGSSLMODE})"
echo "→ server on http://${HOST}:${PORT}"
echo "→ embedded gateway proxy on :${WORKER_PROXY_PORT}"
echo "→ Vite HMR in-process (same port)"
lobu_dev_print_app_url
echo ""
if [[ "${OPEN:-}" == "1" || "${OPEN:-}" == "true" ]]; then
  lobu_dev_schedule_open
fi

exec bun run --filter '@lobu/server' dev
