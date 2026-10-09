#!/usr/bin/env bash
#
# Lightweight regression guard for security-sensitive patterns.
# Runs in CI and exits non-zero if any banned pattern reappears.
#
# Each check is documented inline. To intentionally suppress a hit, add the
# trailing comment `// security-allowed: <reason>` on the same line — the
# grep filters those out.
#
# Scope:
#   - window.confirm / window.alert / window.prompt — banned by
#     packages/owletto/DESIGN_GUIDELINES.md (confirmations are inline, not modal).
#   - SQL string-concatenation onto literal SQL fragments — heuristic for
#     non-parameterized query construction.
#   - The loose Nix charset regex `[A-Za-z0-9._-]+` re-introduced inside
#     packages/server/src/gateway/orchestration/. WS3 hardening replaced this
#     with a strict attribute-ref validator; the loose form must stay out.
#   - Imports of the GRANTING entity-row validators
#     (`validateEntityRow{Patch,Insert}GrantingApprovedFields`) outside
#     the approval apply path (entity-field-approval.ts) and the write kernel
#     (entity-management.ts) — the only importers allowed to
#     waive a rule escalation.
#
# Out of scope: the postgres.js `.unsafe(query, params)` form is the SAFE
# parameterized API — flagging it would be noise. We rely on the
# string-concat heuristic to catch the actual injection shape.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VIOLATIONS=0

# Filter hits whose own line OR one of the preceding 3 source lines contains
# `security-allowed:`. The block-level annotation is preferred for multi-line
# template-literal concatenations where a trailing inline comment would be
# ugly; an inline annotation on the same line works too.
filter_allowlist() {
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    file="${hit%%:*}"
    rest="${hit#*:}"
    line="${rest%%:*}"
    if ! [[ "$line" =~ ^[0-9]+$ ]]; then
      echo "$hit"
      continue
    fi
    start=$(( line - 3 ))
    [ "$start" -lt 1 ] && start=1
    if sed -n "${start},${line}p" "$file" 2>/dev/null | grep -q 'security-allowed:'; then
      continue
    fi
    echo "$hit"
  done
}

echo "[check-security-patterns] scanning…"

# --- 1. Banned modal confirmations -------------------------------------------
echo "  -> window.confirm / window.alert / window.prompt"
HITS=$(
  git grep -nE 'window\.(confirm|alert|prompt)\(' -- \
    'packages/owletto/' \
    2>/dev/null | grep -E '\.tsx?:' | filter_allowlist
)
if [ -n "$HITS" ]; then
  echo "::error::Banned modal confirmation primitives:"
  echo "$HITS"
  VIOLATIONS=$((VIOLATIONS + 1))
fi

# --- 2. SQL string-concatenation onto literal fragments ----------------------
# Matches:   "SELECT ..." + foo    OR    + "...WHERE..."
# Allows the postgres.js tagged-template + `.unsafe(query, params)` shapes
# (those are parameterized and safe).
# NOTE: no `\b` word-boundary in the pattern — git's -E engine interprets `\b`
# differently across builds (macOS-bundled git silently drops the match; Linux
# CI git keeps it), which used to make this check pass locally but fail in CI.
# The `["`][^"`]*` string-literal anchors already scope the match tightly.
echo "  -> SQL string-concat onto literal fragments"
HITS=$(
  git grep -nE '["`][^"`]*SELECT[^"`]*["`][[:space:]]*\+|\+[[:space:]]*["`][^"`]*WHERE' -- \
    'packages/' \
    2>/dev/null \
    | grep -E '\.tsx?:' \
    | grep -v '/__tests__/' \
    | grep -v '/dist/' \
    | filter_allowlist
)
if [ -n "$HITS" ]; then
  echo "::error::SQL string-concatenation detected (use tagged-template sql\`\` or .unsafe(q, params)):"
  echo "$HITS"
  VIOLATIONS=$((VIOLATIONS + 1))
fi

# --- 3. Loose Nix charset regex regression -----------------------------------
# WS3 replaced `/[A-Za-z0-9._-]+/` with a strict attribute-ref validator.
# Re-introducing the loose form anywhere under orchestration/ allows the
# nix-shell injection class back in.
echo "  -> loose Nix charset regex in orchestration/"
HITS=$(
  git grep -nE '\[A-Za-z0-9\\?\._-\]\+' -- \
    'packages/server/src/gateway/orchestration/' \
    2>/dev/null | grep -E '\.tsx?:' | filter_allowlist
)
if [ -n "$HITS" ]; then
  echo "::error::Loose Nix package charset re-introduced — use isValidNixAttrRef() instead:"
  echo "$HITS"
  VIOLATIONS=$((VIOLATIONS + 1))
fi

# --- 4. GRANTING validator module boundary ---------------------------------
# Only the approval apply path may waive an escalation. The granting validator
# exports (`*GrantingApprovedFields`) may be imported only from the module that
# routed a card (entity-field-approval.ts) and the write kernel that forwards a
# grant (entity-management.ts); any other importer lets an ordinary write path
# waive a rule escalation. A lint-side `noRestrictedImports` cannot enforce this
# today (packages/server/** is biome-excluded), so this grep is the live gate.
# Defining module and tests are exempt by construction.
# NOTE: `git grep` scans tracked files only, so a rogue importer is caught once
# staged/committed (the CI case) but not while untracked in a dirty worktree.
echo "  -> granting validator imports outside the approval apply path"
HITS=$(
  git grep -nE 'validateEntityRow(Patch|Insert)GrantingApprovedFields' -- \
    'packages/' \
    2>/dev/null \
    | grep -E '\.tsx?:' \
    | grep -v '^packages/server/src/tools/admin/entity-field-approval.ts:' \
    | grep -v '^packages/server/src/utils/entity-management.ts:' \
    | grep -v '^packages/server/src/authz/entity-row-validation.ts:' \
    | grep -v '/__tests__/' \
    | filter_allowlist
)
if [ -n "$HITS" ]; then
  echo "::error::Granting validator imported outside the approval apply path — only entity-field-approval.ts (card routing) and entity-management.ts (write kernel) may waive an escalation:"
  echo "$HITS"
  VIOLATIONS=$((VIOLATIONS + 1))
fi

if [ "$VIOLATIONS" -gt 0 ]; then
  echo "[check-security-patterns] FAIL — $VIOLATIONS pattern(s) violated"
  exit 1
fi

echo "[check-security-patterns] OK"
exit 0
