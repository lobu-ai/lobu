#!/usr/bin/env bash
# Pre-review fixer: runs the reviewer CLI over the local diff with WRITE
# access and prompts/review-fix-prompt.md, so review-grade findings get fixed
# BEFORE `make review` posts a pi-review status. Posts nothing; commits
# nothing. The driving agent inspects the edits (shown at the end), commits,
# then runs `make review` once on the settled HEAD.
#
# Reviewer selection matches review.sh — REVIEWER_CLI=auto|codex|claude. This
# step is mandated by AGENTS.md but is not a gate: unlike review.sh it posts no
# status, so a reviewer outage here silently skips the fixer instead of failing
# a check. Being hard-wired to one CLI therefore costs a whole quality pass
# whenever that CLI is unavailable, with nothing to signal it happened.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/review-reviewer.sh
. "$SCRIPT_DIR/lib/review-reviewer.sh"
# shellcheck source=scripts/lib/review-skip.sh
. "$SCRIPT_DIR/lib/review-skip.sh"

cd "$(dirname "$0")/.."

BASE_BRANCH="${BASE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      [ $# -ge 2 ] || { echo "usage: scripts/review-fix.sh [--base <branch>]" >&2; exit 2; }
      BASE_BRANCH="$2"
      shift 2
      ;;
    *)
      echo "usage: scripts/review-fix.sh [--base <branch>]" >&2
      exit 2
      ;;
  esac
done
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

PROMPT_FILE="prompts/review-fix-prompt.md"
[ -f "$PROMPT_FILE" ] || { echo ">> missing $PROMPT_FILE" >&2; exit 1; }

if git diff --quiet "$BASE_BRANCH...HEAD" 2>/dev/null \
  && git diff --quiet \
  && git diff --cached --quiet \
  && [ -z "$(git ls-files --others --exclude-standard | head -n 1)" ]; then
  echo ">> no diff against $BASE_BRANCH and no local changes; nothing to fix"
  exit 0
fi

# The fixer and posted review share one path/content classifier. A trivial diff
# should not pay for an unposted LLM pass only to self-skip at `make review`.
REVIEWER_MODE="${REVIEWER_MODE:-light}"
if [ "$REVIEWER_MODE" != "full" ] \
  && review_classify_diff "$BASE_BRANCH" worktree; then
  echo ">> pre-review fixer skipped: $REVIEW_SKIP_REASON"
  echo ">> deterministic CI and make review remain required"
  exit 0
fi

FIXER_CLI="$(review_select_reviewer "${REVIEWER_CLI:-auto}")"
CLAUDE_REVIEW_MODEL="${CLAUDE_REVIEW_MODEL:-fable}"
CLAUDE_REVIEW_EFFORT="${CLAUDE_REVIEW_EFFORT:-high}"
CODEX_REVIEW_MODEL="${CODEX_REVIEW_MODEL:-gpt-6-astra}"
CODEX_REVIEW_EFFORT="${CODEX_REVIEW_EFFORT:-xhigh}"
if [ "$FIXER_CLI" = "claude" ]; then
  review_validate_claude_model "$CLAUDE_REVIEW_MODEL" || exit $?
fi
command -v "$FIXER_CLI" >/dev/null 2>&1 || { echo ">> $FIXER_CLI not found on PATH" >&2; exit 1; }

LAST_MSG_FILE="$(mktemp /tmp/lobu-review-fix.XXXXXX)"
# Deliberately NOT removed on exit: the driving agent inspects the full summary
# from the file on demand instead of the script dumping it into the session
# context. /tmp clears on reboot.

echo ">> pre-review fixer ($FIXER_CLI, base $BASE_BRANCH) — edits the working tree, posts nothing"

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
