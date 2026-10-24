#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "not ok - $*" >&2; exit 1; }
base="$(mktemp -d "${TMPDIR:-/tmp}/lobu-boat-test.XXXXXX")"
trap 'rm -rf "$base"' EXIT
mkdir -p "$base/repo/scripts/lib" "$base/bin" "$base/repo/packages/owletto"
cp "$SCRIPT_DIR/../../run-remote-ci.sh" "$base/repo/scripts/"
cp "$SCRIPT_DIR/../remote-ci.sh" "$base/repo/scripts/lib/"
printf 'exit 91\n' > "$base/repo/scripts/lib/gate-runner.sh"
printf 'staged\n' > "$base/repo/input.txt"
printf 'private local secret\n' > "$base/repo/.env"
printf '.env\n' > "$base/repo/.gitignore"
(cd "$base/repo"; git init -q; git add -- scripts input.txt .gitignore)
cat > "$base/bin/boat" <<'MOCK'
#!/usr/bin/env bash
case "$1" in
 status) exit "${BOAT_STATUS_RC:-0}" ;;
 run)
  if [ "${2:-}" = --help ]; then exit "${BOAT_HELP_RC:-0}"; fi
  printf '%s\n' "$@" > "$BOAT_CALL_LOG"
  while [ "$#" -gt 0 ]; do
   if [ "$1" = --push ]; then cp "$2/repo.tar.gz" "$BOAT_ARCHIVE"; fi
   shift
  done
  echo 'remote output'
  exit "${BOAT_RUN_RC:-0}" ;;
 *) exit 99 ;;
esac
MOCK
# Daytona must not run when Boat is present (including faulty Boat).
printf '#!/usr/bin/env bash\nexit 92\n' > "$base/bin/daytona"
chmod +x "$base/bin/boat" "$base/bin/daytona"
export PATH="$base/bin:$PATH" BOAT_CALL_LOG="$base/calls" BOAT_ARCHIVE="$base/tree.tar.gz"
runner="$base/repo/scripts/run-remote-ci.sh"
run_rc() { local rc=0; bash "$runner" "$@" > "$base/output" 2>&1 || rc=$?; echo "$rc"; }
export REMOTE_CI_PROVIDER=boat
[ "$(run_rc unit)" = 0 ] || fail "Boat success rejected: $(cat "$base/output")"
grep -qx -- '--no-env' "$BOAT_CALL_LOG" || fail 'account secrets not excluded'
grep -qx -- '2700' "$BOAT_CALL_LOG" || fail 'bounded timeout missing'
tar -tzf "$BOAT_ARCHIVE" | grep -q input.txt || fail 'staged files missing'
if tar -tzf "$BOAT_ARCHIVE" | grep -q '/.env$'; then fail 'ignored secrets uploaded'; fi
[ "$(tar -xOzf "$BOAT_ARCHIVE" ./input.txt)" = staged ] || fail 'wrong staged bytes'
export BOAT_RUN_RC=37
[ "$(run_rc unit)" = 37 ] || fail 'test failure exit lost'
export BOAT_RUN_RC=124
[ "$(run_rc unit)" = 124 ] || fail 'timeout exit lost'
unset BOAT_RUN_RC
export REMOTE_CI_PROVIDER=auto
[ "$(run_rc unit)" = 0 ] || fail 'auto did not prefer Boat'
export BOAT_STATUS_RC=1
[ "$(run_rc unit)" = 2 ] || fail 'faulty Boat fell through to another provider'
unset BOAT_STATUS_RC
export BOAT_HELP_RC=1
[ "$(run_rc unit)" = 2 ] || fail 'outdated Boat CLI accepted'
unset BOAT_HELP_RC
export REMOTE_CI_TIMEOUT_SECONDS=bad
[ "$(run_rc unit)" = 2 ] || fail 'invalid timeout accepted'
unset REMOTE_CI_TIMEOUT_SECONDS
export BOAT_TYPE=large BOAT_SNAPSHOT=synthetic-ci-base
[ "$(run_rc unit frontend)" = 0 ] || fail 'custom Boat run rejected'
grep -qx large "$BOAT_CALL_LOG" || fail 'custom size missing'
grep -qx synthetic-ci-base "$BOAT_CALL_LOG" || fail 'snapshot missing'
unset BOAT_TYPE BOAT_SNAPSHOT
[ "$(run_rc)" = 0 ] || fail 'default job graph rejected'
grep -q 'sdk-cli-e2e' "$BOAT_CALL_LOG" || fail 'default graph incomplete'
export REMOTE_CI_PROVIDER=depot
[ "$(run_rc unit)" = 2 ] || fail 'removed Depot provider accepted'
export REMOTE_CI_PROVIDER=boat
printf 'unstaged\n' >> "$base/repo/input.txt"
rm -f "$BOAT_CALL_LOG"
[ "$(run_rc unit)" != 0 ] || fail 'unstaged content accepted'
[ ! -e "$BOAT_CALL_LOG" ] || fail 'VM started for unsettled tree'
# The shared archive helper must use the gitlink in the index, not child HEAD.
(
 cd "$base/repo"
 git -C packages/owletto init -q
 printf 'pinned\n' > packages/owletto/version.txt
 git -C packages/owletto add -- version.txt
 git -C packages/owletto -c user.name=Fixture -c user.email=fixture@example.test commit -qm pinned
 git -c advice.addEmbeddedRepo=false add -- packages/owletto
 printf 'later\n' > packages/owletto/version.txt
 git -C packages/owletto add -- version.txt
 git -C packages/owletto -c user.name=Fixture -c user.email=fixture@example.test commit -qm later
 . scripts/lib/remote-ci.sh
 remote_ci_materialize "$base/pinned"
 [ "$(cat "$base/pinned/packages/owletto/version.txt")" = pinned ] || fail 'archive used child HEAD instead of indexed gitlink'
)
# Exercise auto fallback with a controlled PATH: no host-installed provider.
mkdir -p "$base/fallback-bin"
for tool in bash dirname git mkdir mktemp tar awk rm grep tail; do
 ln -s "$(command -v "$tool")" "$base/fallback-bin/$tool"
done
export REMOTE_CI_PROVIDER=auto
[ "$(PATH="$base/fallback-bin" run_rc unit)" = 91 ] || fail 'absent CLIs did not choose local'
if command -v jq >/dev/null; then
 ln -s "$(command -v jq)" "$base/fallback-bin/jq"
 cat > "$base/fallback-bin/daytona" <<'DAYTONA'
#!/usr/bin/env bash
[ "$1" = list ] && exit 0
exit 1
DAYTONA
 chmod +x "$base/fallback-bin/daytona"
 [ "$(PATH="$base/fallback-bin" GATE_SKIP_SETTLED_CHECK=1 run_rc unit)" = 1 ] || fail 'Daytona fallback did not fail on create'
 grep -q 'provider: daytona' "$base/output" || fail 'auto did not select available Daytona'
fi
echo 'ok - Boat dispatch, exact staged archive, secrets, failure and timeout guards'
