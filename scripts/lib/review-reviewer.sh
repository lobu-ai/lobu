#!/usr/bin/env bash

review_is_codex_harness() {
  [ -n "${CODEX_THREAD_ID:-}" ] ||
    [ -n "${CODEX_MANAGED_PACKAGE_ROOT:-}" ] ||
    [ "${CODEX_CI:-}" = "1" ]
}

review_select_reviewer() {
  case "$1" in
    auto)
      if review_is_codex_harness; then
        printf 'claude\n'
      else
        printf 'codex\n'
      fi
      ;;
    codex|claude)
      printf '%s\n' "$1"
      ;;
    *)
      echo "invalid REVIEWER_CLI=$1 (expected auto, codex, or claude)" >&2
      return 2
      ;;
  esac
}

review_validate_claude_model() {
  case "$1" in
    fable|opus|claude-opus-?*) return 0 ;;
    *)
      echo "invalid CLAUDE_REVIEW_MODEL=$1 (only fable, opus, or a claude-opus-* model is allowed)" >&2
      return 2
      ;;
  esac
}

review_should_retry_inline() {
  [ "$1" -eq 0 ] || return 1
  [ -z "$(printf '%s' "$2" | tr -d '[:space:]')" ]
}

review_fail_closed_message() {
  local reviewer="$1"
  local detail="$2"
  printf "Independent review could not be completed by '%s': %s. The review gate fails closed and will not fall back to another reviewer. Fix the selected reviewer's installation, authentication, quota, or configuration, then rerun; use REVIEWER_CLI=claude|codex only to explicitly select the intended independent reviewer.\n" \
    "$reviewer" "$detail"
}

# review_refuse_submodule: both review scripts review lobu itself. Started
# inside a submodule checkout (packages/owletto), review.sh takes HEAD, the
# diff and `gh pr view` from the submodule but posts the PR comment to the
# hard-coded lobu-ai/lobu repo, so the verdict lands on the same-numbered
# lobu PR; review-fix.sh cd's to the superproject and silently fixes lobu
# instead. The submodule's repository owns its content review; a pure
# pointer bump in lobu is a safe class.
review_refuse_submodule() {
  local superproject
  superproject="$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)"
  [ -n "$superproject" ] || return 0
  echo "Refusing to review from inside submodule $(git rev-parse --show-toplevel) of $superproject." >&2
  echo "Review submodule changes in the submodule's own repository; run this from the lobu checkout for lobu changes." >&2
  return 2
}
