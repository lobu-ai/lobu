#!/usr/bin/env bash
# ui-review-agent.sh <context-file> <out-file>
#
# Independent reviewer verdict on whether an Owletto pointer range has any
# user-visible UI surface. Called by ui-review.ts as an alternative to a
# hosted screenshot comparison, ONLY for a range that is not deploy-only.
# Reuses the same reviewer CLI selection as `make review` (scripts/review.sh)
# so this is the same independent-agent trust model, not self-attestation by
# whoever wrote the change.
#
# <context-file> is the caller-prepared prompt body: changed file list,
# unified diffs, and the source PR's own description (which carries its test
# plan). <out-file> receives the raw JSON verdict on success.
#
# Fails closed: any error, empty output, or a verdict that fails the schema
# leaves <out-file> unwritten and exits non-zero. The caller must then fall
# back to requiring a real ARTIFACT — never treat a failure here as "no UI
# surface" by default.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/review-reviewer.sh"

CONTEXT_FILE="${1:?usage: ui-review-agent.sh <context-file> <out-file>}"
OUT_FILE="${2:?usage: ui-review-agent.sh <context-file> <out-file>}"

REVIEWER_CLI="${REVIEWER_CLI:-auto}"
CLAUDE_REVIEW_MODEL="${CLAUDE_REVIEW_MODEL:-fable}"
CLAUDE_REVIEW_EFFORT="${CLAUDE_REVIEW_EFFORT:-high}"
CODEX_REVIEW_MODEL="${CODEX_REVIEW_MODEL:-gpt-6-astra}"
CODEX_REVIEW_EFFORT="${CODEX_REVIEW_EFFORT:-xhigh}"
SCHEMA_FILE="$SCRIPT_DIR/../prompts/ui-review-agent-output-schema.json"
PROMPT_FILE="$SCRIPT_DIR/../prompts/ui-review-agent-prompt.md"
SCHEMA_JQ='(.has_ui_surface | type == "boolean") and (.reasoning | type == "string" and length > 0) and (.verification_summary | type == "string" and length > 0)'

[ -f "$SCHEMA_FILE" ] || { echo "schema not found: $SCHEMA_FILE" >&2; exit 2; }
[ -f "$PROMPT_FILE" ] || { echo "prompt not found: $PROMPT_FILE" >&2; exit 2; }

REVIEWER_CLI_SELECTED="$(review_select_reviewer "$REVIEWER_CLI")"
if [ "$REVIEWER_CLI_SELECTED" = "claude" ]; then
  review_validate_claude_model "$CLAUDE_REVIEW_MODEL" || exit $?
fi
command -v "$REVIEWER_CLI_SELECTED" >/dev/null 2>&1 || {
  review_fail_closed_message "$REVIEWER_CLI_SELECTED" "command not found on PATH" >&2
  exit 2
}

FULL_PROMPT_FILE="$(mktemp /tmp/lobu-ui-review-agent-prompt.XXXXXX)"
trap 'rm -f "$FULL_PROMPT_FILE"' EXIT
cat "$PROMPT_FILE" "$CONTEXT_FILE" > "$FULL_PROMPT_FILE"
printf '\n\nEmit only the JSON verdict.\n' >> "$FULL_PROMPT_FILE"

RAW_FILE="$(mktemp /tmp/lobu-ui-review-agent-"${REVIEWER_CLI_SELECTED}".XXXXXX)"
DIAGNOSTIC_FILE="${RAW_FILE}.stderr"
trap 'rm -f "$FULL_PROMPT_FILE" "$RAW_FILE" "$DIAGNOSTIC_FILE"' EXIT

set +e
case "$REVIEWER_CLI_SELECTED" in
  claude)
    claude -p "$(cat "$FULL_PROMPT_FILE")" \
      --model "$CLAUDE_REVIEW_MODEL" \
      --effort "$CLAUDE_REVIEW_EFFORT" \
      --json-schema "$(cat "$SCHEMA_FILE")" \
      --output-format text \
      --no-session-persistence \
      --tools Read,Grep,LS \
      --permission-mode bypassPermissions < /dev/null > "$RAW_FILE" 2> "$DIAGNOSTIC_FILE"
    ;;
  codex)
    codex_args=(codex exec --sandbox read-only --output-schema "$SCHEMA_FILE" --output-last-message "$RAW_FILE" --ephemeral)
    [ -n "$CODEX_REVIEW_MODEL" ] && codex_args+=(--model "$CODEX_REVIEW_MODEL")
    [ -n "$CODEX_REVIEW_EFFORT" ] && codex_args+=(-c "model_reasoning_effort=\"$CODEX_REVIEW_EFFORT\"")
    "${codex_args[@]}" "$(cat "$FULL_PROMPT_FILE")" < /dev/null > /dev/null 2> "$DIAGNOSTIC_FILE"
    ;;
esac
REVIEWER_EXIT=$?
set -e

RAW="$(cat "$RAW_FILE" 2>/dev/null || true)"
if [ "$REVIEWER_EXIT" -ne 0 ]; then
  echo "ui-review-agent: reviewer '$REVIEWER_CLI_SELECTED' exited $REVIEWER_EXIT" >&2
  [ -s "$DIAGNOSTIC_FILE" ] && cat "$DIAGNOSTIC_FILE" >&2
  exit 1
fi
if [ -z "$(printf '%s' "$RAW" | tr -d '[:space:]')" ]; then
  echo "ui-review-agent: empty verdict from '$REVIEWER_CLI_SELECTED'" >&2
  exit 1
fi
if ! printf '%s' "$RAW" | jq -e "$SCHEMA_JQ" >/dev/null 2>&1; then
  echo "ui-review-agent: verdict failed schema check: $RAW" >&2
  exit 1
fi

printf '%s' "$RAW" | jq --arg reviewer "$REVIEWER_CLI_SELECTED" '. + {reviewer: $reviewer}' > "$OUT_FILE"
