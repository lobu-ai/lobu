#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# shellcheck source=scripts/lib/review-reviewer.sh
. "$repo_root/scripts/lib/review-reviewer.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_auto_selected() {
  local expected="$1"
  shift
  local actual
  actual="$(
    unset CODEX_THREAD_ID CODEX_MANAGED_PACKAGE_ROOT CODEX_CI
    while [ $# -gt 0 ]; do
      export "${1?}"
      shift
    done
    review_select_reviewer auto
  )"
  [ "$actual" = "$expected" ] || fail "expected $expected, selected $actual"
}

assert_auto_selected codex
assert_auto_selected claude CODEX_THREAD_ID=thread-1
assert_auto_selected claude CODEX_MANAGED_PACKAGE_ROOT=/tmp/codex
assert_auto_selected claude CODEX_CI=1
assert_auto_selected codex CODEX_CI=0

[ "$(CODEX_THREAD_ID=thread-1 review_select_reviewer codex)" = "codex" ] ||
  fail "codex override was not honored"
[ "$(review_select_reviewer claude)" = "claude" ] ||
  fail "claude override was not honored"

if review_select_reviewer pi >/dev/null 2>&1; then
  fail "pi reviewer must not be selectable for the review gate"
fi

if review_select_reviewer invalid >/dev/null 2>&1; then
  fail "invalid reviewer override unexpectedly succeeded"
fi

for allowed_model in fable opus claude-opus-4-6 claude-opus-4-5-20251101; do
  review_validate_claude_model "$allowed_model" ||
    fail "allowed Claude reviewer model '$allowed_model' was rejected"
done

for rejected_model in "" sonnet claude-sonnet-4-6 haiku claude-haiku-4-5 arbitrary; do
  if review_validate_claude_model "$rejected_model" >/dev/null 2>&1; then
    fail "disallowed Claude reviewer model '$rejected_model' was accepted"
  fi
done

review_should_retry_inline 0 "" || fail "empty successful output did not request an inline retry"
review_should_retry_inline 0 $' \n\t' || fail "whitespace-only successful output did not request an inline retry"
if review_should_retry_inline 0 '{"ok":true}'; then
  fail "non-empty successful output requested an inline retry"
fi
if review_should_retry_inline 1 ""; then
  fail "failed reviewer requested an inline retry"
fi

failure_message="$(review_fail_closed_message codex "command not found on PATH")"
case "$failure_message" in
  *"Independent review could not be completed by 'codex'"*) ;;
  *) fail "fail-closed message does not name the selected reviewer" ;;
esac
case "$failure_message" in
  *"fails closed"*"will not fall back"*) ;;
  *) fail "fail-closed message does not explain fallback policy" ;;
esac
case "$failure_message" in
  *"REVIEWER_CLI=claude|codex"*) ;;
  *) fail "fail-closed message does not explain the explicit override" ;;
esac

review_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/review.sh"
grep -Fq 'CLAUDE_REVIEW_MODEL="${CLAUDE_REVIEW_MODEL:-fable}"' "$review_script" ||
  fail "Claude reviewer must default to the Fable model"

grep -Fq 'CODEX_REVIEW_MODEL="${CODEX_REVIEW_MODEL:-gpt-6-astra}"' "$review_script" ||
  fail "Codex reviewer must default to the gpt-6-astra model"

grep -Fq 'CODEX_REVIEW_EFFORT="${CODEX_REVIEW_EFFORT:-xhigh}"' "$review_script" ||
  fail "Codex reviewer must default to xhigh reasoning effort"

grep -Fq 'review_validate_claude_model "$CLAUDE_REVIEW_MODEL"' "$review_script" ||
  fail "review.sh must fail closed on disallowed Claude reviewer models"

schema_arg_count="$(grep -F -- '--json-schema "$(cat "$SCHEMA_FILE")"' "$review_script" | wc -l | tr -d ' ')"
[ "$schema_arg_count" -eq 1 ] ||
  fail "Claude reviewer must receive the verdict schema exactly once (inline path)"

grep -Fq '2> "$diagnostic_file"' "$review_script" ||
  fail "inline Codex reviewer stderr must be retained for fail-closed diagnostics"

# pi was removed from the review gate: no pi invocation or pi-specific model
# knobs may reappear in review.sh. The `pi-review` STATUS CONTEXT name is
# unrelated — branch protection requires that exact status label.
if grep -Eq 'pi -p|PI_REVIEW_MODEL|PI_REVIEW_PROVIDER' "$review_script"; then
  fail "pi reviewer must not reappear in review.sh"
fi

if grep -Eiq 'herdr|CLAUDE_REVIEW_HERDR' "$review_script"; then
  fail "review.sh must not reference Herdr (inline-only reviewer)"
fi

# review-fix.sh is the selector's other consumer (step 5 of "Ship a change").
# Unlike review.sh it posts no status, so when it was hard-wired to codex
# (`command -v codex || exit 1`) a codex outage silently skipped the whole
# fixer pass, with nothing anywhere to record that a quality pass never ran.
# Pin the structure that regressed: the shared selector, an invocation arm per
# CLI, the model allowlist, and the write tools that make the claude arm a
# fixer rather than a review whose findings go nowhere.
review_fix_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/review-fix.sh"
grep -Fq '. "$SCRIPT_DIR/lib/review-reviewer.sh"' "$review_fix_script" ||
  fail "review-fix.sh must source the shared reviewer lib"
grep -Fq '. "$SCRIPT_DIR/lib/review-skip.sh"' "$review_fix_script" ||
  fail "review-fix.sh must source the shared skip classifier"
grep -Fq 'review_classify_diff "$BASE_BRANCH" worktree' "$review_fix_script" ||
  fail "review-fix.sh must skip safe worktree diffs before selecting a reviewer"
grep -Fq 'FIXER_CLI="$(review_select_reviewer' "$review_fix_script" ||
  fail "review-fix.sh must pick its CLI through review_select_reviewer"
grep -Fq 'review_validate_claude_model "$CLAUDE_REVIEW_MODEL"' "$review_fix_script" ||
  fail "review-fix.sh must fail closed on disallowed Claude fixer models"
grep -Fq 'codex exec' "$review_fix_script" ||
  fail "review-fix.sh must keep its codex invocation arm"
grep -Fq 'claude -p' "$review_fix_script" ||
  fail "review-fix.sh must keep its claude invocation arm"
grep -Eq -- '--tools [^[:space:]]*Edit[^[:space:]]*Write' "$review_fix_script" ||
  fail "review-fix.sh claude arm must carry the Edit/Write tools that make it a fixer"
if grep -Eq 'pi -p|PI_REVIEW_MODEL|PI_REVIEW_PROVIDER' "$review_fix_script"; then
  fail "pi reviewer must not reappear in review-fix.sh"
fi
if grep -Fq 'command -v codex >/dev/null' "$review_fix_script"; then
  fail "review-fix.sh must not gate every run on codex being installed"
fi

echo "review reviewer selection tests passed"

# --- pi-review gate matrix -------------------------------------------------
# Extract the verdict→status block from review.sh and evaluate it directly, so
# the gate SET is asserted semantically rather than by grepping for a line.
# runtime_change_risk is reported in the headline but must never fail the
# status; every defect/quality axis must still fail it.
gate_block="$(sed -n '/^HEADLINE="bug_free /,/^fi$/p' "$review_script")"
[ -n "$gate_block" ] ||
  fail "could not extract the pi-review gate block from review.sh"

# usage: run_gate BUG_FREE BUGS SLOP SIMPLICITY TESTS_ADEQUATE RISK BLOCKERS
run_gate() {
  BUG_FREE="$1" BUGS="$2" SLOP="$3" SIMPLICITY="$4" TESTS_ADEQUATE="$5" \
  RISK="$6" BLOCKER_COUNT="$7" \
  PI_REVIEW_MIN_BUG_FREE=80 PI_REVIEW_MAX_SLOP=15 PI_REVIEW_MIN_SIMPLICITY=70 \
  bash -c "$gate_block"'
printf "%s|%s\n" "$STATUS_STATE" "$STATUS_DESCRIPTION"'
}

# A high-risk verdict that is otherwise clean must SUCCEED, and must still
# surface the tier in the description so a human can weigh it.
clean_high_risk="$(run_gate 88 0 0 95 true high 0)"
case "$clean_high_risk" in
  success\|*) ;;
  *) fail "high risk must not fail the status (got: $clean_high_risk)" ;;
esac
case "$clean_high_risk" in
  *"risk high"*) ;;
  *) fail "headline must report the risk tier (got: $clean_high_risk)" ;;
esac

# Every defect/quality axis must still gate. Guards the removal from widening
# past runtime_change_risk.
assert_gate_fails() {
  local label="$1" result="$2" expected="$3"
  case "$result" in
    failure\|*) ;;
    *) fail "$label must fail the status (got: $result)" ;;
  esac
  case "$result" in
    *"$expected"*) ;;
    *) fail "$label must report '$expected' (got: $result)" ;;
  esac
}

assert_gate_fails "low bug_free"   "$(run_gate 70 0 0 95 true none 0)"  "bug_free<80"
assert_gate_fails "bugs>0"         "$(run_gate 88 1 0 95 true none 0)"  "bugs>0"
assert_gate_fails "high slop"      "$(run_gate 88 0 20 95 true none 0)" "slop>15"
assert_gate_fails "low simplicity" "$(run_gate 88 0 0 50 true none 0)"  "simplicity<70"
assert_gate_fails "blockers"       "$(run_gate 88 0 0 95 true none 2)"  "blockers>0"
assert_gate_fails "tests"          "$(run_gate 88 0 0 95 false none 0)" "tests inadequate"
