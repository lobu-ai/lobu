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
# Model configuration is dotenv data, with explicit shell values taking priority.
config_dir="$(mktemp -d /tmp/lobu-review-config.XXXXXX)"
trap 'rm -rf "$config_dir"' EXIT
cat > "$config_dir/.env" <<'ENV'
CLAUDE_REVIEW_MODEL=fable
CODEX_REVIEW_MODEL=old-model
CLAUDE_REVIEW_EFFORT=high
UNRELATED_REVIEW_SECRET=never-export-this
ENV
cat > "$config_dir/.env.local" <<'ENV'
export CLAUDE_REVIEW_MODEL="claude-opus-5-5" # local override
CODEX_REVIEW_MODEL='gpt-6.1-sol'
CODEX_REVIEW_EFFORT=xhigh
REVIEWER_CLI=codex
ENV
(
  unset CLAUDE_REVIEW_MODEL CODEX_REVIEW_MODEL CLAUDE_REVIEW_EFFORT CODEX_REVIEW_EFFORT REVIEWER_CLI
  review_load_config "$config_dir"
  [ "$CLAUDE_REVIEW_MODEL" = claude-opus-5-5 ] || fail "local Claude model did not win"
  [ "$CODEX_REVIEW_MODEL" = gpt-6.1-sol ] || fail "local Codex model did not win"
  [ "$CLAUDE_REVIEW_EFFORT" = high ] || fail "base effort did not load"
  [ "$REVIEWER_CLI" = codex ] || fail "reviewer selection did not load"
  [ -z "${UNRELATED_REVIEW_SECRET+x}" ] || fail "unrelated secrets must not load"
  export CODEX_REVIEW_MODEL=shell-model CLAUDE_REVIEW_MODEL=opus
  review_load_config "$config_dir"
  [ "$CODEX_REVIEW_MODEL" = shell-model ] || fail "exported Codex value was overridden"
  [ "$CLAUDE_REVIEW_MODEL" = opus ] || fail "exported Claude value was overridden"
  export CODEX_REVIEW_MODEL=''
  review_load_config "$config_dir"
  review_require_model codex >/dev/null 2>&1 && fail "explicit empty model must fail closed"
  true
)
printf 'CODEX_REVIEW_MODEL=$(touch %s/executed)\n' "$config_dir" > "$config_dir/.env.local"
(
  unset CODEX_REVIEW_MODEL
  review_load_config "$config_dir"
  [ ! -e "$config_dir/executed" ] || fail "dotenv must not execute shell code"
)
rm -f "$config_dir/.env" "$config_dir/.env.local"
(
  unset CODEX_REVIEW_MODEL CLAUDE_REVIEW_MODEL
  review_load_config "$config_dir"
  review_require_model codex >/dev/null 2>&1 && fail "missing Codex configuration must fail closed"
  review_require_model claude >/dev/null 2>&1 && fail "missing Claude configuration must fail closed"
  true
)
rm -rf "$config_dir"
trap - EXIT

# Recover a completed verdict wrapped in prose/fences, including escaped quotes
# and braces inside evidence. Ambiguous multiple objects must fail closed.
parser_input='{"decision":"pass","evidence":"a \"quoted\" {value} and \\ path"}'
parsed="$(extract_json_verdict "Completed review:
\`\`\`json
$parser_input
\`\`\`")" || fail 'wrapped verdict was not recovered'
[ "$(printf '%s' "$parsed" | jq -c .)" = "$(printf '%s' "$parser_input" | jq -c .)" ] || fail 'escaped evidence was altered'
if extract_json_verdict '{} {}' >/dev/null 2>&1; then fail 'ambiguous verdicts accepted'; fi
if extract_json_verdict 'unfinished {' >/dev/null 2>&1; then fail 'malformed verdict accepted'; fi

# Submodule guard (review_refuse_submodule): both scripts must refuse a start
# inside a submodule checkout before touching GitHub or a reviewer CLI.
submodule_tmp="$(mktemp -d "${TMPDIR:-/tmp}/lobu-review-submodule-test.XXXXXX")"
trap 'rm -rf "$submodule_tmp"' EXIT
new_repo() {
  git init -q "$1"
  git -C "$1" config user.email t@t.t
  git -C "$1" config user.name t
  git -C "$1" commit -q --allow-empty -m base
}
new_repo "$submodule_tmp/child"
new_repo "$submodule_tmp/super"
git -C "$submodule_tmp/super" -c protocol.file.allow=always \
  submodule add -q "$submodule_tmp/child" packages/child
submodule_dir="$submodule_tmp/super/packages/child"

(cd "$submodule_tmp/super" && review_refuse_submodule) ||
  fail "a superproject checkout must be reviewable"
set +e
(cd "$submodule_dir" && review_refuse_submodule 2>/dev/null)
status=$?
set -e
[ "$status" -eq 2 ] || fail "a submodule checkout must be refused (exit $status)"

# Stub every external the scripts could reach, so a regressed guard fails this
# test instead of posting to GitHub or starting a reviewer.
stub_bin="$submodule_tmp/bin"
mkdir -p "$stub_bin"
for cmd in gh codex claude bb; do
  printf '#!/bin/sh\nexit 97\n' > "$stub_bin/$cmd"
  chmod +x "$stub_bin/$cmd"
done
for script in review.sh lib/review-write.sh; do
  set +e
  output="$(cd "$submodule_dir" && PATH="$stub_bin:$PATH" bash "$repo_root/scripts/$script" 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 2 ] || fail "$script inside a submodule must exit 2 (got $status: $output)"
  case "$output" in
    *"inside submodule"*) ;;
    *) fail "$script must say it refused a submodule (got: $output)" ;;
  esac
done

echo "review reviewer selection tests passed"
