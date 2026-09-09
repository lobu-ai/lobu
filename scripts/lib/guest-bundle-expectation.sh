#!/usr/bin/env bash
# Decide whether a PUBLISHED @lobu/connector-worker is required to carry the
# isolate agent-turn guest bundle.
#
# Why this is not just `[ -f guest.bundle.js ]`: the published-artifact smoke
# installs the artifact users actually get — the newest version on npm — while
# the assertion lives on `main`. #3402 added both the bundle builder and a bare
# file check in one commit, so from the moment it merged the smoke demanded a
# file that no published version contains. `19.2.0` (2026-09-07) predates the
# builder by two days, and as of 2026-09-09 release `20.0.0` was still an open
# PR, so every run on main failed 14/1 for a version that was never supposed to
# have the file.
#
# An artifact from before the feature is not broken. Its agent turn runs the
# spawned-subprocess lane, which the smoke's own real-turn assertion exercises
# either way (section 4, "lobu chat returned the model's reply") — so a missing
# bundle there proves nothing, while a hard failure hides every genuine
# regression behind noise.
#
# The expectation is therefore DERIVED from the artifact rather than pinned to
# a version number that would rot at the next major:
#
#   build script:  `tsc && node dist/agent-turn/build-guest-bundle.js`
#   files:         ["dist", ...]
#
# so the compiled BUILDER ships in the same payload as what it builds. An
# artifact carrying the builder but not the bundle is the real packaging bug —
# a publish that ran `tsc` and skipped the bundle step — and that is what this
# must catch. An artifact carrying neither simply predates the feature, and
# starts being held to the assertion automatically once the next release
# publishes. No version table to maintain.
#
# One case the builder/bundle pair cannot settle on its own: if
# `dist/agent-turn` disappears wholesale, both probes come up empty and the
# artifact reads as "predates the feature" when it is actually a packaging
# regression. So the caller passes `dist` and an existing `dist` with no
# `agent-turn` under it is called out separately. 19.2.0 does ship that
# directory (verified from the published tarball), so pre-feature versions
# stay unaffected.
#
# Usage:
#   verdict="$(lobu_guest_bundle_verdict "<connector-worker-dist>")"
#     present      -> the bundle is there; assert on it
#     missing      -> builder shipped without its output; FAIL, this is the bug
#     layout-moved -> dist exists but dist/agent-turn does not; FAIL
#     not-shipped  -> artifact predates the builder; skip, not a failure
#     no-dist      -> nothing installed; the install assertions own that

lobu_guest_bundle_verdict() {
  local dist="$1" dir="$1/agent-turn"
  if [ -f "$dir/guest.bundle.js" ]; then
    printf 'present'
  elif [ -f "$dir/build-guest-bundle.js" ]; then
    printf 'missing'
  elif [ -d "$dir" ]; then
    printf 'not-shipped'
  elif [ -d "$dist" ]; then
    printf 'layout-moved'
  else
    printf 'no-dist'
  fi
}
