#!/usr/bin/env bash
# Runs the Lobu Linux CI graph (ci.yml) jobs as local commands.
#
# This is the shared payload behind `make pr-full` / `make pr-fast`: the same
# script executes inside a Daytona ephemeral sandbox (after provision) and as
# the local fallback when Daytona is unavailable. GitHub CI remains the
# canonical gate; this runner is a convenience preflight.
#
# Contract:
#   - Every job mirrors its ci.yml steps (same commands, same order).
#   - Jobs whose prerequisites are missing (DATABASE_URL, submodule, docker,
#     Chrome, dbmate) are SKIPPED with a reason, never silently passed and
#     never fatal — the command must stay non-disruptive. The summary lists
#     every skip; CI covers what this runner cannot.
#   - GitHub-only steps (PR diff gates, squawk scoping, client-regen) are
#     skipped here with a note — they need git history the sandbox lacks.
#
# Usage: bash scripts/lib/gate-runner.sh [job ...]   (defaults to all jobs)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# Keep in sync with DEFAULT_JOBS in scripts/run-remote-ci.sh (depot path).
GATE_JOBS=(
  unit
  frontend
  server-integration-vitest
  server-integration-bun
  integration
  format-lint
  typecheck
  migrations
  sdk-cli-build
  sdk-lifecycle-e2e
  sdk-error-taxonomy-e2e
  cli-command-smoke
  sdk-cli-e2e
  dead-code-report
  optional-smoke-filter
  connector-parity-smoke
)

GATE_PASS=0
GATE_FAIL=0
GATE_SKIP=0
declare -a GATE_FAILED=()
declare -a GATE_SKIPPED=()
GATE_RAN_VITEST=0
GATE_RAN_BUN=0
GATE_RAN_SDK_BUILD=0
GATE_RAN_SDK_LIFECYCLE=0
GATE_RAN_SDK_ERROR=0
GATE_RAN_CLI_SMOKE=0

# ── helpers ────────────────────────────────────────────────────────────────

gate_skip() { # reason...
  printf '   ↷ skipped: %s\n' "$*"
  GATE_SKIP=$((GATE_SKIP + 1))
  GATE_SKIPPED+=("$*")
  return 77
}

gate_require_db() {
  [ -n "${DATABASE_URL:-}" ] && return 0
  gate_skip "DATABASE_URL is unset (needs a Postgres + pgvector)"
}

gate_require_submodule() {
  # The real submodule ships src/; the stub (no deploy key) only has a
  # package.json. Gate on real content so a stub can't half-build.
  [ -d packages/owletto/src ] && return 0
  gate_skip "packages/owletto submodule content is not checked out (stub semantics)"
}

gate_require_docker() {
  command -v docker >/dev/null 2>&1 || { gate_skip "docker not available"; return 77; }
  docker info >/dev/null 2>&1 || { gate_skip "docker daemon not reachable"; return 77; }
}

# ── jobs (each mirrors the ci.yml job of the same name) ────────────────────

gate_unit() {
  bun test packages/core packages/cli --timeout 30000 || return 1
  bun test packages/plugin-api packages/plugin-host packages/plugin-toolkit packages/plugin-memory packages/plugin-conversations packages/plugin-media packages/plugin-mcp --timeout 30000 || return 1
  bun test packages/server/src/__tests__/unit --timeout 30000 || return 1
  bun test packages/server/src/auth/__tests__/system-provider-resolution.test.ts --timeout 30000 || return 1
  bun test packages/server/src/utils/__tests__/device-pin-tombstones.test.ts packages/server/src/tools/admin/manage_operations/__tests__/activity-feed-collapse.test.ts --timeout 30000 || return 1
  bun test packages/server/src/utils/__tests__/catalog-connectors-compile.test.ts packages/server/src/utils/__tests__/compiler-core.test.ts packages/server/src/utils/__tests__/build-catalog-manifests-exit.test.ts --timeout 30000 || return 1
  bun test packages/connector-worker --timeout 30000 || return 1
  bun test packages/client packages/promptfoo-provider --timeout 30000 || return 1
  bun test packages/connector-sdk --timeout 30000 || return 1
  bun test packages/connectors --timeout 30000 || return 1
  bun test packages/embeddings --timeout 30000 || return 1
  bun test examples/personal-agent --timeout 30000 || return 1
  bun test examples/brand-intelligence --timeout 30000 || return 1
  bun test examples/lobu-team --timeout 30000 || return 1
}

gate_frontend() {
  gate_require_submodule || return 77
  (cd packages/core && bun run build) || return 1
  (cd packages/connector-sdk && bun run build) || return 1
  (cd packages/owletto && ../../node_modules/.bin/vitest run) || return 1
  (cd packages/owletto && bun run build) || return 1
  if [ -x /usr/bin/google-chrome-stable ]; then
    (cd packages/owletto && bun run smoke:boot) || return 1
  else
    echo "   (no google-chrome-stable — SPA cold-boot smoke skipped; vitest + prod build still ran)"
  fi
}

gate_server_integration_vitest() {
  gate_require_db || return 77
  (cd packages/server && node ../../node_modules/.bin/vitest run --reporter=default) || return 1
  GATE_RAN_VITEST=1
}

gate_server_integration_bun() {
  gate_require_db || return 77
  # Each gateway test file in its own process: bun has no per-file isolation
  # and the suites aren't mutually hermetic (see #1238). Fail if find matches
  # nothing, so a path typo can't silently run zero tests.
  local dirs files rc f
  dirs=$(find packages/server/src/gateway -type d -name __tests__ | sort)
  [ -n "$dirs" ] || { echo "no gateway __tests__ dirs found" >&2; return 1; }
  rc=0
  for d in $dirs; do
    files=$(find "$d" -maxdepth 1 -type f -name '*.test.ts' | sort)
    for f in $files; do echo ">> bun test $f"; bun test "$f" || rc=1; done
  done
  [ "$rc" -eq 0 ] || return 1
  bun test packages/server/src/lobu/__tests__ packages/server/src/scheduled packages/server/src/workspace/__tests__ packages/server/src/tools/admin/__tests__ packages/server/src/auth/oauth/__tests__ packages/server/src/utils/__tests__/deployment-pause.test.ts --timeout 30000 || return 1
  bun test packages/connector-worker/integration-tests || return 1
  GATE_RAN_BUN=1
}

gate_integration() {
  # CI's integration job is a compatibility fan-in over the two server jobs.
  if [ "$GATE_RAN_VITEST" -eq 0 ]; then gate_server_integration_vitest || return $?; fi
  if [ "$GATE_RAN_BUN" -eq 0 ]; then gate_server_integration_bun || return $?; fi
  echo "   (fan-in over server-integration-vitest + server-integration-bun — both passed)"
}

gate_format_lint() {
  bun run format:check || return 1
  bun run lint || return 1
  ./scripts/check-security-patterns.sh || return 1
  bun run dupes || return 1
  bun scripts/check-test-runner-coverage.mjs || return 1
  bun scripts/check-exposed-surface-naming.ts || return 1
  bun test scripts/__tests__/check-exposed-surface-naming.test.ts --timeout 30000 || return 1
  node scripts/check-gateway-llm-calls.mjs || return 1
  bun test scripts/__tests__/check-gateway-llm-calls.test.ts --timeout 30000 || return 1
  bun test scripts/__tests__/publish-packages-guard.test.ts --timeout 30000 || return 1
  bun test scripts/__tests__/derive-image-tags.test.ts --timeout 30000 || return 1
  bun test scripts/__tests__/release-publish-order.test.ts --timeout 30000 || return 1
  bun test scripts/__tests__/audit-release-images.test.ts --timeout 30000 || return 1
  bun test scripts/__tests__/check-merge-integrity.test.ts --timeout 30000 || return 1
  bun test scripts/__tests__/review-prompt-env-blockers.test.ts --timeout 30000 || return 1
  bun test scripts/__tests__/review-output-schema.test.ts --timeout 30000 || return 1
  bun test scripts/__tests__/migrate-up-check-pending.test.ts --timeout 30000 || return 1
  bun test scripts/__tests__/migrate-up-duplicate-version.test.ts --timeout 30000 || return 1
  bun scripts/check-raw-array-params.mjs || return 1
  bun scripts/check-entity-write-funnel.mjs || return 1
  bun test scripts/__tests__/check-entity-write-funnel.test.ts --timeout 30000 || return 1
  bun scripts/check-connection-visibility-compiler.mjs || return 1
  bun scripts/check-directory-structure.mjs || return 1
  bun test scripts/__tests__/check-directory-structure.test.ts --timeout 30000 || return 1
  bash scripts/lib/__tests__/review-commit-lock.test.sh || return 1
  bash scripts/lib/__tests__/review-process.test.sh || return 1
  bash scripts/lib/__tests__/review-reviewer.test.sh || return 1
  bash scripts/lib/__tests__/review-upstream-guard.test.sh || return 1
  bash scripts/lib/__tests__/review-skip.test.sh || return 1
  bash scripts/lib/__tests__/review-cache.test.sh || return 1
  bash scripts/lib/__tests__/process-cleanup.test.sh || return 1
  sh scripts/lib/__tests__/kubeconfig-preflight.test.sh || return 1
  cmp -s .github/actions/setup-submodule/action.yml .depot/actions/setup-submodule/action.yml || return 1
  bash scripts/lib/__tests__/remote-ci.test.sh || return 1
  bash scripts/lib/__tests__/submodule-drift.test.sh || return 1
  bash scripts/lib/__tests__/submodule-bump.test.sh || return 1
}

gate_typecheck() {
  bun run typecheck || return 1
  (cd packages/server && bunx tsc --noEmit) || return 1
  bun run check:packages || return 1
  bun run knip --include files || return 1
}

gate_migrations() {
  # Local-fallback safety: applying migrations mutates whatever DATABASE_URL
  # points at (a developer's DB: ALTER SYSTEM + dbmate ledger) and the
  # workspace (scratch node_modules/postgres). The sandbox sets
  # GATE_APPLY_MIGRATIONS=1 in gate-provision; locally it must be explicit.
  if [ "${GATE_APPLY_MIGRATIONS:-0}" != "1" ]; then
    gate_skip "migrations mutate the target DB + workspace — set GATE_APPLY_MIGRATIONS=1 to run locally (the sandbox sets it automatically)"
    return 77
  fi
  gate_require_db || return 77
  # Sub-second pre-flight: every file under db/migrations/ must carry the
  # runner directive before we even touch Postgres.
  local missing
  missing=$(grep -L '^-- migrate:up' db/migrations/*.sql || true)
  if [ -n "$missing" ]; then
    echo "::error::Migrations missing '-- migrate:up' directive:" >&2
    echo "$missing" >&2
    return 1
  fi
  echo "   (immutability + squawk lint are PR-diff gates and need git history — they run on GitHub CI)"
  # Raise maintenance_work_mem: the baseline ivfflat index needs ~150MB and
  # the default 64MB fails. Best-effort; if it truly can't raise, the apply
  # below fails loudly with the real error.
  if command -v psql >/dev/null 2>&1; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=0       -c "ALTER SYSTEM SET maintenance_work_mem='256MB'" -c "SELECT pg_reload_conf()" >/dev/null 2>&1 || true
  fi
  # Apply with the SAME runner production uses (scripts/migrate-up.mjs), NOT
  # dbmate up: migrate-up splits top-level statements so transaction:false
  # migrations with CREATE INDEX CONCURRENTLY apply outside a transaction.
  # Its only runtime dep is the postgres npm package; install it in a
  # scratch dir (npm can't install the workspace root) and expose it via a
  # top-level node_modules entry the ESM loader resolves.
  local tmp
  tmp="$(mktemp -d)"
  (cd "$tmp" && npm init -y >/dev/null && npm install --no-audit --no-fund postgres@^3.4.7 >/dev/null) || return 1
  mkdir -p node_modules || return 1
  cp -r "$tmp/node_modules/postgres" node_modules/postgres || return 1
  rm -rf "$tmp" || return 1
  node scripts/migrate-up.mjs || return 1
  # Ledger verify + pending-check contract (only with dbmate on PATH).
  if command -v dbmate >/dev/null 2>&1; then
    dbmate --migrations-dir db/migrations status || return 1
    local pending
    pending=$(dbmate --migrations-dir db/migrations status | grep -c '^\[ \]' || true)
    [ "$pending" = "0" ] || { echo "::error::$pending migrations still pending after migrate-up" >&2; return 1; }
    local pending_rc=0
    node scripts/migrate-up.mjs --check-pending || pending_rc=$? || return 1
    test "$pending_rc" -eq 3 || { echo "::error::--check-pending on a complete ledger returned $pending_rc, expected 3" >&2; return 1; }
    printf -- '-- migrate:up\nSELECT 1;\n' > db/migrations/99999999999999_pending_probe.sql || return 1
    pending_rc=0; node scripts/migrate-up.mjs --check-pending || pending_rc=$?
    rm db/migrations/99999999999999_pending_probe.sql || return 1
    test "$pending_rc" -eq 0 || { echo "::error::--check-pending with an unapplied migration returned $pending_rc, expected 0" >&2; return 1; }
  else
    echo "   (dbmate not on PATH — schema_migrations verify + pending-check contract skipped)"
  fi
  # glibc floor on committed pgvector prebuilts (needs docker).
  gate_require_docker || return 0
  for arch in linux-x64 linux-arm64; do
    packages/pgvector-embedded/scripts/assert-glibc-floor.sh "packages/pgvector-embedded/prebuilt/${arch}" || return 1
  done
  local out
  out=$(docker run --rm -v "$PWD:/w:ro" debian:bullseye ldd /w/packages/pgvector-embedded/prebuilt/linux-x64/vector.so 2>&1) || return 1
  echo "$out"
  if echo "$out" | grep -qi "not found"; then
    echo "::error::vector.so has unresolved dependencies on debian:bullseye (glibc 2.31)." >&2
    return 1
  fi
}

gate_sdk_cli_build() {
  make build-packages || return 1
  GATE_RAN_SDK_BUILD=1
}

gate_sdk_lifecycle_e2e() {
  bash scripts/sdk-e2e.sh || return 1
  GATE_RAN_SDK_LIFECYCLE=1
}

gate_sdk_error_taxonomy_e2e() {
  bash scripts/sdk-e2e-error.sh || return 1
  GATE_RAN_SDK_ERROR=1
}

gate_cli_command_smoke() {
  bash scripts/cli-smoke.sh || return 1
  GATE_RAN_CLI_SMOKE=1
}

gate_sdk_cli_e2e() {
  # ci.yml's sdk-cli-e2e is a needs: fan-in over the three deep smokes; mirror
  # that so the default job list does not run them twice. Local errexit means
  # a failure aborts THIS job only.
  set -e
  [ "$GATE_RAN_SDK_BUILD" -eq 1 ] || gate_sdk_cli_build
  [ "$GATE_RAN_SDK_LIFECYCLE" -eq 1 ] || gate_sdk_lifecycle_e2e
  [ "$GATE_RAN_SDK_ERROR" -eq 1 ] || gate_sdk_error_taxonomy_e2e
  [ "$GATE_RAN_CLI_SMOKE" -eq 1 ] || gate_cli_command_smoke
}

gate_dead_code_report() {
  # CI keeps this report non-blocking (continue-on-error) — keep parity.
  if ! bun run knip; then
    echo "   ⚠ dead-code report found issues (non-blocking, matches CI)"
  fi
}

gate_optional_smoke_filter() {
  gate_skip "optional-smoke-filter is a PR-diff gate against the base SHA — runs on GitHub CI"
}

gate_connector_parity_smoke() {
  gate_require_docker || return 77
  docker build -f docker/worker/Dockerfile -t lobu-worker:parity-smoke . || return 1
  local self_check rc=0
  self_check=$(docker run --rm --network=none lobu-worker:parity-smoke node dist/bin.js self-check --json) || rc=$?
  printf '%s\n' "$self_check"
  [ "$rc" -eq 0 ] || return 1
  # Mirrors ci.yml / build-images.yml: the image runs under Node so the isolate
  # lane's isolated-vm addon loads; a green self-check alone does not prove the
  # native build, so assert the lane explicitly.
  if ! printf '%s' "$self_check" | jq -e '.isolate_lane.available == true' >/dev/null; then
    echo "   ✗ worker image cannot load isolated-vm: $(printf '%s' "$self_check" | jq -c .isolate_lane)"
    return 1
  fi
  node packages/cli/bin/lobu.js connector runtime-self-check --json || return 1
}

# ── runner ─────────────────────────────────────────────────────────────────

gate_prepare() {
  echo ">> [prepare] build publishable packages (needed for tsc + unit resolution)..."
  # --skip-applications matches CI's unit job: the server bundle and the
  # Owletto SPA build only run in the jobs that actually consume them
  # (sdk-cli-build / frontend), keeping this step fast and low-risk.
  node scripts/build-packages.mjs --skip-applications
}

gate_run_job() {
  local job="$1" fn rc=0
  echo ""
  echo ">> job: $job"
  # bash function names cannot contain hyphens; ci.yml job names do.
  fn="${job//-/_}"
  # Bash-3.2-safe dispatch (macOS default /bin/bash): errexit suppression for
  # a function called in a condition (`f || rc=$?`) is broken on 3.2 — it
  # aborts at the first failing command. Toggling errexit around a DIRECT call
  # works on every bash; counters propagate because there is no subshell.
  set +e
  "gate_$fn"
  rc=$?
  set -e
  case "$rc" in
    0) GATE_PASS=$((GATE_PASS + 1)); echo "   ✓ $job" ;;
    77) echo "   → $job skipped (see summary)" ;;
    *) GATE_FAIL=$((GATE_FAIL + 1)); GATE_FAILED+=("$job"); echo "   ✗ $job" ;;
  esac
  return 0
}

gate_run() {
  local jobs=("$@")
  if [ "${#jobs[@]}" -eq 0 ]; then jobs=("${GATE_JOBS[@]}"); fi
  local unknown="" job
  for job in "${jobs[@]}"; do
    case " ${GATE_JOBS[*]} " in
      *" $job "*) ;;
      *) unknown="$unknown $job" ;;
    esac
  done
  if [ -n "$unknown" ]; then
    echo "unknown gate job(s):$unknown" >&2
    echo "known jobs: ${GATE_JOBS[*]}" >&2
    return 2
  fi
  gate_prepare
  local rc=0
  for job in "${jobs[@]}"; do
    gate_run_job "$job" || rc=1
  done
  echo ""
  echo "==== pr-full gate summary ===="
  echo "  pass:    $GATE_PASS"
  echo "  fail:    $GATE_FAIL"
  echo "  skipped: $GATE_SKIP"
  if [ "$GATE_FAIL" -gt 0 ]; then
    echo "  failed:  ${GATE_FAILED[*]}"
  fi
  if [ "$GATE_SKIP" -gt 0 ]; then
    echo "  skipped:"
    printf '    - %s\n' "${GATE_SKIPPED[@]}"
  fi
  [ "$GATE_FAIL" -eq 0 ]
}

# provision (Daytona sandbox only) — source gate-provision.sh when asked
if [ "${GATE_PROVISION:-0}" = "1" ]; then
  # shellcheck source=scripts/lib/gate-provision.sh
  . "$SCRIPT_DIR/gate-provision.sh"
  gate_provision
fi

gate_run "$@"
