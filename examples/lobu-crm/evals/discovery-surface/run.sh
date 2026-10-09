#!/usr/bin/env bash
# Discovery-surface eval launcher.
#
# The eval runs the REAL isolated-vm sandbox (run_sdk / query_sdk), whose native
# addon only loads under Node 22–24 — NOT under Bun. So this harness runs under
# Node + tsx. Use the built workspace packages, as the server integration
# harness does: forcing CommonJS packages to source through tsx breaks named
# exports when an ESM dependency imports them. Run `make build-packages` first.
#
# GEMINI_API_KEY is loaded from the repo .env without overriding caller env.
# DATABASE_URL must point at a throwaway *test* Postgres (name containing
# "test"); the harness runs migrations
# (DROP SCHEMA public CASCADE) against it, guarded by assertSafeTestDatabaseUrl.
#
# Usage:
#   ./run.sh [--trials N] [--tasks id,id]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# repo root = four levels up from examples/lobu-crm/evals/discovery-surface
ROOT="$(cd "$HERE/../../../.." && pwd)"

# Node 22 (isolated-vm prebuilt ABI). Override with NODE22_BIN if elsewhere.
NODE22_BIN="${NODE22_BIN:-/opt/homebrew/opt/node@22/bin/node}"
if [ ! -x "$NODE22_BIN" ]; then
  echo "node@22 not found at $NODE22_BIN — set NODE22_BIN to a Node 22–24 binary (isolated-vm needs it)." >&2
  exit 1
fi

# Default to a local throwaway test DB if the caller didn't set one.
export DATABASE_URL="${DATABASE_URL:-postgresql://localhost:5432/lobu_mcp_discovery_test}"
case "$DATABASE_URL" in
  *test*|*_ci) : ;;
  *) echo "Refusing to run: DATABASE_URL ($DATABASE_URL) is not an obvious test DB (name must contain 'test')." >&2; exit 1 ;;
esac

export TSX_TSCONFIG_PATH="$HERE/tsconfig.json"
# Node's env-file loader preserves explicitly supplied variables, especially
# DATABASE_URL. Keep the no-file branch compatible with macOS Bash 3.2, where
# expanding an empty array with `set -u` fails before Node can start.
if [ -f "$ROOT/.env" ]; then
  exec "$NODE22_BIN" "--env-file=$ROOT/.env" --import "$ROOT/node_modules/tsx/dist/loader.mjs" "$HERE/run.ts" "$@"
fi
exec "$NODE22_BIN" --import "$ROOT/node_modules/tsx/dist/loader.mjs" "$HERE/run.ts" "$@"
