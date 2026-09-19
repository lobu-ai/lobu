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
# outside the working tree, so it never dirties `git status`. /tmp and reboot
# clear it; losing the cache only means a re-review, never a wrong verdict.

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
  git diff "$base"...HEAD 2>/dev/null | review_sha256 | cut -d' ' -f1
}

# A verdict is only reusable for the same reviewer identity. Any knob that can
# change the verdict — CLI, model, effort, provider — must be in the signature.
review_reviewer_signature() {
  printf '%s|%s|%s|%s|%s\n' \
    "${REVIEWER_CLI_SELECTED:-}" \
    "${CLAUDE_REVIEW_MODEL:-}" \
    "${CLAUDE_REVIEW_EFFORT:-}" \
    "${CODEX_REVIEW_MODEL:-}" \
    "${CODEX_REVIEW_EFFORT:-}"
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
  local hash="$1" sig="$2" base="$3" head="$4" verdict="$5"
  mkdir -p "$(review_cache_root)"
  jq -n --arg hash "$hash" --arg sig "$sig" --arg base "$base" --arg head "$head" \
     --argjson verdict "$verdict" \
     '{diff_hash:$hash, reviewer_sig:$sig, base:$base, head:$head, ts:now, verdict:$verdict}' \
     > "$(review_cache_root)/$hash.json"
}
