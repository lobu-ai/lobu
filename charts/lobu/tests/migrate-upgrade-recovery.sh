#!/bin/sh
set -eu

chart_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
orchestrator="$chart_dir/files/migrate-upgrade.sh"
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT

command_log="$test_dir/kubectl.log"
migration_log="$test_dir/migration.log"
cat >"$test_dir/kubectl" <<'KUBECTL'
#!/bin/sh
set -eu
if [ "${1:-}" = '--namespace' ]; then
  shift 2
fi
printf '%s\n' "$*" >>"$COMMAND_LOG"
case "$*" in
  "get deployment lobu-app --ignore-not-found --output jsonpath={.spec.replicas}")
    if [ "${FAIL_DEPLOYMENT_LOOKUP:-0}" -eq 1 ]; then
      exit 19
    fi
    printf '2'
    ;;
  "get deployment lobu-worker --ignore-not-found --output jsonpath={.spec.replicas}") printf '3' ;;
  get\ pods*)
    if [ "${FAIL_POD_LOOKUP:-0}" -eq 1 ]; then
      exit 17
    fi
    ;;
esac
KUBECTL
chmod +x "$test_dir/kubectl"

cat >"$test_dir/migrate" <<'MIGRATE'
#!/bin/sh
printf 'migrate\n' >>"$MIGRATION_LOG"
exit "${MIGRATION_EXIT_CODE:-0}"
MIGRATE
chmod +x "$test_dir/migrate"

pending_log="$test_dir/pending.log"
cat >"$test_dir/pending-check" <<'PENDING'
#!/bin/sh
printf 'pending-check\n' >>"$PENDING_LOG"
exit "${PENDING_EXIT_CODE:-0}"
PENDING
chmod +x "$test_dir/pending-check"
export MIGRATION_PENDING_CHECK="$test_dir/pending-check"
export PENDING_LOG="$pending_log"

set +e
COMMAND_LOG="$command_log" \
MIGRATION_LOG="$migration_log" \
KUBECTL_BIN="$test_dir/kubectl" \
NAMESPACE=lobu \
APP_DEPLOYMENT=lobu-app \
APP_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=api' \
WORKER_DEPLOYMENT=lobu-worker \
WORKER_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=worker' \
MIGRATION_EXIT_CODE=42 \
  sh "$orchestrator" "$test_dir/migrate"
failure_status=$?
set -e

test "$failure_status" -eq 42
grep -Fxq 'scale deployment lobu-app --replicas=0' "$command_log"
grep -Fxq 'scale deployment lobu-worker --replicas=0' "$command_log"
grep -Fxq 'scale deployment lobu-app --replicas=2' "$command_log"
grep -Fxq 'scale deployment lobu-worker --replicas=3' "$command_log"

: >"$command_log"
COMMAND_LOG="$command_log" \
MIGRATION_LOG="$migration_log" \
KUBECTL_BIN="$test_dir/kubectl" \
NAMESPACE=lobu \
APP_DEPLOYMENT=lobu-app \
APP_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=api' \
WORKER_DEPLOYMENT=lobu-worker \
WORKER_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=worker' \
MIGRATION_EXIT_CODE=0 \
  sh "$orchestrator" "$test_dir/migrate"

grep -Fxq 'scale deployment lobu-app --replicas=0' "$command_log"
grep -Fxq 'scale deployment lobu-worker --replicas=0' "$command_log"
if grep -Eq -- '--replicas=[23]$' "$command_log"; then
  echo 'successful migration unexpectedly restored old replicas' >&2
  exit 1
fi

: >"$command_log"
set +e
COMMAND_LOG="$command_log" \
MIGRATION_LOG="$migration_log" \
KUBECTL_BIN="$test_dir/kubectl" \
NAMESPACE=lobu \
APP_DEPLOYMENT=lobu-app \
APP_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=api' \
WORKER_DEPLOYMENT=lobu-worker \
WORKER_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=worker' \
FAIL_POD_LOOKUP=1 \
  sh "$orchestrator" "$test_dir/migrate"
lookup_status=$?
set -e

test "$lookup_status" -eq 17
grep -Fxq 'scale deployment lobu-app --replicas=2' "$command_log"
grep -Fxq 'scale deployment lobu-worker --replicas=3' "$command_log"

: >"$command_log"
: >"$migration_log"
set +e
COMMAND_LOG="$command_log" \
MIGRATION_LOG="$migration_log" \
KUBECTL_BIN="$test_dir/kubectl" \
NAMESPACE=lobu \
APP_DEPLOYMENT=lobu-app \
APP_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=api' \
WORKER_DEPLOYMENT=lobu-worker \
WORKER_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=worker' \
FAIL_DEPLOYMENT_LOOKUP=1 \
  sh "$orchestrator" "$test_dir/migrate"
lookup_status=$?
set -e

test "$lookup_status" -eq 19
test ! -s "$migration_log"
if grep -q '^scale deployment' "$command_log"; then
  echo 'deployment lookup failure unexpectedly scaled a deployment' >&2
  exit 1
fi

# A deploy that ships no schema change must not touch the running deployments:
# scaling the app to zero here is the 503 window with nothing to show for it.
: >"$command_log"
: >"$migration_log"
: >"$pending_log"
COMMAND_LOG="$command_log" \
MIGRATION_LOG="$migration_log" \
PENDING_LOG="$pending_log" \
KUBECTL_BIN="$test_dir/kubectl" \
NAMESPACE=lobu \
APP_DEPLOYMENT=lobu-app \
APP_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=api' \
WORKER_DEPLOYMENT=lobu-worker \
WORKER_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=worker' \
MIGRATION_PENDING_CHECK="$test_dir/pending-check" \
PENDING_EXIT_CODE=3 \
  sh "$orchestrator" "$test_dir/migrate"

if ! grep -Fxq 'pending-check' "$pending_log"; then
  echo 'orchestrator never consulted the pending-migration check' >&2
  exit 1
fi
grep -Fxq 'migrate' "$migration_log"
if [ -s "$command_log" ]; then
  echo 'no-pending-migration deploy unexpectedly ran kubectl:' >&2
  cat "$command_log" >&2
  exit 1
fi

# An inconclusive check must leave the healthy deployments alone.
for pending_code in 1 7 127 137 missing; do
  : >"$command_log"
  : >"$migration_log"
  check_command="$test_dir/pending-check"
  if [ "$pending_code" = missing ]; then
    check_command=''
    pending_code=1
  fi
  set +e
  COMMAND_LOG="$command_log" \
  MIGRATION_LOG="$migration_log" \
  PENDING_LOG="$pending_log" \
  KUBECTL_BIN="$test_dir/kubectl" \
  NAMESPACE=lobu \
  APP_DEPLOYMENT=lobu-app \
  APP_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=api' \
  WORKER_DEPLOYMENT=lobu-worker \
  WORKER_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=worker' \
  MIGRATION_PENDING_CHECK="$check_command" \
  PENDING_EXIT_CODE="$pending_code" \
    sh "$orchestrator" "$test_dir/migrate"
  check_status=$?
  set -e

  if [ "$check_status" -eq 0 ] || [ -s "$command_log" ] || [ -s "$migration_log" ]; then
    echo "failed pending check ($pending_code) unexpectedly proceeded with deployment" >&2
    exit 1
  fi
done

# A real pending migration still gets the full quiesce.
: >"$command_log"
: >"$migration_log"
COMMAND_LOG="$command_log" \
MIGRATION_LOG="$migration_log" \
PENDING_LOG="$pending_log" \
KUBECTL_BIN="$test_dir/kubectl" \
NAMESPACE=lobu \
APP_DEPLOYMENT=lobu-app \
APP_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=api' \
WORKER_DEPLOYMENT=lobu-worker \
WORKER_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=worker' \
MIGRATION_PENDING_CHECK="$test_dir/pending-check" \
PENDING_EXIT_CODE=0 \
  sh "$orchestrator" "$test_dir/migrate"

grep -Fxq 'scale deployment lobu-app --replicas=0' "$command_log"
grep -Fxq 'scale deployment lobu-worker --replicas=0' "$command_log"
grep -Fxq 'migrate' "$migration_log"

# Status 4: migrations are pending, but every one is marked backward-compatible.
# The old replicas keep serving across the migration, so nothing may be scaled.
: >"$command_log"
: >"$migration_log"
COMMAND_LOG="$command_log" \
MIGRATION_LOG="$migration_log" \
PENDING_LOG="$pending_log" \
KUBECTL_BIN="$test_dir/kubectl" \
NAMESPACE=lobu \
APP_DEPLOYMENT=lobu-app \
APP_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=api' \
WORKER_DEPLOYMENT=lobu-worker \
WORKER_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=worker' \
MIGRATION_PENDING_CHECK="$test_dir/pending-check" \
PENDING_EXIT_CODE=4 \
  sh "$orchestrator" "$test_dir/migrate"

grep -Fxq 'migrate' "$migration_log"
if [ -s "$command_log" ]; then
  echo 'backward-compatible migration unexpectedly ran kubectl:' >&2
  cat "$command_log" >&2
  exit 1
fi

echo 'migration upgrade failure recovery passed'
