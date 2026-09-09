#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=scripts/lib/guest-bundle-expectation.sh
. "$ROOT/scripts/lib/guest-bundle-expectation.sh"

work=""
cleanup() { [[ -n "$work" ]] && rm -rf "$work"; }
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

work="$(mktemp -d)"

# Builds dist/agent-turn holding exactly the named files, and returns the DIST
# dir — the verdict function takes dist so it can tell a moved layout from a
# version that predates the feature.
fixture() {
  local name="$1"
  shift
  local dist="$work/$name/dist"
  # ${work:?} so a cleared $work can never make this rm -rf a path under /.
  rm -rf "${work:?}/$name"
  mkdir -p "$dist/agent-turn"
  local f
  for f in "$@"; do : >"$dist/agent-turn/$f"; done
  printf '%s' "$dist"
}

# A dist that exists but has no agent-turn under it at all.
fixture_no_agent_turn() {
  local dist="$work/layout_moved/dist"
  rm -rf "${work:?}/layout_moved"
  mkdir -p "$dist/executor"
  printf '%s' "$dist"
}

expect() {
  local dir="$1" want="$2" got
  got="$(lobu_guest_bundle_verdict "$dir")"
  [ "$got" = "$want" ] || fail "expected '$want', got '$got' for $dir"
}

# The exact file list the published 19.2.0 tarball ships, read off the registry
# on 2026-09-09. This is the case that reddened main: neither builder nor
# bundle, because the version predates both.
expect "$(fixture published_19_2_0 \
  bundle.js guest-entry.js index.js types.js workspace.js \
  bundle.d.ts guest-entry.d.ts index.d.ts types.d.ts workspace.d.ts)" \
  not-shipped

# A publish that ran `tsc` (so the builder compiled into dist) but never ran
# the bundle step. THIS is the packaging bug the assertion exists to catch, and
# it must stay a hard failure — the isolate lane cannot load a turn without it.
expect "$(fixture builder_without_output \
  build-guest-bundle.js guest-entry.js index.js)" \
  missing

# A correctly published post-#3402 artifact.
expect "$(fixture healthy \
  build-guest-bundle.js guest.bundle.js guest-entry.js index.js)" \
  present

# The bundle alone is enough. Nothing requires the builder to be present for
# the artifact to work at runtime — only for the expectation to be inferable —
# so a payload trimmed to just the output must not read as broken.
expect "$(fixture bundle_only guest.bundle.js index.js)" present

# An empty agent-turn is a pre-feature artifact: the directory is there, it
# just carries neither builder nor bundle.
expect "$(fixture empty)" not-shipped

# dist present, agent-turn gone. Without this branch both probes come up empty
# and a real packaging regression would read as `not-shipped` and be SKIPPED —
# quieter than the bug it is hiding. 19.2.0 does ship dist/agent-turn
# (verified from the tarball), so this cannot fire on pre-feature versions.
expect "$(fixture_no_agent_turn)" layout-moved

# Nothing installed at all. The install assertions own that failure, but the
# verdict must still be a distinct value rather than crashing under `set -e`.
expect "$work/absent/dist" no-dist

# `guest-entry.js` is a decoy: it ships in 19.2.0 and sits one character from
# `guest.bundle.js` (`guest-` vs `guest.`). A `guest*.js` glob would read it as
# `present`; treating it as the builder would read it as `missing`. Either way
# 19.2.0 stops reading `not-shipped` and main stays red.
expect "$(fixture decoy_entry_only guest-entry.js)" not-shipped

echo "PASS: guest-bundle expectation verdicts"
