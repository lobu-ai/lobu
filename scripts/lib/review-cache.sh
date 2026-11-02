# review-cache.sh — diff-hash verdict cache for the pi-review gate.
# shellcheck shell=bash
#
# The reviewer is non-deterministic: identical diffs have flipped pass↔fail
# between runs, so re-reviewing unchanged content buys no information and only
# exposes the gate to noise-driven phantom fix cycles. This cache keys a stored
# verdict on the exact diff content + the reviewer identity; a run whose diff
# hash (and reviewer) matches a previously issued verdict reuses it instead of
# spawning another reviewer session.
#
# The cache is per-repo (git-common-dir, shared across worktrees) and lives
# outside the working tree, so it never dirties `git status`. Losing a verdict
# cache entry requires review again; never clear the branch budget to retry.

REVIEW_CACHE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

review_cache_root() {
  local common
  if [ -n "${REVIEW_CACHE_ROOT_FOR_TESTS:-}" ]; then
    printf '%s\n' "$REVIEW_CACHE_ROOT_FOR_TESTS"
    return
  fi
  common="$(git rev-parse --git-common-dir 2>/dev/null || true)"
  if [ -n "$common" ]; then
    printf '%s/lobu-review-cache\n' "$common"
  else
    printf '/tmp/lobu-review-cache-%s\n' "$(id -u)"
  fi
}

review_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum
  else
    shasum -a 256
  fi
}

review_diff_hash() {
  local base="$1"
  { git merge-base "$base" HEAD
    git diff --binary --no-ext-diff --no-textconv "$(git merge-base "$base" HEAD)" "${2:-HEAD}"
  } | review_sha256 | cut -d' ' -f1
}

# A verdict is only reusable for the same reviewer identity. Any knob that can
# change the verdict — CLI, model, effort, provider — must be in the signature.
review_reviewer_signature() {
  printf 'evidence-v2|%s|%s|%s|%s|%s|%s\n' \
    "${REVIEWER_CLI_SELECTED:-}" \
    "${CLAUDE_REVIEW_MODEL:-}" \
    "${CLAUDE_REVIEW_EFFORT:-}" \
    "${CODEX_REVIEW_MODEL:-}" \
    "${CODEX_REVIEW_EFFORT:-}" \
    "$(cat "$REVIEW_CACHE_LIB_DIR/../../prompts/review-prompt.md" "$REVIEW_CACHE_LIB_DIR/../../prompts/review-output-schema.json" | review_sha256 | cut -d' ' -f1)"
}

# review_cache_lookup <hash> <signature>
# Prints the cache file path on a valid hit, returns 1 on a miss.
review_cache_lookup() {
  local hash="$1" sig="$2" file
  file="$(review_cache_root)/$hash.json"
  [ -f "$file" ] || return 1
  jq -e --arg sig "$sig" '.reviewer_sig == $sig' "$file" >/dev/null 2>&1 || return 1
  printf '%s\n' "$file"
}

review_cache_store() {
  local hash="$1" sig="$2" base="$3" head="$4" verdict="$5" temporary
  mkdir -p "$(review_cache_root)"
  temporary="$(mktemp "$(review_cache_root)/verdict.XXXXXX")"
  jq -n --arg hash "$hash" --arg sig "$sig" --arg base "$base" --arg head "$head" \
     --argjson verdict "$verdict" \
     '{diff_hash:$hash, reviewer_sig:$sig, base:$base, head:$head, ts:now, verdict:$verdict}' \
     > "$temporary"
  mv "$temporary" "$(review_cache_root)/$hash.json"
}

# One branch owns a cycle. Commits, rebases, model changes and resume
# commands cannot reset its automatic-write budget. New branches start fresh.
review_cycle_file() {
  local key
  key="$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse HEAD)"
  key="$(printf '%s\n' "$key" | review_sha256 | cut -d' ' -f1)"
  printf '%s/cycles/%s.json\n' "$(review_cache_root)" "$key"
}

review_cycle_save() {
  local file temporary
  file="$(review_cycle_file)"
  mkdir -p "$(dirname "$file")"
  temporary="$(mktemp "$(dirname "$file")/cycle.XXXXXX")"
  jq -n --argjson passes "$AUTOFIX_PASSES" --arg sig "$REVIEWER_SIG" \
    --arg tree "${REVIEW_PREVIOUS_TREE:-}" --arg base "${REVIEW_PREVIOUS_BASE:-}" \
    --arg thread "${REVIEW_PREVIOUS_THREAD:-}" --argjson verdict "${REVIEW_PREVIOUS_VERDICT:-null}" \
    '{passes:$passes,reviewer_sig:$sig,tree:$tree,base:$base,thread:$thread,verdict:$verdict}' > "$temporary"
  mv "$temporary" "$file"
}

# Different HEADs of the same branch share the budget and must not race it.
acquire_review_cycle_lock() {
  local file
  file="$(review_cycle_file).lock"
  mkdir -p "$(dirname "$file")"
  exec 8>>"$file"
  if ! perl -MFcntl=:flock -e 'exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <&8; then
    echo 'Another review owns this branch cycle; duplicate refused' >&2
    exec 8>&-
    return 2
  fi
}
