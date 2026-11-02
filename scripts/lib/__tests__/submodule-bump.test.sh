#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
bump_script="$repo_root/scripts/bump-submodule.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_calls() {
  local label="$1" expected="$2" actual
  actual="$(sed -n '1,$p' "$call_log")"
  [ "$actual" = "$expected" ] || fail "$label: unexpected calls:
$actual"
}

run_bump() {
  local name="$1" target="$2" fail_ui="$3"
  local fail_merge="$4" artifact="${5-https://proof.example/$name}"
  (
    cd "$driver"
    env \
      ARTIFACT="$artifact" \
      CALL_LOG="$call_log" \
      FAIL_MERGE="$fail_merge" \
      FAIL_UI="$fail_ui" \
      GIT_ALLOW_PROTOCOL=file \
      NAME="$name" \
      PATH="$fake_bin:$PATH" \
      "$bump_script" packages/owletto "$target"
  )
}

tmp_root="$(mktemp -d /tmp/lobu-submodule-bump.XXXXXX)"
trap 'rm -rf "$tmp_root"' EXIT

submodule_remote="$tmp_root/owletto.git"
submodule_source="$tmp_root/owletto-source"
parent_remote="$tmp_root/lobu.git"
parent_source="$tmp_root/lobu-source"
driver="$tmp_root/driver"
fake_bin="$tmp_root/bin"
call_log="$tmp_root/calls.log"

git init -q --bare "$submodule_remote"
git init -q "$submodule_source"
git -C "$submodule_source" config user.email dev@lobu.ai
git -C "$submodule_source" config user.name Developer
git -C "$submodule_source" checkout -q -b main
printf 'a\n' > "$submodule_source/app.ts"
git -C "$submodule_source" add app.ts
git -C "$submodule_source" commit -q -m "feat: a"
sha_a="$(git -C "$submodule_source" rev-parse HEAD)"
printf 'b\n' > "$submodule_source/app.ts"
git -C "$submodule_source" commit -qam "feat: b"
sha_b="$(git -C "$submodule_source" rev-parse HEAD)"
printf 'c\n' > "$submodule_source/app.ts"
git -C "$submodule_source" commit -qam "feat: c"
git -C "$submodule_source" tag -a release -m "release"
git -C "$submodule_source" remote add origin "$submodule_remote"
git -C "$submodule_source" push -q -u origin main
git -C "$submodule_source" push -q origin release
git -C "$submodule_source" checkout -q -b feature
printf 'private\n' > "$submodule_source/private.ts"
git -C "$submodule_source" add private.ts
git -C "$submodule_source" commit -q -m "feat: private"
git -C "$submodule_source" push -q -u origin feature
git -C "$submodule_source" checkout -q main
git -C "$submodule_remote" symbolic-ref HEAD refs/heads/main

git init -q --bare "$parent_remote"
git init -q "$parent_source"
git -C "$parent_source" config user.email dev@lobu.ai
git -C "$parent_source" config user.name Developer
git -C "$parent_source" checkout -q -b main
git -C "$parent_source" -c protocol.file.allow=always submodule add -q \
  "$submodule_remote" packages/owletto
git -C "$parent_source/packages/owletto" checkout -q --detach "$sha_b"
printf '.task\n' > "$parent_source/.gitignore"
git -C "$parent_source" add .gitignore .gitmodules packages/owletto
git -C "$parent_source" commit -q -m "chore: pin owletto"
git -C "$parent_source" remote add origin "$parent_remote"
git -C "$parent_source" push -q -u origin main
git -C "$parent_remote" symbolic-ref HEAD refs/heads/main
git clone -q "$parent_remote" "$driver"
git -C "$driver" config user.email dev@lobu.ai
git -C "$driver" config user.name Developer

mkdir -p "$fake_bin"
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'case "${1:-}:${2:-}" in' \
  '  pr:create)' \
  '    echo "gh:pr-create" >> "$CALL_LOG"' \
  '    echo "https://github.example/lobu/pull/1"' \
  '    ;;' \
  '  pr:merge)' \
  '    echo "gh:pr-merge" >> "$CALL_LOG"' \
  '    if [ "$FAIL_MERGE" = "1" ]; then exit 1; fi' \
  '    ;;' \
  '  *) exit 2 ;;' \
  'esac' \
  > "$fake_bin/gh"
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'echo "make:$*" >> "$CALL_LOG"' \
  '# A local review seconds after push can only report pending CI (exit 2).' \
  'if [ "${1:-}" = "review" ]; then exit 2; fi' \
  'if [ "${1:-}" = "ui-review" ] && [ "$FAIL_UI" = "1" ]; then exit 1; fi' \
  > "$fake_bin/make"
chmod +x "$fake_bin/gh" "$fake_bin/make"

: > "$call_log"
if run_bump rollback "$sha_a" 0 0 >"$tmp_root/rollback.out" 2>&1; then
  fail "backward target should stop the bump"
fi
grep -Fq "target would move packages/owletto backwards or sideways" "$tmp_root/rollback.out" \
  || fail "backward target should explain the direction violation"
expect_calls "backward target" ""
[ ! -e "$driver/.claude/worktrees/bump-rollback" ] \
  || fail "rejected target should remove its temporary worktree"
if git -C "$driver" show-ref --verify --quiet refs/heads/chore/bump-rollback; then
  fail "rejected target should remove its temporary branch"
fi

: > "$call_log"
if run_bump off-main origin/feature 0 0 >"$tmp_root/off-main.out" 2>&1; then
  fail "off-main target should stop the bump"
fi
grep -Fq "is not reachable from packages/owletto origin/main" "$tmp_root/off-main.out" \
  || fail "off-main target should explain the reachability violation"
expect_calls "off-main target" ""

: > "$call_log"
run_bump success origin/main 0 0 >/dev/null
expect_calls "successful bump" "gh:pr-create
make:ui-review ARTIFACT=https://proof.example/success
gh:pr-merge"

: > "$call_log"
run_bump annotated-tag release 0 0 >/dev/null
expect_calls "annotated tag target" "gh:pr-create
make:ui-review ARTIFACT=https://proof.example/annotated-tag
gh:pr-merge"

: > "$call_log"
run_bump reusable-proof origin/main 0 0 "" >/dev/null
expect_calls "reusable UI proof" "gh:pr-create
make:ui-review
gh:pr-merge"

: > "$call_log"
if run_bump ui-fails origin/main 1 0 >"$tmp_root/ui-fails.out" 2>&1; then
  fail "UI review failure should stop the bump"
fi
grep -Fq "ui-review failed; PR remains open" "$tmp_root/ui-fails.out" \
  || fail "UI review failure should explain that the PR remains open"
expect_calls "UI review failure" "gh:pr-create
make:ui-review ARTIFACT=https://proof.example/ui-fails"

: > "$call_log"
if run_bump proof-missing origin/main 1 0 "" >"$tmp_root/proof-missing.out" 2>&1; then
  fail "missing reusable UI proof should stop the bump"
fi
grep -Fq "UI proof is required; rerun" "$tmp_root/proof-missing.out" \
  || fail "missing reusable UI proof should explain how to provide an artifact"
expect_calls "missing reusable UI proof" "gh:pr-create
make:ui-review"

: > "$call_log"
if run_bump merge-fails origin/main 0 1 >"$tmp_root/merge-fails.out" 2>&1; then
  fail "auto-merge failure should stop the bump"
fi
grep -Fq "auto-merge could not be enabled; PR remains open" "$tmp_root/merge-fails.out" \
  || fail "auto-merge failure should explain that the PR remains open"
expect_calls "auto-merge failure" "gh:pr-create
make:ui-review ARTIFACT=https://proof.example/merge-fails
gh:pr-merge"

echo "submodule bump shortcut tests passed"
