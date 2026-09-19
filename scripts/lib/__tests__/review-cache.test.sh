#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# shellcheck source=scripts/lib/review-cache.sh
. "$repo_root/scripts/lib/review-cache.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cache_root="$(mktemp -d /tmp/lobu-review-cache.XXXXXX)"
trap 'rm -rf "$cache_root"' EXIT
export REVIEW_CACHE_ROOT_FOR_TESTS="$cache_root"
export REVIEWER_CLI_SELECTED=codex
export CLAUDE_REVIEW_MODEL=fable CLAUDE_REVIEW_EFFORT=high
export CODEX_REVIEW_MODEL=gpt-5.6-sol CODEX_REVIEW_EFFORT=xhigh

sig="$(review_reviewer_signature)"
[ -n "$sig" ] || fail "empty reviewer signature"

verdict='{"bug_free_confidence":88,"bugs":0,"slop":0,"simplicity":92,"blockers":[],"change_type":"fix","runtime_change_risk":"low","tests_adequate":true,"suggested_fixes":[],"notes":"ok","categories":{"src":5}}'

review_cache_store "hash-a" "$sig" "origin/main" "deadbeef" "$verdict"

hit="$(review_cache_lookup "hash-a" "$sig")"
[ -n "$hit" ] && [ -f "$hit" ] || fail "exact hash+sig did not hit"
[ "$(jq -c .verdict "$hit")" = "$verdict" ] || fail "cached verdict did not round-trip"
[ "$(jq -r .diff_hash "$hit")" = "hash-a" ] || fail "cached diff_hash not stored"

# different reviewer signature → miss (stale verdict under a new reviewer)
if review_cache_lookup "hash-a" "claude|fable|low|gpt-5.6-sol|xhigh" >/dev/null 2>&1; then
  fail "different reviewer signature unexpectedly hit"
fi

# different diff hash → miss
if review_cache_lookup "hash-b" "$sig" >/dev/null 2>&1; then
  fail "different diff hash unexpectedly hit"
fi

# a changed signature must invalidate: same verdict under claude vs codex
review_cache_store "hash-c" "$sig" "origin/main" "cafe" "$verdict"
if review_cache_lookup "hash-c" "claude|fable|high|gpt-5.6-sol|xhigh" >/dev/null 2>&1; then
  fail "cross-reviewer verdict reused"
fi

# a changed codex effort must invalidate: effort is part of the signature
sig_low_effort="$(CODEX_REVIEW_EFFORT=high review_reviewer_signature)"
if [ "$sig_low_effort" = "$sig" ]; then
  fail "codex effort not included in the reviewer signature"
fi
review_cache_store "hash-d" "$sig_low_effort" "origin/main" "cafe" "$verdict"
if review_cache_lookup "hash-d" "$sig" >/dev/null 2>&1; then
  fail "verdict cached under a different codex effort was reused"
fi

# review_diff_hash is stable for identical content and differs on change
repo="$(mktemp -d /tmp/lobu-review-cache-repo.XXXXXX)"
trap 'rm -rf "$cache_root" "$repo"' EXIT
git -C "$repo" init -q
git -C "$repo" config user.email t@t
git -C "$repo" config user.name t
git -C "$repo" commit --allow-empty -q -m root
git -C "$repo" branch main 2>/dev/null || true
git -C "$repo" checkout -q -b work
printf 'a\n' > "$repo/f.txt"
git -C "$repo" add -A
git -C "$repo" commit -q -m one
h1="$(cd "$repo" && review_diff_hash main)"
h2="$(cd "$repo" && review_diff_hash main)"
[ "$h1" = "$h2" ] && [ -n "$h1" ] || fail "diff hash not stable"

# Exercise the native fallback when installed; it is not a test dependency.
if shasum_path="$(command -v shasum)"; then
  mac_bin="$cache_root/mac-bin"
  mkdir "$mac_bin"
  ln -s "$(command -v git)" "$mac_bin/git"
  ln -s "$(command -v cut)" "$mac_bin/cut"
  ln -s "$shasum_path" "$mac_bin/shasum"
  mac_h1="$(cd "$repo" && PATH="$mac_bin" review_diff_hash main)"
  [ "$mac_h1" = "$h1" ] || fail "native shasum diff hash differs"
else
  echo "SKIP: native shasum integration (shasum not installed)"
fi

# Controlled backends cover selection regardless of the host's installed tools.
primary_bin="$cache_root/primary-bin"
fallback_bin="$cache_root/fallback-bin"
mkdir "$primary_bin" "$fallback_bin"
cat > "$primary_bin/sha256sum" <<'SH'
#!/bin/sh
[ "$#" -eq 0 ] || exit 1
printf 'primary\n'
SH
cat > "$fallback_bin/shasum" <<'SH'
#!/bin/sh
[ "$#" -eq 2 ] && [ "$1" = -a ] && [ "$2" = 256 ] || exit 1
printf 'fallback\n'
SH
chmod +x "$primary_bin/sha256sum" "$fallback_bin/shasum"
[ "$(PATH="$primary_bin" review_sha256)" = primary ] || fail "primary-only selection failed"
[ "$(PATH="$fallback_bin" review_sha256)" = fallback ] || fail "fallback-only selection failed"
[ "$(PATH="$fallback_bin:$primary_bin" review_sha256)" = primary ] || fail "primary backend not preferred"

printf 'a\nb\n' > "$repo/f.txt"
git -C "$repo" add -A
git -C "$repo" commit -q -m two
h3="$(cd "$repo" && review_diff_hash main)"
[ "$h3" != "$h1" ] || fail "diff hash did not change after a diff change"

echo "review cache tests passed"
