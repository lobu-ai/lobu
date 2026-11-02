#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# shellcheck source=scripts/lib/review-skip.sh
. "$repo_root/scripts/lib/review-skip.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp_repo="$(mktemp -d /tmp/lobu-review-skip.XXXXXX)"
sub_repo="${tmp_repo}.sub"
trap 'rm -rf "$tmp_repo" "$sub_repo"' EXIT

new_repo() {
  rm -rf "$tmp_repo" "$sub_repo"
  mkdir -p "$tmp_repo"
  git -C "$tmp_repo" init -q
  git -C "$tmp_repo" config user.email test@test
  git -C "$tmp_repo" config user.name test
  git -C "$tmp_repo" commit --allow-empty -q -m root
  git -C "$tmp_repo" branch main 2>/dev/null || true
  git -C "$tmp_repo" checkout -q -b work
}

commit_all() {
  git -C "$tmp_repo" add -A
  git -C "$tmp_repo" commit -q -m change
}

write_change() {
  local path="$1" content="$2"
  mkdir -p "$(dirname "$tmp_repo/$path")"
  printf '%s\n' "$content" > "$tmp_repo/$path"
}

seed_gitlink() {
  local path="${1:-packages/owletto}" target
  target="$(git -C "$tmp_repo" rev-parse HEAD)"
  git -C "$tmp_repo" update-index --add --cacheinfo "160000,$target,$path"
  git -C "$tmp_repo" commit -q -m baseline-submodule
  git -C "$tmp_repo" branch -f main
}

bump_gitlink() {
  local path="${1:-packages/owletto}" target
  target="$(git -C "$tmp_repo" rev-parse HEAD)"
  git -C "$tmp_repo" update-index --cacheinfo "160000,$target,$path"
}

# classify: run the classifier in the fixture repo in the CURRENT shell so the
# global REVIEW_SKIP_REASON is visible to the assertions. Must be called under
# `set +e` (the assert helpers do) and must not touch errexit itself.
classify() {
  local prev rc
  prev="$(pwd)"
  cd "$tmp_repo"
  review_classify_diff main
  rc=$?
  cd "$prev"
  return "$rc"
}

classify_worktree() {
  local prev rc
  prev="$(pwd)"
  cd "$tmp_repo"
  review_classify_diff main worktree
  rc=$?
  cd "$prev"
  return "$rc"
}

# assert_skip <label>: classifier must return 0 (skip eligible)
assert_skip() {
  local label="$1" rc
  set +e
  classify
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || fail "$label: expected skip (rc 0), got rc $rc"
  [ -n "$REVIEW_SKIP_REASON" ] || fail "$label: skip with no REVIEW_SKIP_REASON"
}

# assert_review <label> <reason-fragment>: classifier must return 1 (full review)
assert_review() {
  local label="$1" fragment="$2" rc
  set +e
  classify
  rc=$?
  set -e
  [ "$rc" -eq 1 ] || fail "$label: expected review (rc 1), got rc $rc"
  case "${REVIEW_SKIP_REASON:-}" in
    *"$fragment"*) ;;
    *) fail "$label: expected reason to contain '$fragment', got '${REVIEW_SKIP_REASON}'" ;;
  esac
}

assert_worktree_skip() {
  local label="$1" rc
  set +e
  classify_worktree
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || fail "$label: expected worktree skip (rc 0), got rc $rc"
  [ -n "$REVIEW_SKIP_REASON" ] || fail "$label: skip with no REVIEW_SKIP_REASON"
}

assert_worktree_review() {
  local label="$1" fragment="$2" rc
  set +e
  classify_worktree
  rc=$?
  set -e
  [ "$rc" -eq 1 ] || fail "$label: expected worktree review (rc 1), got rc $rc"
  case "${REVIEW_SKIP_REASON:-}" in
    *"$fragment"*) ;;
    *) fail "$label: expected reason to contain '$fragment', got '${REVIEW_SKIP_REASON}'" ;;
  esac
}

# docs-only small diff → skip
new_repo
write_change README.md "docs only"
commit_all
assert_skip "docs-only"

# markdown anywhere → skip
new_repo
write_change packages/core/README.md "core docs"
commit_all
assert_skip "markdown docs"

# non-test source change → full review, regardless of size
new_repo
write_change packages/foo/src/index.ts "export const x = 1;"
commit_all
assert_review "src change" "packages/foo/src/index.ts"

# one line of src under the 100-line threshold still reviews
new_repo
write_change packages/foo/src/bar.ts "export const y = 2;"
commit_all
assert_review "tiny src change" "packages/foo/src/bar.ts"

# Owletto pointer bump ALONE → skip. Owletto owns review of its content, and
# check-drift limits the parent to on-main SHAs, so the parent gate need not
# duplicate that semantic review for a pointer-only diff.
new_repo
seed_gitlink
bump_gitlink
git -C "$tmp_repo" commit -q -m change
assert_skip "pure submodule pointer bump"
[ "$REVIEW_SKIP_REASON" = "pure packages/owletto submodule pointer bump" ] \
  || fail "pure submodule pointer bump: unexpected reason '$REVIEW_SKIP_REASON'"

new_repo
seed_gitlink
bump_gitlink
assert_worktree_skip "uncommitted pure submodule pointer bump"

new_repo
git init -q "$sub_repo"
git -C "$sub_repo" config user.email test@test
git -C "$sub_repo" config user.name test
printf 'baseline\n' > "$sub_repo/tracked.txt"
git -C "$sub_repo" add tracked.txt
git -C "$sub_repo" commit -q -m baseline
git -c protocol.file.allow=always -C "$tmp_repo" submodule add -q "$sub_repo" packages/owletto
git -C "$tmp_repo" commit -q -m baseline-submodule
git -C "$tmp_repo" branch -f main
printf 'dirty\n' >> "$tmp_repo/packages/owletto/tracked.txt"
assert_worktree_review "dirty submodule is not a pointer bump" "uncommitted content"

# A newly introduced gitlink is not a pointer bump and must receive full review.
new_repo
sub_sha="$(git -C "$tmp_repo" rev-parse HEAD)"
git -C "$tmp_repo" update-index --add --cacheinfo "160000,$sub_sha,packages/owletto"
git -C "$tmp_repo" commit -q -m change
assert_review "new submodule gitlink" "packages/owletto"

# Removing a submodule is also not a pointer bump.
new_repo
seed_gitlink
git -C "$tmp_repo" update-index --force-remove packages/owletto
git -C "$tmp_repo" commit -q -m change
assert_review "removed submodule gitlink" "packages/owletto"

# Only Owletto has the check-drift protection that makes pointer-only changes
# safe to skip. Other submodules must still receive full review, even when
# their path would otherwise look like a safe-class documentation file.
new_repo
seed_gitlink vendor/other.md
bump_gitlink vendor/other.md
git -C "$tmp_repo" commit -q -m change
assert_review "unprotected submodule pointer bump" "vendor/other.md"

# A submodule pointer bump mixed with any parent change is not pure, even when
# the other path would independently be safe-class.
new_repo
seed_gitlink
bump_gitlink
write_change README.md "docs"
git -C "$tmp_repo" add README.md
git -C "$tmp_repo" commit -q -m change
assert_review "submodule bump + docs" "mixed with other changes"

new_repo
seed_gitlink
bump_gitlink
write_change packages/server/src/index.ts "export const z = 3;"
git -C "$tmp_repo" add packages/server/src/index.ts
git -C "$tmp_repo" commit -q -m change
assert_review "submodule bump + src change" "mixed with other changes"

# The root Bun lockfile is installed and built by deterministic CI, so a small
# lock-only change does not need an LLM pass.
new_repo
write_change bun.lock "{}"
commit_all
assert_skip "lockfile-only"

# Foreign and arbitrary *.lock files are not consumed by this Bun workspace's
# dependency gates, so a suffix alone must not suppress review.
new_repo
write_change pnpm-lock.yaml "lockfileVersion: 9"
commit_all
assert_review "foreign yaml lockfile" "pnpm-lock.yaml"

new_repo
write_change package-lock.json '{}'
commit_all
assert_review "foreign json lockfile" "package-lock.json"

new_repo
write_change runtime.lock "placeholder"
commit_all
assert_review "arbitrary lock suffix" "runtime.lock"

# A lockfile suffix must not override paths that are configuration by contract.
new_repo
write_change config/runtime.lock "placeholder"
commit_all
assert_review "config lockfile" "config/runtime.lock"

new_repo
write_change .env.lock "placeholder"
commit_all
assert_review "environment lockfile" ".env.lock"

# Snapshots are checked against deterministic test output. Static assets can be
# production content or unused additions, so they still need semantic review.
new_repo
write_change packages/foo/src/__tests__/__snapshots__/view.test.ts.snap $'exports[`view 1`] = `updated`;'
commit_all
assert_skip "snapshot-only"

new_repo
write_change packages/foo/assets/logo.svg '<svg viewBox="0 0 1 1"></svg>'
commit_all
assert_review "static-asset-only" "logo.svg"

new_repo
write_change packages/foo/assets/logo.png "binary-placeholder"
commit_all
assert_review "raster-asset-only" "logo.png"

# A model identifier swap in a Lobu config is declarative routing, not source
# semantics. Only the exact literal may change; companion config edits escalate.
new_repo
write_change examples/personal-agent/lobu.config.ts $'export default {\n  model: "qwen/old",\n};'
commit_all
git -C "$tmp_repo" branch -f main
write_change examples/personal-agent/lobu.config.ts $'export default {\n  model: "hetzner/new",\n};'
commit_all
assert_skip "model-only config"

new_repo
write_change examples/personal-agent/lobu.config.ts $'export default {\n  model: "qwen/old",\n};'
commit_all
git -C "$tmp_repo" branch -f main
write_change examples/personal-agent/lobu.config.ts $'export default {\n  model: "hetzner/new",\n  model: "hetzner/duplicate",\n};'
commit_all
assert_review "model structural edit" "lobu.config.ts"

# A model literal moved between Automation blocks changes which Automation uses the
# route. The delete-only and add-only hunks must not cancel out globally.
new_repo
write_change examples/personal-agent/lobu.config.ts $'export default {\n  automations: [\n    {\n      name: "first",\n      model: "qwen/old",\n      prompt: "first",\n    },\n    {\n      name: "second",\n      prompt: "second",\n    },\n  ],\n};'
commit_all
git -C "$tmp_repo" branch -f main
write_change examples/personal-agent/lobu.config.ts $'export default {\n  automations: [\n    {\n      name: "first",\n      prompt: "first",\n    },\n    {\n      name: "second",\n      model: "qwen/old",\n      prompt: "second",\n    },\n  ],\n};'
commit_all
assert_review "model moved between automations" "lobu.config.ts"

new_repo
write_change examples/personal-agent/lobu.config.ts $'export default {\n  model: "qwen/old",\n  prompt: "old",\n};'
commit_all
git -C "$tmp_repo" branch -f main
write_change examples/personal-agent/lobu.config.ts $'export default {\n  model: "hetzner/new",\n  prompt: "new",\n};'
commit_all
assert_review "model plus runtime config" "lobu.config.ts"

# Worktree classification must include tracked
# staged/unstaged changes. Untracked paths fail closed instead of disappearing.
new_repo
write_change examples/personal-agent/lobu.config.ts $'export default {\n  model: "qwen/old",\n};'
commit_all
git -C "$tmp_repo" branch -f main
write_change examples/personal-agent/lobu.config.ts $'export default {\n  model: "hetzner/new",\n};'
assert_worktree_skip "uncommitted model-only config"

new_repo
write_change examples/personal-agent/lobu.config.ts $'export default {\n  model: "qwen/old",\n};'
commit_all
git -C "$tmp_repo" branch -f main
write_change examples/personal-agent/lobu.config.ts $'export default {\n  model: "hetzner/new",\n};'
git -C "$tmp_repo" add examples/personal-agent/lobu.config.ts
assert_worktree_skip "staged model-only config"

# The fixer reviews the prospective branch tree against the merge base. Changes
# made only on an advancing base branch are not part of that tree's feature diff.
new_repo
write_change README.md "feature docs"
commit_all
git -C "$tmp_repo" checkout -q main
write_change packages/foo/src/base-only.ts "export const baseOnly = true;"
commit_all
git -C "$tmp_repo" checkout -q work
assert_worktree_skip "base-only source change"

new_repo
write_change packages/foo/src/index.ts "export const x = 1;"
assert_worktree_review "untracked source" "untracked file"

# config → full review
new_repo
write_change config/app.yaml "port: 80"
commit_all
assert_review "config" "config/app.yaml"

# review machinery edit → full review (self-referential skip hole)
new_repo
write_change scripts/review.sh "echo hi"
commit_all
assert_review "review.sh edit" "scripts/review.sh"

new_repo
write_change prompts/review-prompt.md "weakened rubric"
commit_all
assert_review "review prompt edit" "prompts/review-prompt.md"

new_repo
write_change docs/REVIEW_SCHEMA.md "weakened rubric"
commit_all
assert_review "review rubric edit" "docs/REVIEW_SCHEMA.md"

# CI workflow edit → full review
new_repo
write_change .github/workflows/ci.yml "jobs: {}"
commit_all
assert_review "ci workflow edit" ".github/workflows/ci.yml"

# additive-only new test → skip
new_repo
write_change packages/foo/src/__tests__/new.test.ts "import { test } from 'bun:test'; test('x', () => {});"
commit_all
assert_skip "additive new test"

# test change that deletes an assertion → full review. The test file must exist
# at the base commit so the cumulative diff actually shows deletions.
new_repo
mkdir -p "$tmp_repo/packages/foo/src/__tests__"
printf 'import { test } from "bun:test";\ntest("a", () => {});\ntest("b", () => {});\n' > "$tmp_repo/packages/foo/src/__tests__/exists.test.ts"
git -C "$tmp_repo" add -A
git -C "$tmp_repo" commit -q -m baseline
git -C "$tmp_repo" branch -f main
printf 'import { test } from "bun:test";\ntest("a", () => {});\n' > "$tmp_repo/packages/foo/src/__tests__/exists.test.ts"
git -C "$tmp_repo" add -A
git -C "$tmp_repo" commit -q -m weaken
assert_review "test weakening" "exists.test.ts"

# pure rename of a docs file → skip (source must exist at base for -M100)
new_repo
printf 'docs\n' > "$tmp_repo/README.md"
git -C "$tmp_repo" add -A
git -C "$tmp_repo" commit -q -m baseline
git -C "$tmp_repo" branch -f main
git -C "$tmp_repo" mv README.md GUIDE.md
git -C "$tmp_repo" commit -q -m rename
assert_skip "pure rename docs"

# exact rename OUT of a safe class → full review: `git mv src/x.ts x.md` must
# not hide a source deletion behind a docs-looking destination.
new_repo
printf 'export const x = 1;\n' > "$tmp_repo/thing.ts"
mkdir -p "$tmp_repo/packages/foo/src"
mv "$tmp_repo/thing.ts" "$tmp_repo/packages/foo/src/thing.ts"
git -C "$tmp_repo" add -A
git -C "$tmp_repo" commit -q -m baseline
git -C "$tmp_repo" branch -f main
git -C "$tmp_repo" mv packages/foo/src/thing.ts thing.md
git -C "$tmp_repo" commit -q -m rename
assert_review "cross-class exact rename" "packages/foo/src/thing.ts"

# near-rename (delete src + add mostly-similar docs) → full review. Guards the
# -M100 vs -M100% footgun: a lax similarity threshold pairs these and shows
# only the safe-looking destination.
new_repo
printf 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n' > "$tmp_repo/near.ts"
mkdir -p "$tmp_repo/packages/foo/src"
mv "$tmp_repo/near.ts" "$tmp_repo/packages/foo/src/near.ts"
git -C "$tmp_repo" add -A
git -C "$tmp_repo" commit -q -m baseline
git -C "$tmp_repo" branch -f main
git -C "$tmp_repo" rm -q packages/foo/src/near.ts
printf 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nEDITED\n' > "$tmp_repo/near.md"
git -C "$tmp_repo" add -A
git -C "$tmp_repo" commit -q -m near-rename
assert_review "near-rename across classes" "packages/foo/src/near.ts"

# exact rename of a test file → skip: content unchanged, no assertion moved
new_repo
mkdir -p "$tmp_repo/packages/foo/src/__tests__"
printf 'import { test } from "bun:test";\ntest("a", () => {});\n' > "$tmp_repo/packages/foo/src/__tests__/old.test.ts"
git -C "$tmp_repo" add -A
git -C "$tmp_repo" commit -q -m baseline
git -C "$tmp_repo" branch -f main
git -C "$tmp_repo" mv packages/foo/src/__tests__/old.test.ts packages/foo/src/__tests__/renamed.test.ts
git -C "$tmp_repo" commit -q -m rename
assert_skip "pure rename test file"

# rename + modify of a test file (assertion deleted in the move) → full
# review. Guards the -M100% exactness: a lax threshold would pair this as a
# rename and the content-unchanged shortcut would hide the deleted assertion.
new_repo
mkdir -p "$tmp_repo/packages/foo/src/__tests__"
printf 'import { test } from "bun:test";\ntest("a", () => {});\ntest("b", () => {});\ntest("c", () => {});\ntest("d", () => {});\ntest("e", () => {});\ntest("f", () => {});\ntest("g", () => {});\ntest("h", () => {});\n' > "$tmp_repo/packages/foo/src/__tests__/mv.test.ts"
git -C "$tmp_repo" add -A
git -C "$tmp_repo" commit -q -m baseline
git -C "$tmp_repo" branch -f main
git -C "$tmp_repo" mv packages/foo/src/__tests__/mv.test.ts packages/foo/src/__tests__/mv2.test.ts
printf 'import { test } from "bun:test";\ntest("a", () => {});\ntest("b", () => {});\ntest("c", () => {});\ntest("d", () => {});\ntest("e", () => {});\ntest("f", () => {});\ntest("g", () => {});\n' > "$tmp_repo/packages/foo/src/__tests__/mv2.test.ts"
git -C "$tmp_repo" add -A
git -C "$tmp_repo" commit -q -m move-and-weaken
assert_review "renamed-and-weakened test" "mv"

# diff over 100 lines → full review even for docs
new_repo
{
  for i in $(seq 1 120); do
    printf 'line %s\n' "$i"
  done
} > "$tmp_repo/README.md"
commit_all
assert_review "large docs diff" "diff too large"

# binary/unknown file → full review
new_repo
printf '\x00\x01\x02' > "$tmp_repo/blob.bin"
git -C "$tmp_repo" add -A
git -C "$tmp_repo" commit -q -m binary
assert_review "binary file" "blob.bin"

echo "review skip classifier tests passed"
