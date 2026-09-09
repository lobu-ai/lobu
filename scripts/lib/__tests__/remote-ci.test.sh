#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/remote-ci.sh
. "$SCRIPT_DIR/../remote-ci.sh"

fail() {
  echo "not ok - $1" >&2
  exit 1
}

assert_eq() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

workflow_job() {
  local workflow="$1"
  local job="$2"
  awk -v header="  $job:" '
    $0 == header { found = 1 }
    found && $0 != header && $0 ~ /^  [[:alnum:]_-]+:$/ { exit }
    found { print }
  ' "$workflow"
}

# Pull the body of a job's `run: |` block out of the YAML the caller already
# extracted, so the tests below execute the real gate script instead of
# re-stating it. Both fan-ins are shaped the same way, so they share this.
job_run_script() {
  awk '
    /^        run: \|$/ { capture = 1; next }
    capture && /^          / { print; next }
    capture && NF { exit }
  ' <<<"$1"
}

run_id="$(printf 'Org: test\nRun: bj0453b334\nWaiting...\n' | remote_ci_extract_run_id)"
assert_eq "$run_id" "bj0453b334"

success='{
  "status":"finished",
  "workflows":[{"name":"CI","status":"finished","jobs":[
    {"job_key":"ci.yml:unit","status":"finished","attempts":[{"view_url":"https://example.test/unit"}]}
  ]}]
}'
remote_ci_status_succeeded <<<"$success" || fail "finished graph was rejected"
remote_ci_status_terminal <<<"$success" || fail "finished graph was not terminal"
assert_eq "$(remote_ci_status_summary <<<"$success")" "finished=1"

skipped_job="${success/\"finished\",\"attempts\"/\"skipped\",\"attempts\"}"
remote_ci_status_succeeded <<<"$skipped_job" || fail "skipped conditional job was rejected"
if remote_ci_print_failures <<<"$skipped_job" | grep -q 'job ci.yml:unit'; then
  fail "skipped conditional job was reported as a failure"
fi

for bad_status in failed running cancelled queued; do
  bad="${success/\"status\":\"finished\"/\"status\":\"$bad_status\"}"
  if remote_ci_status_succeeded <<<"$bad"; then
    fail "$bad_status graph was accepted"
  fi
  case "$bad_status" in
    failed|cancelled)
      remote_ci_status_terminal <<<"$bad" || fail "$bad_status graph was not terminal"
      ;;
    *)
      if remote_ci_status_terminal <<<"$bad"; then
        fail "$bad_status graph was terminal"
      fi
      ;;
  esac
done

failed_job='{
  "status":"finished",
  "workflows":[{"name":"CI","status":"finished","jobs":[
    {"job_key":"ci.yml:unit","status":"failed","attempts":[{"view_url":"https://example.test/unit"}]}
  ]}]
}'
if remote_ci_status_succeeded <<<"$failed_job"; then
  fail "failed job inside a finished run was accepted"
fi

empty='{"status":"finished","workflows":[]}'
if remote_ci_status_succeeded <<<"$empty"; then
  fail "empty graph was accepted"
fi

empty_workflow='{
  "status":"finished",
  "workflows":[
    {"name":"empty","status":"finished","jobs":[]},
    {"name":"other","status":"finished","jobs":[
      {"job_key":"ci.yml:unit","status":"finished","attempts":[]}
    ]}
  ]
}'
if remote_ci_status_succeeded <<<"$empty_workflow"; then
  fail "workflow without jobs was accepted"
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/lobu-remote-ci-test.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT
repo="$tmp_dir/repo"
mkdir -p "$repo"
(
  cd "$repo"
  git init -q
  printf 'tracked\n' > tracked.txt
  git add tracked.txt

  initial_tree="$(remote_ci_staged_tree)"
  [ -n "$initial_tree" ] || fail "staged tree was empty"

  printf 'new\n' > new.txt
  if remote_ci_require_no_untracked >/dev/null 2>&1; then
    fail "untracked file was accepted"
  fi
  if remote_ci_staged_tree >/dev/null 2>&1; then
    fail "tree with an untracked file was accepted"
  fi

  git add new.txt
  remote_ci_require_no_untracked || fail "staged new file was rejected"

  printf 'unstaged\n' >> tracked.txt
  if remote_ci_staged_tree >/dev/null 2>&1; then
    fail "tree with unstaged changes was accepted"
  fi

  git add tracked.txt
  settled_tree="$(remote_ci_staged_tree)"
  assert_eq "$settled_tree" "$(git write-tree)"
)

workflow="$SCRIPT_DIR/../../../.github/workflows/ci.yml"
sdk_build="$(workflow_job "$workflow" sdk-cli-build)"
[ -n "$sdk_build" ] || fail "sdk-cli-build job is missing"
grep -q 'tar -czf "\$RUNNER_TEMP/sdk-cli-distributions.tgz" packages/\*/dist' <<<"$sdk_build" ||
  fail "sdk-cli-build does not preserve package paths in its distribution artifact"
if grep -q '^    needs:' <<<"$sdk_build"; then
  fail "sdk-cli-build still waits for the merge graph"
fi
for smoke in sdk-lifecycle-e2e sdk-error-taxonomy-e2e cli-command-smoke; do
  block="$(workflow_job "$workflow" "$smoke")"
  [ -n "$block" ] || fail "$smoke job is missing"
  grep -q '^    needs: sdk-cli-build$' <<<"$block" || fail "$smoke does not reuse sdk-cli-build"
  grep -q 'tar -xzf "\$RUNNER_TEMP/sdk-cli-distributions/sdk-cli-distributions.tgz"' <<<"$block" ||
    fail "$smoke does not restore the built distributions"
done
sdk_gate="$(workflow_job "$workflow" sdk-cli-e2e)"
grep -q '^    needs: \[sdk-cli-build, sdk-lifecycle-e2e, sdk-error-taxonomy-e2e, cli-command-smoke\]$' <<<"$sdk_gate" ||
  fail "sdk-cli-e2e does not aggregate every deep smoke"
integration_gate="$(workflow_job "$workflow" integration)"
grep -q '^    needs: \[check-author, paths, server-integration-vitest, server-integration-bun\]$' <<<"$integration_gate" ||
  fail "integration fan-in does not gate on check-author/paths"
# The fan-in decision is pure shell over the `needs.*.result` strings, so it can
# be EXECUTED rather than pattern-matched. A grep only proves the text is
# present; running the real script from the workflow proves the decision. The
# result vocabulary is GitHub's: success | failure | cancelled | skipped.
integration_gate_script="$(job_run_script "$integration_gate")"
[ -n "$integration_gate_script" ] || fail "could not extract the integration fan-in script"

# author paths packages vitest bun -> pass|fail
gate_verdict() {
  if AUTHOR_RESULT="$1" PATHS_RESULT="$2" PACKAGES_CHANGED="$3" \
     VITEST_RESULT="$4" BUN_RESULT="$5" \
     bash -e -c "$integration_gate_script" >/dev/null 2>&1; then
    echo pass
  else
    echo fail
  fi
}

assert_gate() {
  local expected="$1"; shift
  local got
  got="$(gate_verdict "$@")"
  [ "$got" = "$expected" ] ||
    fail "integration fan-in: author=$1 paths=$2 packages=$3 vitest=$4 bun=$5 -> $got, wanted $expected"
}

# Everything green passes, whether or not runtime paths changed.
assert_gate pass success success true success success
assert_gate pass success success false success success
# THE REGRESSION: a shard reports `skipped` when its own dependency broke. With
# packages=true that is a broken gate, not an unaffected PR, and must be red.
assert_gate fail success success true skipped success
assert_gate fail success success true success skipped
assert_gate fail success success true skipped skipped
# ...but a genuinely unaffected PR still passes on skipped shards.
assert_gate pass success success false skipped skipped
# An unset `packages` output is not the string "true", so it reads as unaffected.
assert_gate pass success success "" skipped skipped
# A gate job that did not succeed is fatal however it ended — this is the hole
# `check-author`/`paths` were added to `needs` to close.
assert_gate fail failure success true success success
assert_gate fail skipped success true success success
assert_gate fail cancelled success true success success
assert_gate fail success failure true success success
assert_gate fail success skipped true success success
assert_gate fail success cancelled false skipped skipped
# `cancelled` is not `skipped`: it never gets the unaffected-PR exemption.
assert_gate fail success success false cancelled success
assert_gate fail success success false success cancelled
# An outright shard failure is red regardless of the paths filter.
assert_gate fail success success false failure success
assert_gate fail success success true failure failure
# Same treatment for the SDK fan-in: execute it, don't pattern-match it. None of
# these jobs has a paths filter, so `skipped` can only mean a broken upstream —
# there is no unaffected-PR exemption to carve out here.
sdk_gate_script="$(job_run_script "$sdk_gate")"
[ -n "$sdk_gate_script" ] || fail "could not extract the sdk-cli-e2e gate script"

sdk_gate_verdict() {
  if BUILD_RESULT="$1" SDK_RESULT="$2" ERROR_TAXONOMY_RESULT="$3" CLI_RESULT="$4" \
     bash -e -c "$sdk_gate_script" >/dev/null 2>&1; then
    echo pass
  else
    echo fail
  fi
}

assert_sdk_gate() {
  local expected="$1"; shift
  local got
  got="$(sdk_gate_verdict "$@")"
  [ "$got" = "$expected" ] ||
    fail "sdk-cli-e2e: build=$1 sdk=$2 taxonomy=$3 cli=$4 -> $got, wanted $expected"
}

assert_sdk_gate pass success success success success
# A skipped smoke means sdk-cli-build broke underneath it — never green.
assert_sdk_gate fail success skipped success success
assert_sdk_gate fail success success skipped success
assert_sdk_gate fail success success success skipped
assert_sdk_gate fail skipped skipped skipped skipped
assert_sdk_gate fail failure skipped skipped skipped
assert_sdk_gate fail success cancelled success success
assert_sdk_gate fail success failure success success
dead_code="$(workflow_job "$workflow" dead-code-report)"
[ -n "$dead_code" ] || fail "advisory dead-code report was dropped during SDK fan-out"
grep -q '^    needs: \[unit, frontend, integration, format-lint, typecheck, migrations\]$' <<<"$dead_code" ||
  fail "advisory dead-code report does not retain its post-gate scheduling"
optional_filter="$(workflow_job "$workflow" optional-smoke-filter)"
if grep -q '^    needs:' <<<"$optional_filter"; then
  fail "optional smoke filter still waits for the merge graph"
fi
for mac_input in 'packages/cli/' 'config/macos/lobu-auth\.entitlements' 'build-mac-auth-cli'; do
  grep -Fq "$mac_input" <<<"$optional_filter" ||
    fail "optional Mac smoke filter omits auth-helper input: $mac_input"
done
vitest_job="$(workflow_job "$workflow" server-integration-vitest)"
grep -q -- '--shard=${{ matrix.shard }}/3' <<<"$vitest_job" ||
  fail "static isolated Vitest shard is missing"
if grep -q 'depot/tests-run-action' <<<"$vitest_job"; then
  fail "timing regrouping is unsafe for the order-sensitive shared-DB suite"
fi


# ── provider dispatch (scripts/run-remote-ci.sh) ──────────────────────────
# The dispatcher is exercised with a mocked daytona binary so no sandbox is
# ever provisioned. A settled (staged, no untracked) tree is required first.

( cd "$repo"
  if REMOTE_CI_PROVIDER=bogus bash "$SCRIPT_DIR/../../run-remote-ci.sh" unit >/dev/null 2>&1; then
    fail "unknown provider was accepted"
  fi

  if REMOTE_CI_PROVIDER=local bash "$SCRIPT_DIR/../../run-remote-ci.sh" nosuchjob >/dev/null 2>&1; then
    fail "unknown job in the local fallback was accepted"
  fi

  # Mocked daytona: list succeeds (logged in), create records its args then
  # fails. Auto-detection must pick daytona, pass memory in GB, and fail
  # closed when create fails.
  tmpbin="$(mktemp -d "${TMPDIR:-/tmp}/lobu-remote-ci-bin.XXXXXX")"
  cat > "$tmpbin/daytona" <<'MOCK'
#!/usr/bin/env bash
case "$1" in
  list) exit 0 ;;
  create)
    printf '%s\n' "$@" > "${DAYTONA_CALL_LOG:?}"
    exit 1
    ;;
  *) exit 1 ;;
esac
MOCK
  chmod +x "$tmpbin/daytona"
  call_log="$(mktemp "${TMPDIR:-/tmp}/lobu-daytona-call.XXXXXX")"
  if PATH="$tmpbin:$PATH" DAYTONA_CALL_LOG="$call_log" GATE_SKIP_SETTLED_CHECK=1 \
      bash "$SCRIPT_DIR/../../run-remote-ci.sh" unit >/dev/null 2>&1; then
    fail "mocked daytona create failure was accepted"
  fi
  grep -q -- '--memory' "$call_log" || fail "daytona create was not invoked"
  # Each arg is on its own line in the log; join before matching.
  flat="$(tr '\n' ' ' < "$call_log")"
  grep -q -- '--memory 4 ' <<<"$flat" ||
    fail "daytona create must pass memory in GB (default 4), got: $flat"
  grep -q -- '--cpu 4 ' <<<"$flat" || fail "daytona create must pass the default cpu"
  grep -q -- '--disk 10 ' <<<"$flat" || fail "daytona create must pass the default disk"
  rm -rf "$tmpbin" "$call_log"

  # Tri-state provider resolution. A present-but-faulty CLI (list fails, i.e.
  # not logged in) must fail closed under `auto` rather than silently falling
  # back to local — that masking is the regression this guards against.
  mkdir -p "$tmpbin"
  cat > "$tmpbin/daytona" <<'MOCK_FAULTY'
#!/usr/bin/env bash
exit 1
MOCK_FAULTY
  chmod +x "$tmpbin/daytona"
  if PATH="$tmpbin:$PATH" REMOTE_CI_PROVIDER=auto GATE_SKIP_SETTLED_CHECK=1 \
      bash "$SCRIPT_DIR/../../run-remote-ci.sh" unit 2>/dev/null; then
    fail "faulty (not logged in) daytona CLI was accepted under auto"
  fi
  out="$(PATH="$tmpbin:$PATH" REMOTE_CI_PROVIDER=auto GATE_SKIP_SETTLED_CHECK=1 \
      bash "$SCRIPT_DIR/../../run-remote-ci.sh" unit 2>&1 || true)"
  case "$out" in
    *"refusing to silently"*) ;;
    *) fail "faulty CLI did not fail closed with a clear message: $out" ;;
  esac
  rm -rf "$tmpbin"

  # Mocked SUCCESSFUL daytona lifecycle: create stores the generated name,
  # list reports it started (poll passes), exec emits the GATE_REMOTE_EXIT
  # sentinel, delete is called. Exercises polling, sentinel parsing, cleanup.
  # (The create-failure block above removed $tmpbin, so recreate it. The
  # dispatcher invokes `daytona`, so the success mock must replace it.)
  mkdir -p "$tmpbin"
  cat > "$tmpbin/daytona" <<'MOCK2'
#!/usr/bin/env bash
case "$1" in
  list)
    # Readiness probe runs BEFORE create (name file empty): must still exit 0.
    # After create stores the name, report it started so the poll passes.
    name="$(cat "${DAYTONA_NAME_FILE:-/dev/null}" 2>/dev/null || true)"
    if [ -n "$name" ]; then
      printf '{"items":[{"name":"%s","state":"started"}]}\n' "$name"
    else
      printf '{"items":[]}\n'
    fi
    exit 0
    ;;
  create)
    name=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--name" ]; then name="$2"; break; fi
      shift
    done
    printf '%s' "$name" > "${DAYTONA_NAME_FILE:?}"
    exit 0
    ;;
  exec)
    echo "GATE_REMOTE_EXIT=0"
    exit 0
    ;;
  delete)
    echo deleted > "${DAYTONA_DELETE_FLAG:?}"
    exit 0
    ;;
  *) exit 1 ;;
esac
MOCK2
  chmod +x "$tmpbin/daytona"
  name_file="$(mktemp "${TMPDIR:-/tmp}/lobu-daytona-name.XXXXXX")"
  del_flag="$(mktemp "${TMPDIR:-/tmp}/lobu-daytona-del.XXXXXX")"
  if ! PATH="$tmpbin:$PATH" DAYTONA_NAME_FILE="$name_file" DAYTONA_DELETE_FLAG="$del_flag" \
      GATE_SKIP_SETTLED_CHECK=1 bash "$SCRIPT_DIR/../../run-remote-ci.sh" dead-code-report >/dev/null 2>&1; then
    fail "mocked successful daytona run was rejected"
  fi
  # The success path also proves the GATE_REMOTE_EXIT sentinel was parsed:
  # the dispatcher reported "remote gate exit: 0" (checked via the flag).
  [ -s "$del_flag" ] || fail "cleanup did not call daytona delete"
  rm -f "$name_file" "$del_flag"
)

echo "ok - remote CI helpers fail closed"
