#!/usr/bin/env bash
# Drive the real review/fix entrypoints against a disposable Git repository.
# Provider and GitHub boundaries are local shims: no paid sessions or posts.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmp="$(mktemp -d /tmp/lobu-review-cycle-test.XXXXXX)"
cleanup() {
  if [ -f "$tmp/roots" ]; then
    while IFS= read -r root; do
      case "$root" in /tmp/lobu-review.*) rm -rf "$root" ;; esac
    done < "$tmp/roots"
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; cat "$tmp/output" >&2; exit 1; }
mkdir -p "$tmp/repo/scripts/lib" "$tmp/repo/prompts" "$tmp/bin" "$tmp/state"
cp "$repo_root"/scripts/lib/review-*.sh "$tmp/repo/scripts/lib/"
cp "$repo_root/scripts/lib/review-process-supervisor.py" "$tmp/repo/scripts/lib/"
cp "$repo_root/scripts/review.sh" "$repo_root/scripts/review-fix.sh" "$repo_root/scripts/ui-review-agent.sh" "$tmp/repo/scripts/"
cp "$repo_root"/prompts/review-* "$repo_root"/prompts/ui-review-agent-* "$tmp/repo/prompts/"
cat > "$tmp/bin/gh" <<'CLI'
#!/usr/bin/env bash
case "$1 $2" in
  'auth status') exit 0 ;;
  'repo view') echo test/repo ;;
  'run list') echo true ;;
  'pr view') exit 1 ;;
  'api -X') printf '%s\n' "$*" >> "$TEST_STATE/statuses" ;;
  'api '*) echo 'unit: completed success' ;;
esac
CLI
cat > "$tmp/bin/codex" <<'CLI'
#!/usr/bin/env bash
set -euo pipefail
mode='' out='' schema='' model=''
while [ $# -gt 0 ]; do
  case "$1" in
    --sandbox) mode="$2"; shift 2 ;;
    --model) model="$2"; shift 2 ;;
    --output-schema) schema="$2"; shift 2 ;;
    --output-last-message) out="$2"; shift 2 ;;
    *) prompt="$1"; shift ;;
  esac
done
[ "$model" = "${EXPECTED_REVIEW_MODEL:-gpt-6.1-sol}" ]
case "$schema" in
  *ui-review-agent*) printf '%s\n' '{"has_ui_surface":false,"reasoning":"fixture","verification_summary":"checked fixture"}' > "$out"; exit ;;
esac
printf '%s\n' "$mode" >> "$TEST_STATE/phases"
if [ "$mode" = workspace-write ]; then
  printf 'write\n' >> "$TEST_STATE/writes"
  case "$SCENARIO" in
    decision)
      printf '%s\n' '{"summary":"needs architecture decision","decisions":[{"kind":"architecture","finding":"contract change","question":"which contract?"}],"tests":[]}' > "$out"; exit ;;
    malformed) echo invalid > "$out"; exit ;;
    cap) printf 'fixed-%s\n' "$(wc -l < "$TEST_STATE/writes" | tr -d ' ')" > app.txt ;;
    *) printf 'fixed\n' > app.txt ;;
  esac
  passed=true
  bash focused-test.sh || passed=false
  [ "$SCENARIO" != tests-fail ] || passed=false
  jq -n --argjson passed "$passed" '{summary:"safe fix",decisions:[],tests:[{command:"bash focused-test.sh",passed:$passed}]}' > "$out"
  exit
fi
printf 'read\n' >> "$TEST_STATE/reads"
# Exercise the immutable snapshot the real driver told this reviewer to read.
tree="$(printf '%s\n' "$prompt" | sed -n 's/^Review target tree: \([0-9a-f]*\).*/\1/p')"
[ -n "$tree" ]
# The rendered diff command from the real prompt must run as written.
range="$(printf '%s\n' "$prompt" | sed -n 's/^git diff --stat //p' | head -n1)"
# shellcheck disable=SC2086 # split exactly as the reviewer's shell would
git diff --stat $range | grep -q app.txt
value="$(git show "$tree:app.txt")"
[ "$value" = "$(cat app.txt)" ]
bugs=0
if [ "$SCENARIO" = cap ] || { [ "$SCENARIO" != clean ] && [ "$value" = broken ]; }; then bugs=1; fi
jq -n --argjson bugs "$bugs" '{bug_free_confidence:90,bugs:$bugs,slop:0,simplicity:90,blockers:[],change_type:"fix",runtime_change_risk:"low",tests_adequate:true,suggested_fixes:[],notes:"fixture evidence",categories:{}}' > "$out"
case "$SCENARIO" in
  reviewer-error) exit 7 ;;
  concurrent) echo concurrent > app.txt ;;
esac
CLI
chmod +x "$tmp/bin/gh" "$tmp/bin/codex"
export TEST_STATE="$tmp/state" PATH="$tmp/bin:$PATH"
unset BB_THREAD_ID BB_ENVIRONMENT_ID CLAUDE_REVIEW_MODEL CODEX_REVIEW_MODEL REVIEWER_CLI REVIEW_MAX_AUTOFIX_PASSES
export REVIEW_CACHE_ROOT_FOR_TESTS="$tmp/cache" REVIEW_LOCK_ROOT_FOR_TESTS="$tmp/locks"
export REVIEWER_MODE=full
cd "$tmp/repo"
git init -qb main
git config user.name test
git config user.email test@example.invalid
printf '.env*\n' > .gitignore
printf 'base\n' > app.txt
printf '#!/bin/bash\n[[ "$(cat app.txt)" == fixed* ]]\n' > focused-test.sh
git add -- .gitignore app.txt focused-test.sh scripts prompts
git commit -qm base
git switch -qc task
printf 'broken\n' > app.txt
git add -- app.txt
git commit -qm broken
head="$(git rev-parse HEAD)"
printf 'CLAUDE_REVIEW_MODEL=opus\nCODEX_REVIEW_MODEL=old\n' > .env
printf 'CODEX_REVIEW_MODEL=gpt-6.1-sol\nREVIEWER_CLI=codex\n' > .env.local

run_case() {
  export SCENARIO="$1"
  git reset --hard -q "$head"
  rm -rf "$tmp/cache"
  : > "$TEST_STATE/phases"; : > "$TEST_STATE/reads"; : > "$TEST_STATE/writes"; : > "$TEST_STATE/statuses"
  rc=0
  bash scripts/review.sh > "$tmp/output" 2>&1 || rc=$?
  sed -n 's/^>> review run: //p' "$tmp/output" >> "$tmp/roots"
}
count() { wc -l < "$TEST_STATE/$1" | tr -d ' '; }
no_success() { ! grep -q 'state=success' "$TEST_STATE/statuses" || fail "$SCENARIO posted false success"; }
handoff() {
  local file
  file="$(sed -n 's/^>> structured parent handoff: //p' "$tmp/output")"
  [ -s "$file" ] || fail "$SCENARIO missing structured handoff"
  jq -e --arg reason "$1" '.reason == $reason' "$file" >/dev/null || fail "$SCENARIO wrong handoff"
  # Remove only this fixture run's persisted transcripts.
  rm -rf "$(dirname "$file")"
}
# The UI entrypoint uses the same env-file loading and exported override rules.
printf 'fixture context\n' > "$tmp/context"
bash scripts/ui-review-agent.sh "$tmp/context" "$tmp/ui.json" > "$tmp/output" 2>&1 || fail 'UI reviewer env-file model did not load'
jq -e '.reviewer == "codex" and .has_ui_surface == false' "$tmp/ui.json" >/dev/null || fail 'UI reviewer did not return a verdict'
EXPECTED_REVIEW_MODEL=exported-sol CODEX_REVIEW_MODEL=exported-sol \
  bash scripts/ui-review-agent.sh "$tmp/context" "$tmp/ui.json" > "$tmp/output" 2>&1 || fail 'UI reviewer exported model was overridden'
run_case clean
[ "$rc" = 0 ] && [ "$(count reads)" = 1 ] && [ "$(count writes)" = 0 ] || fail 'clean review failed'
grep -q 'state=success' "$TEST_STATE/statuses" || fail 'clean status not posted'
run_case fix
[ "$rc" = 1 ] && [ "$(count reads)" = 2 ] && [ "$(count writes)" = 1 ] || fail 'fix must have fresh verification'
[ "$(cat app.txt)" = fixed ] || fail 'fix not applied'
no_success
handoff needs_commit
# The exact verified content is reusable after commit, without another paid pass.
git add -- app.txt
git commit -qm fixed
bash scripts/review.sh > "$tmp/output" 2>&1 || fail 'committed verified tree should pass'
sed -n 's/^>> review run: //p' "$tmp/output" >> "$tmp/roots"
[ "$(count reads)" = 2 ] || fail 'identical verified diff should reuse cache'
grep -q 'state=success' "$TEST_STATE/statuses" || fail 'verified commit status missing'
run_case cap
[ "$rc" = 1 ] && [ "$(count reads)" = 3 ] && [ "$(count writes)" = 2 ] || fail 'autofix did not stop at two writes'
no_success
handoff autofix_limit
run_case decision
[ "$rc" = 1 ] && [ "$(count writes)" = 1 ] || fail 'decision did not stop writing'
no_success
handoff needs_decision
run_case malformed
[ "$rc" = 1 ] && [ "$(count reads)" = 1 ] || fail 'malformed fixer output accepted'
no_success
handoff fixer_failed
run_case tests-fail
[ "$rc" = 1 ] && [ "$(count reads)" = 1 ] || fail 'failed tests must stop verification'
no_success
handoff focused_tests_failed_or_missing
for scenario in reviewer-error concurrent; do
  run_case "$scenario"
  [ "$rc" = 1 ] && [ "$(count writes)" = 0 ] || fail "$scenario must reject verdict"
  no_success
done
REVIEW_MAX_AUTOFIX_PASSES=0 run_case cap
[ "$rc" = 1 ] && [ "$(count writes)" = 0 ] || fail 'zero write cap ignored'
handoff autofix_limit
REVIEW_MAX_AUTOFIX_PASSES=3 run_case clean
[ "$rc" = 2 ] && [ "$(count reads)" = 0 ] || fail 'invalid write cap accepted'
echo 'review cycle tests passed'
