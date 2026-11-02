#!/usr/bin/env bash
# Internal write phase for make review. Requires findings and a result path.
# Never commits, pushes, or posts; make review independently verifies edits.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/review-reviewer.sh
. "$SCRIPT_DIR/review-reviewer.sh"
# shellcheck source=scripts/lib/review-bb.sh
. "$SCRIPT_DIR/review-bb.sh"

# Checked in the caller's directory: the cd below would hide a submodule start.
review_refuse_submodule || exit 2
cd "$SCRIPT_DIR/../.."
review_load_config "$(pwd)"

review_fix_bb_cleanup() {
  review_bb_cancel_owned
  [ -z "${bounded_prompt:-}" ] || rm -f "$bounded_prompt"
}
trap review_fix_bb_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

usage() {
  echo "usage: internal review write phase: --base <branch> --findings <json> --result <json>" >&2
  exit 2
}

BASE_BRANCH="${BASE:-}"
FINDINGS_FILE=""
REVIEW_FIX_RESULT_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --findings) [ $# -ge 2 ] || usage; FINDINGS_FILE="$2"; shift 2 ;;
    --result) [ $# -ge 2 ] || usage; REVIEW_FIX_RESULT_FILE="$2"; shift 2 ;;
    --base) [ $# -ge 2 ] || usage; BASE_BRANCH="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$FINDINGS_FILE" ] && [ -n "$REVIEW_FIX_RESULT_FILE" ] || usage
if [ -z "$BASE_BRANCH" ]; then
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    BASE_BRANCH="origin/main"
  else
    BASE_BRANCH="main"
  fi
fi

git rev-parse --verify --quiet "$BASE_BRANCH^{commit}" >/dev/null \
  || { echo ">> invalid base ref '$BASE_BRANCH'" >&2; exit 2; }
git merge-base "$BASE_BRANCH" HEAD >/dev/null 2>&1 \
  || { echo ">> no merge base between '$BASE_BRANCH' and HEAD" >&2; exit 2; }

jq -e 'type == "object"' "$FINDINGS_FILE" >/dev/null 2>&1 ||
  { echo "--findings must be a JSON object: $FINDINGS_FILE" >&2; exit 2; }
bounded_prompt="$(mktemp /tmp/lobu-review-write-prompt.XXXXXX)"
cat > "$bounded_prompt" <<'PROMPT'

You are the internal write phase of make review. Follow repository instructions.

Fix ONLY supplied blocking findings whose correction is clear and supported by evidence. If uncertain,
return a decision instead of guessing. The JSON may include explicit parent
instructions resolving prior decisions; follow them within repository rules.
Run focused tests for edits. Do not make product, architecture, API/SDK/DB,
or credential decisions yourself. Return those
to the parent; never request credentials or broaden scope yourself. Do not
run review drivers, spawn agents, commit, push, or post statuses.
Emit exactly one JSON object, without fences or prose:
{"summary":"what changed","decisions":[{"kind":"product|architecture|credentials|verification","finding":"unresolved finding","question":"decision needed from parent"}],"tests":[{"command":"focused command run","passed":true}]}
Use empty arrays when appropriate. If tests cannot run, include a verification
decision. A summary is never a passing review; the independent read-only reviewer will
inspect the changed tree independently.

Findings:
PROMPT
cat "$FINDINGS_FILE" >> "$bounded_prompt"
PROMPT_FILE="$bounded_prompt"

FIXER_CLI="$(review_select_reviewer "${REVIEWER_CLI:-auto}")"
CLAUDE_REVIEW_MODEL="${CLAUDE_REVIEW_MODEL:-}"
review_require_model "$FIXER_CLI" || exit $?

if review_bb_wants_run; then
  echo ">> BB context detected ($BB_THREAD_ID): routing the fixer through a visible BB child in an isolated worktree" >&2
  review_bb_run_fixer "$BASE_BRANCH" "$PROMPT_FILE"
  exit $?
fi
CLAUDE_REVIEW_EFFORT="${CLAUDE_REVIEW_EFFORT:-high}"
CODEX_REVIEW_MODEL="${CODEX_REVIEW_MODEL:-}"
CODEX_REVIEW_EFFORT="${CODEX_REVIEW_EFFORT:-xhigh}"
command -v "$FIXER_CLI" >/dev/null 2>&1 || { echo ">> $FIXER_CLI not found on PATH" >&2; exit 1; }

LAST_MSG_FILE="${REVIEW_FIX_RESULT_FILE%.json}.output.log"
# Deliberately NOT removed on exit: the driving agent inspects the full summary
# from the file on demand instead of the script dumping it into the session
# context. /tmp clears on reboot.

echo ">> review write phase ($FIXER_CLI, base $BASE_BRANCH) — edits the working tree, posts nothing"

set +e
case "$FIXER_CLI" in
  codex)
    CODEX_ARGS=(codex exec --sandbox workspace-write --output-last-message "$LAST_MSG_FILE" --ephemeral)
    if [ -n "${CODEX_REVIEW_MODEL:-}" ]; then
      CODEX_ARGS+=(--model "$CODEX_REVIEW_MODEL")
    fi
    if [ -n "${CODEX_REVIEW_EFFORT:-}" ]; then
      # codex -c values are TOML, so the string needs embedded quotes.
      CODEX_ARGS+=(-c "model_reasoning_effort=\"$CODEX_REVIEW_EFFORT\"")
    fi
    env BASE_BRANCH="$BASE_BRANCH" "${CODEX_ARGS[@]}" "$(cat "$PROMPT_FILE")" < /dev/null > /dev/null 2> "$LAST_MSG_FILE.stderr"
    FIXER_EXIT=$?
    ;;
  claude)
    # `--output-last-message` has no claude equivalent; its stdout IS the
    # summary, so capture that instead of discarding it as the codex arm does.
    # Edit/Write are the point of this pass — without them it is a review that
    # cannot fix anything.
    env BASE_BRANCH="$BASE_BRANCH" \
      claude -p "$(cat "$PROMPT_FILE")" \
        --model "$CLAUDE_REVIEW_MODEL" \
        --effort "$CLAUDE_REVIEW_EFFORT" \
        --output-format text \
        --no-session-persistence \
        --tools Bash,Read,Grep,LS,Edit,Write \
        --permission-mode bypassPermissions < /dev/null > "$LAST_MSG_FILE"
    FIXER_EXIT=$?
    ;;
esac
set -e

[ "$FIXER_EXIT" -eq 0 ] && review_validate_fix_result "$LAST_MSG_FILE" || {
    echo ">> write phase failed or returned malformed JSON; inspect $LAST_MSG_FILE" >&2
    exit 1
  }
cp "$LAST_MSG_FILE" "$REVIEW_FIX_RESULT_FILE"

echo
echo "========== fixer summary =========="
if [ -s "$LAST_MSG_FILE" ]; then
  if [ "$(wc -l < "$LAST_MSG_FILE" 2>/dev/null || echo 0)" -gt 150 ]; then
    head -n 150 "$LAST_MSG_FILE"
    echo ""
    echo "(summary truncated — full fixer output: $LAST_MSG_FILE)"
  else
    cat "$LAST_MSG_FILE"
  fi
else
  echo "(no summary emitted)"
fi
echo "==================================="
echo
echo ">> full fixer output persisted at $LAST_MSG_FILE"
if [ -s "$LAST_MSG_FILE.stderr" ]; then
  echo ">> codex diagnostics persisted at $LAST_MSG_FILE.stderr"
fi
echo ">> working-tree changes made by the fixer (staged + unstaged; verify before committing):"
git status --short
git diff --stat HEAD
exit "$FIXER_EXIT"
