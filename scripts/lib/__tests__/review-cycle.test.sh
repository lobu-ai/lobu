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
cp "$repo_root/Makefile" "$tmp/repo/"
cp "$repo_root/scripts/review.sh" "$repo_root/scripts/ui-review-agent.sh" "$tmp/repo/scripts/"
cp "$repo_root"/prompts/review-* "$repo_root"/prompts/ui-review-agent-* "$tmp/repo/prompts/"
cat > "$tmp/bin/gh" <<'CLI'
#!/usr/bin/env bash
case "$1 $2" in
  'auth status') exit 0 ;;
  'repo view') echo test/repo ;;
  'run list') echo "${TEST_CI_GREEN:-true}" ;;
  'pr view')
    [ -n "${TEST_PR:-}" ] || exit 1
    if [[ "$*" == *--jq* ]]; then echo "$TEST_PR"; else printf '{"number":%s,"url":"u"}\n' "$TEST_PR"; fi ;;
  'api -X')
    # Drain a piped body like the real gh does; exiting unread races the
    # writer into SIGPIPE, which pipefail turns into a spurious review failure.
    if [[ "$*" == *'--input -'* ]]; then cat > /dev/null; fi
    if [ "${TEST_STATUS_FAIL:-false}" = true ] && [[ "$*" == *state=success* ]]; then exit 1; fi
    printf '%s\n' "$*" >> "$TEST_STATE/statuses" ;;
  'api repos/'*'/comments') ;;
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
    decision|partial-decision)
      if [ "$SCENARIO" = partial-decision ]; then printf 'partial\n' > app.txt; fi
      printf '%s\n' '{"summary":"needs architecture decision","decisions":[{"kind":"architecture","finding":"contract change","question":"which contract?"}],"tests":[]}' > "$out"; exit ;;
    resume)
      [[ "$prompt" == *'Resolve the contract question using the existing contract.'* ]] || exit 9
      printf 'fixed\n' > app.txt ;;
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
if [ "$SCENARIO" = cap ] || { [ "$SCENARIO" != clean ] && [ "$SCENARIO" != optional ] && [ "$SCENARIO" != blocked ] && [[ "$value" != fixed* ]]; }; then bugs=1; fi
jq -n --argjson bugs "$bugs" --arg tree "$tree" '{decision:(if $bugs == 0 then "pass" else "changes_needed" end),findings:(if $bugs == 0 then [] else [{file:"app.txt",line:1,blocking:true,issue:"broken execution",evidence:"focused-test.sh fails on broken input"}] end),verification:{tree:$tree,checked:["fixture entrypoint"],missing:[]}}' > "$out"
case "$SCENARIO" in
  optional) jq '.findings=[{file:"app.txt",line:1,blocking:false,issue:"wording preference",evidence:"optional copy cleanup"}]' "$out" > "$out.tmp"; mv "$out.tmp" "$out" ;;
  blocked) jq '.decision="verification_blocked" | .verification.missing=["required focused probe unavailable"]' "$out" > "$out.tmp"; mv "$out.tmp" "$out" ;;
  stale) jq '.verification.tree="0000000000000000000000000000000000000000"' "$out" > "$out.tmp"; mv "$out.tmp" "$out" ;;
  contradictory) jq '.decision="pass"' "$out" > "$out.tmp"; mv "$out.tmp" "$out.tmp2"; mv "$out.tmp2" "$out" ;;
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
git add -- .gitignore app.txt focused-test.sh Makefile scripts prompts
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
# Semantic review starts before CI, and publication retries spend no tokens.
TEST_CI_GREEN=false run_case clean
[ "$rc" = 2 ] && [ "$(count reads)" = 1 ] && [ "$(count writes)" = 0 ] || fail 'review should run alongside CI'
no_success
bash scripts/review.sh > "$tmp/output" 2>&1 || fail 'saved review should publish after CI'
sed -n 's/^>> review run: //p' "$tmp/output" >> "$tmp/roots"
[ "$(count reads)" = 1 ] || fail 'CI publication retried the model'
TEST_STATUS_FAIL=true run_case clean
[ "$rc" = 1 ] && [ "$(count reads)" = 1 ] || fail 'status failure should retain the completed verdict'
no_success
bash scripts/review.sh > "$tmp/output" 2>&1 || fail 'status retry failed'
sed -n 's/^>> review run: //p' "$tmp/output" >> "$tmp/roots"
[ "$(count reads)" = 1 ] || fail 'status posting failure reran the model'
run_case optional
[ "$rc" = 0 ] && [ "$(count writes)" = 0 ] || fail 'optional suggestions must not reopen a passing review'
run_case blocked
[ "$rc" = 1 ] && [ "$(count writes)" = 0 ] || fail 'missing verification must hand off without speculative edits'
blocked_handoff="$(sed -n 's/^>> structured parent handoff: //p' "$tmp/output")"
printf 'The required probe is available now; verify the evidence again.\n' > "$tmp/instructions"
export SCENARIO=clean
blocked_rc=0
bash scripts/review.sh --resume "$blocked_handoff" --instructions "$tmp/instructions" > "$tmp/output" 2>&1 || blocked_rc=$?
sed -n 's/^>> review run: //p' "$tmp/output" >> "$tmp/roots"
[ "$blocked_rc" = 0 ] && [ "$(count reads)" = 2 ] && [ "$(count writes)" = 0 ] || fail 'new verification evidence reused the old blocked verdict'
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
cache_ci_rc=0
TEST_CI_GREEN=false bash scripts/review.sh > "$tmp/output" 2>&1 || cache_ci_rc=$?
sed -n 's/^>> review run: //p' "$tmp/output" >> "$tmp/roots"
[ "$cache_ci_rc" = 2 ] || fail 'cached verdict must still wait for CI on the new commit'
no_success
bash scripts/review.sh > "$tmp/output" 2>&1 || fail 'committed verified tree should pass'
sed -n 's/^>> review run: //p' "$tmp/output" >> "$tmp/roots"
[ "$(count reads)" = 2 ] || fail 'identical verified diff should reuse cache'
grep -q 'state=success' "$TEST_STATE/statuses" || fail 'verified commit status missing'
run_case cap
[ "$rc" = 1 ] && [ "$(count reads)" = 3 ] && [ "$(count writes)" = 2 ] || fail 'autofix did not stop at two writes'
no_success
# The budget survives both explicit resume and a plain new invocation.
cap_handoff="$(sed -n 's/^>> structured parent handoff: //p' "$tmp/output")"
printf 'Only fix the reported issue.\n' > "$tmp/instructions"
for args in plain resume; do
  retry_rc=0
  if [ "$args" = resume ]; then
    bash scripts/review.sh --resume "$cap_handoff" --instructions "$tmp/instructions" > "$tmp/retry" 2>&1 || retry_rc=$?
  else
    bash scripts/review.sh > "$tmp/retry" 2>&1 || retry_rc=$?
  fi
  sed -n 's/^>> review run: //p' "$tmp/retry" >> "$tmp/roots"
  [ "$retry_rc" = 1 ] && [ "$(count writes)" = 2 ] && [ "$(count reads)" = 3 ] || fail 'rerun/resume reset the budget or repeated the same review'
done
handoff autofix_limit
# A reused branch name (Release Please) is a new PR: it must not inherit the
# previous PR's spent budget, while the same PR keeps it.
TEST_PR=1 run_case cap
[ "$rc" = 1 ] && [ "$(count writes)" = 2 ] || fail 'PR-scoped cap did not stop at two writes'
pr_rc=0
TEST_PR=1 bash scripts/review.sh > "$tmp/output" 2>&1 || pr_rc=$?
sed -n 's/^>> review run: //p' "$tmp/output" >> "$tmp/roots"
[ "$pr_rc" = 1 ] && [ "$(count writes)" = 2 ] || fail 'same PR reset its budget'
pr_rc=0
TEST_PR=2 bash scripts/review.sh > "$tmp/output" 2>&1 || pr_rc=$?
sed -n 's/^>> review run: //p' "$tmp/output" >> "$tmp/roots"
[ "$(count writes)" -gt 2 ] || fail 'a new PR on a reused branch inherited the old budget'
grep -q 'not #2; starting a fresh cycle' "$tmp/output" || fail 'reused branch did not report the fresh cycle'
rm -rf "$(dirname "$(sed -n 's/^>> structured parent handoff: //p' "$tmp/output")")"
run_case decision
[ "$rc" = 1 ] && [ "$(count writes)" = 1 ] || fail 'decision did not stop writing'
no_success
# Resume must carry the parent's explicit decision into the write phase.
resume_handoff="$(sed -n 's/^>> structured parent handoff: //p' "$tmp/output")"
printf 'Resolve the contract question using the existing contract.\n' > "$tmp/instructions"
export SCENARIO=resume
before="$(count writes)"
resume_rc=0
bash scripts/review.sh --resume "$resume_handoff" > "$tmp/output" 2>&1 || resume_rc=$?
[ "$resume_rc" = 2 ] && [ "$(count writes)" = "$before" ] || fail 'resume requires explicit instructions'
resume_rc=0
bash scripts/review.sh --base HEAD --resume "$resume_handoff" --instructions "$tmp/instructions" > "$tmp/output" 2>&1 || resume_rc=$?
[ "$resume_rc" = 2 ] && [ "$(count writes)" = "$before" ] || fail 'resume must reject a different merge base'
git commit --allow-empty -qm concurrent-head
resume_rc=0
bash scripts/review.sh --resume "$resume_handoff" --instructions "$tmp/instructions" > "$tmp/output" 2>&1 || resume_rc=$?
[ "$resume_rc" = 2 ] && [ "$(count writes)" = "$before" ] || fail 'resume must reject a different HEAD'
git reset --hard -q "$head"
make review RESUME="$resume_handoff" INSTRUCTIONS="$tmp/instructions" > "$tmp/output" 2>&1 && fail 'resume must leave verified edits uncommitted'
sed -n 's/^>> review run: //p' "$tmp/output" >> "$tmp/roots"
[ "$(cat app.txt)" = fixed ] && [ "$(count writes)" = 2 ] && [ "$(count reads)" = 2 ] || fail 'resume must write from supplied findings then independently verify'
no_success
# Committing and rerunning is the only completion for a verified dirty tree.
verified_handoff="$(sed -n 's/^>> structured parent handoff: //p' "$tmp/output")"
resume_rc=0
bash scripts/review.sh --resume "$verified_handoff" --instructions "$tmp/instructions" > "$tmp/rejected" 2>&1 || resume_rc=$?
[ "$resume_rc" = 2 ] || fail 'needs_commit cannot resume a write'
handoff needs_commit
# A stale handoff cannot authorize a write against a different tree.
echo concurrent > app.txt
before="$(count writes)"
resume_rc=0
bash scripts/review.sh --resume "$resume_handoff" --instructions "$tmp/instructions" > "$tmp/output" 2>&1 || resume_rc=$?
[ "$resume_rc" = 2 ] && [ "$(count writes)" = "$before" ] || fail 'stale resume must fail before writing'
# A writer may leave partial edits before returning a decision. Resume must
# review that tree, then verify the completed fix instead of relabeling the
# old findings as a verdict on the partial tree.
run_case partial-decision
[ "$rc" = 1 ] && [ "$(cat app.txt)" = partial ] || fail 'partial decision fixture failed'
partial_handoff="$(sed -n 's/^>> structured parent handoff: //p' "$tmp/output")"
export SCENARIO=resume
partial_rc=0
bash scripts/review.sh --resume "$partial_handoff" --instructions "$tmp/instructions" > "$tmp/output" 2>&1 || partial_rc=$?
sed -n 's/^>> review run: //p' "$tmp/output" >> "$tmp/roots"
[ "$partial_rc" = 1 ] && [ "$(cat app.txt)" = fixed ] && [ "$(count reads)" = 3 ] && [ "$(count writes)" = 2 ] || fail 'partial decision resume did not verify both snapshots'
handoff needs_commit
run_case malformed
[ "$rc" = 1 ] && [ "$(count reads)" = 1 ] || fail 'malformed fixer output accepted'
no_success
handoff fixer_failed
run_case tests-fail
[ "$rc" = 1 ] && [ "$(count reads)" = 1 ] || fail 'failed tests must stop verification'
no_success
handoff focused_tests_failed_or_missing
for scenario in reviewer-error concurrent stale contradictory; do
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
