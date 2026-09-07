#!/bin/bash
set -e

MODE="${1:-server}"
app_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

echo "Starting Lobu backend (Node)"
echo "================================"

echo "Environment:"
echo "  DATABASE_URL: ${DATABASE_URL:+***set***}"
echo "  GITHUB_TOKEN: ${GITHUB_TOKEN:+***set***}"
echo "  JWT_SECRET: ${JWT_SECRET:+***set***}"

preflight_database() {
  echo "Checking database connectivity..."
  node --input-type=module <<'NODE'
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
const timeoutSeconds = Number(process.env.DB_PREFLIGHT_TIMEOUT_SECONDS || 10);

if (!databaseUrl) {
  console.error("ERROR: DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  max: 1,
  connect_timeout: timeoutSeconds,
  idle_timeout: 1,
  onnotice: () => {},
});

try {
  const rows = await sql`select current_database() as database`;
  console.log(`Database preflight passed (${rows[0]?.database ?? "unknown"})`);
} catch (error) {
  console.error("ERROR: database preflight failed");
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Refusing to run migrations against an unreachable or missing production database.");
  process.exit(1);
} finally {
  await sql.end({ timeout: 1 }).catch(() => {});
}
NODE
}

run_migrations() {
  if [ -z "$DATABASE_URL" ]; then
    echo "ERROR: DATABASE_URL not set"
    exit 1
  fi

  if [ "${NODE_ENV:-}" = "production" ] && [ "${ALLOW_DB_CREATE:-0}" != "1" ]; then
    preflight_database
  fi

  echo ""
  echo "Running database migrations..."
  # Statement-at-a-time for transaction:false (CONCURRENTLY + heal DO). Plain
  # dbmate Exec's the whole up section as one simple-query batch, which Postgres
  # wraps in an implicit transaction that CREATE INDEX CONCURRENTLY refuses.
  # scripts/migrate-up.mjs uses the existing public.schema_migrations ledger.
  MIGRATIONS_DIR="${MIGRATIONS_DIR:-$app_dir/db/migrations}" \
    node "$app_dir/scripts/migrate-up.mjs"
  echo "Migrations complete"
}

if [ "$MODE" = "migrate" ]; then
  run_migrations
  exit 0
fi

echo ""
echo "Starting backend on port 8787..."

# When the Helm chart's pre-upgrade migration Job is enabled, it has
# already applied migrations before this Deployment is rolled. Set
# SKIP_MIGRATIONS=1 in that environment so the per-pod start doesn't
# block on a migration that may take longer than livenessProbe allows.
if [ "${SKIP_MIGRATIONS:-0}" = "1" ]; then
  echo "SKIP_MIGRATIONS=1 — assuming the pre-upgrade Job applied migrations."
else
  run_migrations
fi

# Run under Node so V8 native addons (isolated-vm) load. Bun uses
# JavaScriptCore and cannot link the V8 ABI surface that isolated-vm needs;
# the execute MCP tool silently degrades to RuntimeUnavailable under bun.
#
# We run a pre-bundled artifact (built by scripts/build-server-bundle.mjs
# in the builder stage) instead of TS source via tsx. Bundling at build
# time inlines workspace packages (@lobu/core et al.) so Node never has to
# bind named imports against their CJS dist barrels — that's what crashed
# #430. External npm deps are resolved by Node from node_modules, which
# is hoisted (see Dockerfile `bun install --linker=hoisted`) so the flat
# layout matches what Node expects.
exec node /app/packages/server/dist/server.bundle.mjs
