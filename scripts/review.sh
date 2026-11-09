#!/usr/bin/env bash
# Local review runner: an independent CLI reviewer over the diff against the
# base branch. Prints a JSON verdict on the last line.
#
# Full deterministic suites run in GitHub CI as separate required checks.
# This command owns a bounded review -> safe write -> independent verification
# cycle. The internal write phase runs focused tests, never commits or posts.
# Verified edits return to the parent for commit; only the committed tree can
# receive pi-review success. A per-commit lock keeps one status owner per SHA.
#
# Usage:
#   ./scripts/review.sh                 # base = origin/main when available
#   ./scripts/review.sh --base develop  # override base
#   BASE=develop ./scripts/review.sh    # env-var override
#   ./scripts/review.sh --resume <handoff.json> --instructions <text-file>
#   ./scripts/review.sh --full          # force the cross-harness review
#                                       # (same as REVIEWER_MODE=full)
#
# Runs in $PWD — assumes deps installed. Push the branch first: the CI
# snapshot is empty for unpushed commits (the review still runs, diff-only).
#
# If a PR exists for the current branch, also posts an idempotent PR comment
# with the verdict (marker-keyed upsert). It posts a commit status named by
# PI_REVIEW_STATUS_CONTEXT (default: pi-review) whenever GitHub auth is
# available, so branch protection can require the local agent review.
# If there's no PR, the verdict still prints locally.
#
# Reviewer selection: Codex harnesses run Claude, while other environments
# (including Claude Code) run Codex. Override with REVIEWER_CLI=codex|claude.
# Auth uses the operator's selected CLI auth for the local review verdict, and
# `gh auth token` for GitHub (optional — missing auth just skips posting).
# Commit statuses use the legacy Statuses API because `gh api check-runs`
# requires GitHub App auth, and a user PAT cannot create check-runs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/review-commit-lock.sh
. "$SCRIPT_DIR/lib/review-commit-lock.sh"
# shellcheck source=scripts/lib/review-process.sh
. "$SCRIPT_DIR/lib/review-process.sh"
# shellcheck source=scripts/lib/review-reviewer.sh
. "$SCRIPT_DIR/lib/review-reviewer.sh"
# shellcheck source=scripts/lib/review-upstream-guard.sh
. "$SCRIPT_DIR/lib/review-upstream-guard.sh"
# shellcheck source=scripts/lib/review-bb.sh
. "$SCRIPT_DIR/lib/review-bb.sh"
# shellcheck source=scripts/lib/review-skip.sh
. "$SCRIPT_DIR/lib/review-skip.sh"
# shellcheck source=scripts/lib/review-cache.sh
. "$SCRIPT_DIR/lib/review-cache.sh"

# --- preflight --------------------------------------------------------------

for cmd in jq git node perl python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "$cmd not found on PATH." >&2; exit 2; }
done
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not inside a git work tree." >&2; exit 2; }
review_refuse_submodule || exit 2
review_load_config "$(git rev-parse --show-toplevel)"

GH_AVAILABLE=1
if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  GH_AVAILABLE=0
  echo ">> gh unavailable or not authed — will skip GitHub post"
fi

# --- args -------------------------------------------------------------------

if [ -n "${BASE:-}" ]; then
  BASE_BRANCH="$BASE"
elif git show-ref --verify --quiet refs/remotes/origin/main; then
  # Task worktrees often outlive the primary checkout's local `main` ref. Use
  # the fetched remote-tracking branch by default so a stale local main cannot
  # silently widen or distort the diff sent to the reviewer.
  BASE_BRANCH="origin/main"
else
  BASE_BRANCH="main"
fi
CLAUDE_REVIEW_MODEL="${CLAUDE_REVIEW_MODEL:-}"
CLAUDE_REVIEW_EFFORT="${CLAUDE_REVIEW_EFFORT:-high}"
CODEX_REVIEW_MODEL="${CODEX_REVIEW_MODEL:-}"
CODEX_REVIEW_EFFORT="${CODEX_REVIEW_EFFORT:-xhigh}"
REVIEWER_CLI="${REVIEWER_CLI:-auto}"
# light (default): skip the cross-harness reviewer for small safe-class diffs
# (inert docs, small snapshots/additive-tests/exact model swaps, or a pure
# Owletto pointer bump). full: always run the model review locally.
# REVIEWER_SHADOW=1 runs the full reviewer on a would-be-skipped diff and logs
# the skip decision alongside the real verdict for measuring the false-skip rate.
REVIEWER_MODE="${REVIEWER_MODE:-light}"
REVIEWER_SHADOW="${REVIEWER_SHADOW:-0}"
PI_REVIEW_STATUS_CONTEXT="${PI_REVIEW_STATUS_CONTEXT:-pi-review}"

# Verdict shape both the fresh-review validation and the cache-hit check rely
# on. Shared so a cached verdict is validated with the exact same predicate
# that validated it at store time.
SCHEMA_JQ="$(review_verdict_predicate)"
RESUME_FILE=""
INSTRUCTIONS_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || exit 2; BASE_BRANCH="$2"; shift 2 ;;
    --resume) [ $# -ge 2 ] || exit 2; RESUME_FILE="$2"; shift 2 ;;
    --instructions) [ $# -ge 2 ] || exit 2; INSTRUCTIONS_FILE="$2"; shift 2 ;;
    --full) REVIEWER_MODE="full"; shift 1 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$RESUME_FILE" ] || [ -n "$INSTRUCTIONS_FILE" ]; then
  if [ -z "$RESUME_FILE" ] || [ ! -s "$INSTRUCTIONS_FILE" ]; then
    echo '--resume <handoff.json> requires --instructions <nonempty text file>' >&2
    exit 2
  fi
  # Read instructions as data once; later edits to the file cannot change scope.
  PARENT_INSTRUCTIONS="$(cat "$INSTRUCTIONS_FILE")"
  if [ -z "$(printf '%s' "$PARENT_INSTRUCTIONS" | tr -d '[:space:]')" ]; then
    echo 'Resume instructions must not be blank' >&2
    exit 2
  fi
fi

REVIEW_MAX_AUTOFIX_PASSES="${REVIEW_MAX_AUTOFIX_PASSES:-2}"
case "$REVIEW_MAX_AUTOFIX_PASSES" in
  0|1|2) ;;
  *) echo "REVIEW_MAX_AUTOFIX_PASSES must be 0, 1, or 2" >&2; exit 2 ;;
esac
REVIEWER_CLI_SELECTED="$(review_select_reviewer "$REVIEWER_CLI")"

# Only the actual review run needs the reviewer CLI. A skip-eligible diff
# (REVIEWER_MODE=light) or a cached verdict reuses the gate without one, so the
# availability check is deferred into the run path below instead of failing the
# preflight.
review_require_reviewer() {
  command -v "$REVIEWER_CLI_SELECTED" >/dev/null 2>&1 || {
    review_fail_closed_message "$REVIEWER_CLI_SELECTED" "command not found on PATH" >&2
    exit 2
  }
}

HEAD_SHA="$(git rev-parse HEAD)"
MERGE_BASE="$(git merge-base HEAD "$BASE_BRANCH" 2>/dev/null || true)"
if [ -z "$MERGE_BASE" ]; then
  echo "could not find merge-base of HEAD and $BASE_BRANCH" >&2
  exit 2
fi

if [ -n "$RESUME_FILE" ]; then
  # Resume continues supplied findings; it never treats them as a new verdict.
  RESUME_CONTEXT="$(jq -cse 'if length == 1 and (.[0] | type == "object")
    then .[0] else error("Resume requires one JSON object") end' "$RESUME_FILE")" || exit 2
  if ! printf '%s\n' "$RESUME_CONTEXT" | jq -e \
      --arg head "$HEAD_SHA" --arg tree "$(review_worktree_tree)" \
      --arg worktree "$(pwd -P)" --arg base "$MERGE_BASE" \
      '.status == "needs_parent" and .head == $head and .tree == $tree and
       .worktree == $worktree and .merge_base == $base and
       .findings.verification.tree == .reviewed_tree and
       (.reason | IN("needs_decision", "autofix_limit", "fixer_failed",
         "invalid_fixer_result", "focused_tests_failed_or_missing", "verification_blocked"))' >/dev/null ||
     ! printf '%s\n' "$RESUME_CONTEXT" | jq -e ".findings | $SCHEMA_JQ" >/dev/null; then
    echo 'Resume handoff is invalid or stale; run make review for the current tree' >&2
    exit 2
  fi
fi

echo ">> cwd:  $(pwd)"
echo ">> base: $BASE_BRANCH (merge-base $MERGE_BASE)"
echo ">> head: $HEAD_SHA"
echo ">> reviewer: $REVIEWER_CLI_SELECTED"

# Before spending a reviewer run, make sure the verdict can actually land on
# the PR head. Runs ahead of the commit lock so a superseded
# HEAD costs nothing.
review_assert_head_is_current "$HEAD_SHA" "$PI_REVIEW_STATUS_CONTEXT" || exit 2

post_review_status() {
  [ "$GH_AVAILABLE" = "1" ] || return 0
  local state="$1"
  local description="$2"
  local target_url="${3:-}"
  local repo
  repo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  [ -n "$repo" ] || return 0

  # GitHub commit status descriptions are capped at 140 chars.
  description="${description:0:140}"
  local args=(-f "state=$state" -f "context=$PI_REVIEW_STATUS_CONTEXT" -f "description=$description")
  if [ -n "$target_url" ]; then
    args+=(-f "target_url=$target_url")
  fi
  gh api -X POST "repos/$repo/statuses/$HEAD_SHA" "${args[@]}" >/dev/null 2>&1 \
    || { echo ">> could not post '$PI_REVIEW_STATUS_CONTEXT'; rerun to publish the saved verdict" >&2; return 1; }
}

REVIEW_STATUS_STARTED=0
REVIEW_STATUS_FINALIZED=0
finalize_review_status() {
  # The upstream can move during the reviewer run. Do not finalize a verdict
  # on a commit that is no longer the PR head.
  if [ "$GH_AVAILABLE" = "1" ] &&
     ! review_assert_head_is_current "$HEAD_SHA" "$PI_REVIEW_STATUS_CONTEXT"; then
    # Suppress the EXIT trap's fallback error status on the same stale commit.
    REVIEW_STATUS_FINALIZED=1
    return 2
  fi
  if [ "$(git rev-parse HEAD)" != "$HEAD_SHA" ] ||
     { [ "$1" = success ] && [ -n "$(git status --porcelain)" ]; }; then
    post_review_status error "HEAD or working tree changed before final status"
    REVIEW_STATUS_FINALIZED=1
    return 2
  fi
  post_review_status "$1" "$2" "${3:-}"
  REVIEW_STATUS_FINALIZED=1
}

# --- safe-class skip output --------------------------------------------------

SKIP_MARKER="<!-- pi-review-skipped -->"

# Distinct marker + wording so a skipped merge is greppable/auditable, unlike a
# plain "success" status whose description nothing downstream parses.
post_skip_comment() {
  local description="$1" pr_json pr_number existing body
  [ "$GH_AVAILABLE" = "1" ] || return 0
  pr_json="$(gh pr view --json number 2>/dev/null || true)"
  pr_number="$(echo "$pr_json" | jq -r '.number // empty' 2>/dev/null || true)"
  [ -n "$pr_number" ] || return 0
  existing="$(gh api "repos/lobu-ai/lobu/issues/$pr_number/comments" --paginate --jq ".[] | select(.body | startswith(\"$SKIP_MARKER\")) | .id" | head -n1)"
  body="$SKIP_MARKER
**Cross-harness review skipped** — $description.

The deterministic CI suites remain required checks and still gate the merge. Run \`REVIEWER_MODE=full make review\` to force the independent review."
  if [ -n "$existing" ]; then
    jq -n --arg body "$body" '{body:$body}' | gh api -X PATCH "repos/lobu-ai/lobu/issues/comments/$existing" --input - >/dev/null
  else
    jq -n --arg body "$body" '{body:$body}' | gh api -X POST "repos/lobu-ai/lobu/issues/$pr_number/comments" --input - >/dev/null
  fi
  echo ">> posted skip comment on PR #$pr_number"
}

# Schema-shaped verdict so `make review` capture stays machine-readable; the
# honest "skipped" marker and status wording carry the audit trail.
skip_verdict_json() {
  jq -n --arg reason "$1" --arg tree "$(git rev-parse "HEAD^{tree}")" \
    '{decision:"pass",findings:[],verification:{tree:$tree,checked:[("Trusted safe-class policy: " + $reason)],missing:[]}}'
}

# Review can run alongside CI, but only green CI for the exact committed HEAD
# can publish success. Infrastructure retries reuse the cached semantic verdict.
ci_run_green_for_head() {
  [ "$GH_AVAILABLE" = 1 ] || return 1
  gh run list --workflow=ci.yml --commit "$HEAD_SHA" --limit 20 \
    --json status,conclusion \
    --jq 'any(.[]; .status == "completed" and .conclusion == "success")' \
    2>/dev/null | grep -qx true
}

# --- reviewer output persistence ---------------------------------------------
# The reviewer's full transcript is written to files in REVIEW_RUN_DIR and only
# a pointer is printed, so a long raw output cannot land in the calling agent's
# context; the file stays on disk for on-demand inspection.
review_persist_inline_output() {
  local raw_file="$1" diagnostic_file="$2"
  if [ -n "$raw_file" ] && [ -s "$raw_file" ]; then
    cp "$raw_file" "$REVIEW_RUN_DIR/reviewer-output.log"
  fi
  if [ -n "$diagnostic_file" ] && [ -s "$diagnostic_file" ]; then
    cp "$diagnostic_file" "$REVIEW_RUN_DIR/reviewer-output.stderr"
  fi
}

run_reviewer_inline() {
  local prompt_file="$1"
  local raw_file diagnostic_file
  if review_bb_wants_run; then
    review_bb_run_reviewer "$prompt_file" "$HEAD_SHA" "$BASE_BRANCH" "$DIFF_HASH" \
      "$REVIEWER_CLI_SELECTED" \
      "$(if [ "$REVIEWER_CLI_SELECTED" = "claude" ]; then printf '%s' "$CLAUDE_REVIEW_MODEL"; else printf '%s' "$CODEX_REVIEW_MODEL"; fi)" \
      "$(if [ "$REVIEWER_CLI_SELECTED" = "claude" ]; then printf '%s' "$CLAUDE_REVIEW_EFFORT"; else printf '%s' "$CODEX_REVIEW_EFFORT"; fi)" \
      "$SCHEMA_JQ and .verification.tree == \"$REVIEW_TREE\"" "$CI_CHECKS_FILE" "$REVIEWER_SIG|$(printf '%s' "${PARENT_INSTRUCTIONS:-}" | review_sha256 | cut -d' ' -f1)"
    return
  fi
  raw_file="$(mktemp /tmp/lobu-review-"${REVIEWER_CLI_SELECTED}"-inline.XXXXXX)"
  diagnostic_file="${raw_file}.stderr"
  REVIEW_INLINE_RAW_FILE="$raw_file"
  REVIEW_INLINE_DIAGNOSTIC_FILE="$diagnostic_file"
  set +e
  case "$REVIEWER_CLI_SELECTED" in
    claude)
      run_review_child env \
        BASE_BRANCH="$BASE_BRANCH" \
        HEAD_SHA="$HEAD_SHA" \
        CI_CHECKS_FILE="$CI_CHECKS_FILE" \
        claude -p "$(cat "$prompt_file")" \
          --model "$CLAUDE_REVIEW_MODEL" \
          --effort "$CLAUDE_REVIEW_EFFORT" \
          --json-schema "$(cat "$SCHEMA_FILE")" \
          --output-format text \
          --no-session-persistence \
          --tools Bash,Read,Grep,LS \
          --permission-mode bypassPermissions < /dev/null > "$raw_file"
      ;;
    codex)
      # The review subcommand cannot combine --base with the Lobu prompt. Use
      # structured exec so deterministic test results remain part of the gate.
      local codex_args=(
        codex exec
        --sandbox read-only
        --output-schema "$SCHEMA_FILE"
        --output-last-message "$raw_file"
        --ephemeral
      )
      if [ -n "$CODEX_REVIEW_MODEL" ]; then
        codex_args+=(--model "$CODEX_REVIEW_MODEL")
      fi
      if [ -n "$CODEX_REVIEW_EFFORT" ]; then
        # codex -c values are TOML, so the string needs embedded quotes.
        codex_args+=(-c "model_reasoning_effort=\"$CODEX_REVIEW_EFFORT\"")
      fi
      run_review_child env \
        BASE_BRANCH="$BASE_BRANCH" \
        HEAD_SHA="$HEAD_SHA" \
        CI_CHECKS_FILE="$CI_CHECKS_FILE" \
        "${codex_args[@]}" "$(cat "$prompt_file")" < /dev/null > /dev/null 2> "$diagnostic_file"
      ;;
  esac
  REVIEWER_EXIT=$?
  set -e
  RAW="$(cat "$raw_file" 2>/dev/null || true)"
  if [ "$REVIEWER_EXIT" -ne 0 ] && [ -s "$diagnostic_file" ]; then
    RAW="${RAW}${RAW:+$'\n'}$(cat "$diagnostic_file")"
  fi
  review_persist_inline_output "$raw_file" "$diagnostic_file"
  rm -f "$raw_file" "$diagnostic_file"
  REVIEW_INLINE_RAW_FILE=""
  REVIEW_INLINE_DIAGNOSTIC_FILE=""
}

run_reviewer() {
  local prompt_file="$1"
  run_reviewer_inline "$prompt_file"
}

review_exit_cleanup() {
  local ec=$? post_failure_status=0
  trap - EXIT INT TERM HUP
  stop_active_review_child
  review_bb_cancel_owned
  review_process_abort_inline
  if [ "$ec" -ne 0 ] && \
     [ "$REVIEW_STATUS_STARTED" = "1" ] && [ "$REVIEW_STATUS_FINALIZED" != "1" ]; then
    post_failure_status=1
  fi
  if [ "$post_failure_status" = "1" ]; then
    post_review_status error "$REVIEWER_CLI_SELECTED review failed before verdict (exit $ec)"
  fi
  exit "$ec"
}
trap review_exit_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Refuse duplicate reviews of this exact commit BEFORE posting any status:
# a non-owner must never touch the owner's pi-review status lifecycle.
acquire_commit_review_lock "$HEAD_SHA"
acquire_review_cycle_lock

REVIEW_RUN_DIR="$(mktemp -d /tmp/lobu-review.XXXXXX)"
echo ">> review run: $REVIEW_RUN_DIR"

# --- safe-class skip ---------------------------------------------------------
# REVIEWER_MODE=light (default) skips the cross-harness reviewer for small
# diffs confined to the path/content-gated safe classes in review-skip.sh. The
# deterministic CI suites still run as their own required checks; only the
# independent LLM verdict is skipped, and it is posted under its own marker so
# a skipped merge is auditable. The driving agent can force the full review
# with REVIEWER_MODE=full; REVIEWER_SHADOW=1 runs the full review on a
# would-be-skipped diff and logs both for measuring the false-skip rate.
# REVIEW_SKIP_REASON alone cannot signal eligibility: a failed classification
# leaves the ESCALATION reason in it, so eligibility gets its own flag.
REVIEW_SKIP_REASON=""
REVIEW_SKIP_ELIGIBLE=0
if [ -z "$RESUME_FILE" ] && [ -z "$(git status --porcelain)" ] && [ "$REVIEWER_MODE" != "full" ] && review_classify_diff "$BASE_BRANCH"; then
  REVIEW_SKIP_ELIGIBLE=1
  if [ "$REVIEWER_SHADOW" != "1" ]; then
    SKIP_DESCRIPTION="Skipped cross-harness review: $REVIEW_SKIP_REASON"
    echo ""
    echo "=========================================="
    echo "verdict: $SKIP_DESCRIPTION"
    echo "  (pass REVIEWER_MODE=full to force the cross-harness review)"
    echo "=========================================="
    if ! ci_run_green_for_head; then
      finalize_review_status pending "Safe-class change; waiting for CI on $HEAD_SHA"
      skip_verdict_json "$REVIEW_SKIP_REASON" | jq -c .
      exit 2
    fi
    finalize_review_status success "$SKIP_DESCRIPTION (REVIEWER_MODE=full to force)"
    post_skip_comment "$SKIP_DESCRIPTION"
    skip_verdict_json "$REVIEW_SKIP_REASON" | jq -c .
    exit 0
  fi
  echo ">> REVIEWER_SHADOW=1: running full review despite skip eligibility ($REVIEW_SKIP_REASON)"
fi

REVIEW_ROOT_DIR="$REVIEW_RUN_DIR"
AUTOFIX_PASSES=0
REVIEWER_SIG="$(review_reviewer_signature)"
REVIEW_PREVIOUS_TREE=""
REVIEW_PREVIOUS_BASE=""
REVIEW_PREVIOUS_THREAD=""
REVIEW_PREVIOUS_VERDICT=null
CYCLE_FILE="$(review_cycle_file)"
if [ -f "$CYCLE_FILE" ]; then
  jq -e '(.passes | type == "number" and floor == . and . >= 0 and . <= 2)' "$CYCLE_FILE" >/dev/null || {
    echo "Invalid review cycle state: $CYCLE_FILE" >&2; exit 2;
  }
  AUTOFIX_PASSES="$(jq -r .passes "$CYCLE_FILE")"
  if jq -e --arg sig "$REVIEWER_SIG" '.reviewer_sig == $sig' "$CYCLE_FILE" >/dev/null; then
    REVIEW_PREVIOUS_TREE="$(jq -r '.tree // ""' "$CYCLE_FILE")"
    REVIEW_PREVIOUS_BASE="$(jq -r '.base // ""' "$CYCLE_FILE")"
    REVIEW_PREVIOUS_THREAD="$(jq -r '.thread // ""' "$CYCLE_FILE")"
    REVIEW_PREVIOUS_VERDICT="$(jq -c '.verdict // null' "$CYCLE_FILE")"
  fi
fi
if [ -n "$RESUME_FILE" ]; then
  resume_passes="$(printf '%s\n' "$RESUME_CONTEXT" | jq -er '.autofix_passes | select(type == "number" and floor == . and . >= 0 and . <= 2)')" || exit 2
  if [ "$resume_passes" -gt "$AUTOFIX_PASSES" ]; then AUTOFIX_PASSES="$resume_passes"; fi
fi
HANDOFF_REASON=""
FIX_DECISIONS='[]'
RESUME_PENDING=0
[ -z "$RESUME_FILE" ] || RESUME_PENDING=1
while :; do
  REVIEW_RUN_DIR="$REVIEW_ROOT_DIR/pass-$AUTOFIX_PASSES"
  mkdir -p "$REVIEW_RUN_DIR"
  REVIEW_TREE="$(review_worktree_tree)" || exit 2

  # --- diff-hash verdict cache -------------------------------------------------
  # The reviewer is non-deterministic, so an unchanged diff must not be
  # re-reviewed: a passed diff can flip to fail and spawn a phantom fix cycle.
  # Cache the verdict on the exact diff content + reviewer identity, and reuse it
  # whenever the diff hash matches a previously issued verdict.
  DIFF_HASH="$(review_diff_hash "$BASE_BRANCH" "$REVIEW_TREE")"
  REVIEWER_SIG="$(review_reviewer_signature)"
  CACHE_FILE="$(review_cache_lookup "$DIFF_HASH" "$REVIEWER_SIG" || true)"
  CACHE_HIT=0
  REVIEWER_EXIT=0
  if [ -n "$CACHE_FILE" ]; then
    # SCHEMA_JQ validates a verdict object; the cache file wraps it in .verdict,
    # so pipe the wrapper field into the same predicate used at store time.
    if jq -e ".verdict | $SCHEMA_JQ" "$CACHE_FILE" >/dev/null 2>&1; then
      echo ">> reusing cached $REVIEWER_CLI_SELECTED verdict for diff $DIFF_HASH"
      VERDICT="$(jq -c .verdict "$CACHE_FILE")"
      CACHE_HIT=1
      CI_CHECKS_FILE="(reused cached verdict)"
    else
      echo ">> cached verdict for diff $DIFF_HASH is invalid; removing and re-reviewing" >&2
      rm -f "$CACHE_FILE"
      CACHE_FILE=""
    fi
  fi

  if [ "$RESUME_PENDING" = 1 ]; then
    RESUME_PENDING=0
    if [ "$REVIEW_TREE" != "$(printf '%s\n' "$RESUME_CONTEXT" | jq -r .tree)" ]; then
      echo 'Tree changed after resume validation; refusing stale findings' >&2
      exit 2
    fi
    if printf '%s\n' "$RESUME_CONTEXT" | jq -e --arg tree "$REVIEW_TREE" \
        '.reviewed_tree == $tree and .findings.decision != "verification_blocked"' >/dev/null; then
      VERDICT="$(printf '%s\n' "$RESUME_CONTEXT" | jq -c .findings)"
      CACHE_HIT=1
      CI_CHECKS_FILE="(resuming prior findings)"
      echo ">> resuming findings with explicit parent instructions"
    else
      # A partial writer tree or newly available verification requires a fresh
      # read-only turn, even if the old blocked verdict was cached.
      CACHE_HIT=0
    fi
  fi

  if [ "$CACHE_HIT" != "1" ]; then
    review_require_model "$REVIEWER_CLI_SELECTED" || exit $?
    if review_bb_wants_run; then
      echo ">> BB context detected ($BB_THREAD_ID): routing the review through a visible BB child thread"
    else
      review_require_reviewer
    fi
    REVIEW_STATUS_STARTED=1
    post_review_status pending "$REVIEWER_CLI_SELECTED review running"
  fi

  # --- run path: snapshot and reviewer ------------------------------------
  # Only reached when there is no usable cached verdict.
  if [ "$CACHE_HIT" != "1" ]; then

  # --- CI check snapshot -------------------------------------------------------
  # The deterministic suites run in GitHub CI as their own required status
  # checks; branch protection enforces them independently of this verdict. The
  # snapshot is context for the reviewer (correlate failures with the diff), not
  # a gate — pending checks must not block or degrade the agent review.

  CI_CHECKS_FILE="$REVIEW_RUN_DIR/ci-checks.txt"
  CI_SNAPSHOT_OK=0
  if [ "$GH_AVAILABLE" = "1" ]; then
    REPO_NWO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
    if [ -n "$REPO_NWO" ] && gh api "repos/$REPO_NWO/commits/$HEAD_SHA/check-runs" --paginate \
        -q '.check_runs[] | "\(.name): \(.status)\(if .conclusion != null then " " + .conclusion else "" end)"' \
        2>/dev/null | sort -u > "$CI_CHECKS_FILE" && [ -s "$CI_CHECKS_FILE" ]; then
      CI_SNAPSHOT_OK=1
    fi
  fi
  if [ "$CI_SNAPSHOT_OK" != "1" ]; then
    echo "CI state unknown: no check runs found for $HEAD_SHA (unpushed commit, CI not started, or gh unavailable)" > "$CI_CHECKS_FILE"
  fi
  echo ">> CI check snapshot → $CI_CHECKS_FILE"
  sed 's/^/>>   /' "$CI_CHECKS_FILE"

  # --- agent review -----------------------------------------------------------

  PROMPT_FILE="$(pwd)/prompts/review-prompt.md"
  # Shared by both reviewer CLIs below, which do NOT accept the same dialect:
  # `claude --json-schema` refuses a `$schema` meta-reference outright ("no
  # schema with key or ref …") while codex ignores it. The schema therefore
  # declares no dialect — see scripts/__tests__/review-output-schema.test.ts.
  SCHEMA_FILE="$(pwd)/prompts/review-output-schema.json"
  [ -f "$PROMPT_FILE" ] || { echo "prompt not found: $PROMPT_FILE" >&2; exit 2; }
  [ -f "$SCHEMA_FILE" ] || { echo "schema not found: $SCHEMA_FILE" >&2; exit 2; }

  echo ">> invoking $REVIEWER_CLI_SELECTED review"
  REVIEW_PROMPT_FILE="$(mktemp /tmp/lobu-review-prompt.XXXXXX)"
  # Render the exact snapshot into every diff command. HEAD remains the parent
  # commit while the write phase leaves its edits uncommitted for inspection.
  # The quoted range must lose its quotes: `git diff "<base> <tree>"` is one
  # unknown revision, not two.
  REVIEW_TREE="$REVIEW_TREE" MERGE_BASE="$MERGE_BASE" node - "$PROMPT_FILE" > "$REVIEW_PROMPT_FILE" <<'JS'
const fs = require('node:fs');
const target = process.env.MERGE_BASE + ' ' + process.env.REVIEW_TREE;
process.stdout.write(fs.readFileSync(process.argv[2], 'utf8')
  .replaceAll('"$BASE_BRANCH...HEAD"', target)
  .replaceAll('$BASE_BRANCH...HEAD', target));
JS
  printf '\nReview target tree: %s (driver HEAD %s). Inspect uncommitted edits too.\n' "$REVIEW_TREE" "$HEAD_SHA" >> "$REVIEW_PROMPT_FILE"
  if [ -n "$REVIEW_PREVIOUS_TREE" ] && git cat-file -e "$REVIEW_PREVIOUS_TREE^{tree}" 2>/dev/null; then
    {
      printf '\nPrevious reviewed tree: %s\n' "$REVIEW_PREVIOUS_TREE"
      printf 'Previous verdict: %s\n' "$REVIEW_PREVIOUS_VERDICT"
      printf 'Fix delta: git diff %s %s\n' "$REVIEW_PREVIOUS_TREE" "$REVIEW_TREE"
      if [ "$REVIEW_PREVIOUS_BASE" = "$MERGE_BASE" ]; then
        printf 'Verify prior blocking findings and inspect the delta plus affected callers for regressions. Expand to a full review if scope or risk expanded. Do not reopen optional suggestions without new evidence.\n'
      else
        printf 'The merge base changed. Perform a full review against the new base.\n'
      fi
    } >> "$REVIEW_PROMPT_FILE"
  fi
  if [ -n "$RESUME_FILE" ]; then
    printf '\nDriving agent instructions: %s\n' "$PARENT_INSTRUCTIONS" >> "$REVIEW_PROMPT_FILE"
  fi
  printf '\n\nEmit only the JSON verdict, binding verification.tree to %s.\n' "$REVIEW_TREE" >> "$REVIEW_PROMPT_FILE"
  run_reviewer "$REVIEW_PROMPT_FILE"
  rm -f "$REVIEW_PROMPT_FILE"

  VERDICT="$RAW"
  VERDICT="$(extract_json_verdict "$VERDICT")"
  fi

  # A cache hit skips the reviewer, so REVIEWER_EXIT stays 0 and its verdict
  # already passed this predicate at lookup.
  if [ "$REVIEWER_EXIT" -ne 0 ] || ! echo "$VERDICT" | jq -e "$SCHEMA_JQ and .verification.tree == \"$REVIEW_TREE\"" >/dev/null 2>&1; then
    if [ "$REVIEWER_EXIT" -ne 0 ]; then
      REVIEW_FAILURE_DETAIL="reviewer process exited with status $REVIEWER_EXIT"
    else
      REVIEW_FAILURE_DETAIL="reviewer returned no schema-valid JSON verdict"
    fi
    finalize_review_status error "Independent $REVIEWER_CLI_SELECTED review could not be completed"
    review_fail_closed_message "$REVIEWER_CLI_SELECTED" "$REVIEW_FAILURE_DETAIL" >&2
    echo "logs: ${BUILD_LOG:-} $CI_CHECKS_FILE" >&2
    echo "full reviewer output: $REVIEW_RUN_DIR/reviewer-output.log" >&2
    echo "reviewer diagnostics: $REVIEW_RUN_DIR/reviewer-output.stderr" >&2
    exit 1
  fi

  if [ "$(git rev-parse HEAD)" != "$HEAD_SHA" ] ||
     [ "$(review_worktree_tree)" != "$REVIEW_TREE" ]; then
    finalize_review_status error "Tree changed during independent review; verdict discarded"
    echo "Review target moved; refusing stale verdict" >&2
    exit 1
  fi
  printf '%s\n' "$VERDICT" > "$REVIEW_RUN_DIR/findings.json"

  # Only schema-valid fresh verdicts are cached; a cached verdict is re-validated
  # on read with the same predicate, so a tampered or stale entry self-heals.
  if [ "$CACHE_HIT" != "1" ]; then
    review_cache_store "$DIFF_HASH" "$REVIEWER_SIG" "$BASE_BRANCH" "$HEAD_SHA" "$VERDICT"
  fi

  REVIEW_PREVIOUS_TREE="$REVIEW_TREE"
  REVIEW_PREVIOUS_BASE="$MERGE_BASE"
  REVIEW_PREVIOUS_VERDICT="$VERDICT"
  review_cycle_save

  # REVIEWER_SHADOW measurement: the skip classifier said "safe" but the full
  # review ran anyway. Record both so the false-skip rate can be measured instead
  # of asserted. Only logged for skip-eligible diffs (the population the rule is
  # trusted on); non-eligible diffs are the baseline, not a skip bet. Only fresh
  # verdicts are recorded — a cache-hit rerun of the same diff would just
  # duplicate a row and inflate the sample.
  if [ "$REVIEWER_SHADOW" = "1" ] && [ "$REVIEW_SKIP_ELIGIBLE" = "1" ] && [ "$CACHE_HIT" != "1" ]; then
    mkdir -p "$(review_cache_root)"
    jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg base "$BASE_BRANCH" --arg head "$HEAD_SHA" \
      --arg hash "$DIFF_HASH" --arg reason "$REVIEW_SKIP_REASON" --argjson verdict "$VERDICT" \
      '{ts:$ts,base:$base,head:$head,diff_hash:$hash,skip_reason:$reason,verdict:$verdict}' \
      >> "$(review_cache_root)/shadow-audit.jsonl"
    echo ">> shadow audit: skip-eligible diff reviewed; recorded at $(review_cache_root)/shadow-audit.jsonl"
  fi

  DECISION="$(echo "$VERDICT" | jq -r .decision)"
  BLOCKER_COUNT="$(echo "$VERDICT" | jq '[.findings[] | select(.blocking)] | length')"
  HEADLINE="$DECISION; $BLOCKER_COUNT blocking findings"
  STATUS_STATE=failure
  STATUS_DESCRIPTION="$HEADLINE"
  if [ "$DECISION" = pass ]; then STATUS_STATE=success; fi
  if [ "$DECISION" = verification_blocked ]; then
    HANDOFF_REASON=verification_blocked
    break
  fi

  if [ "$STATUS_STATE" = success ]; then
    if [ -n "$(git status --porcelain)" ]; then
      HANDOFF_REASON="needs_commit"
      STATUS_STATE="failure"
      STATUS_DESCRIPTION="Verified working tree; commit, push, and rerun make review for pi-review"
    fi
    break
  fi
  if [ "$AUTOFIX_PASSES" -ge "$REVIEW_MAX_AUTOFIX_PASSES" ]; then
    HANDOFF_REASON="autofix_limit"
    break
  fi
  if [ "$(git rev-parse HEAD)" != "$HEAD_SHA" ] || [ "$(review_worktree_tree)" != "$REVIEW_TREE" ]; then
    echo 'Tree moved before the write phase; refusing stale fixes' >&2
    exit 1
  fi
  AUTOFIX_PASSES=$((AUTOFIX_PASSES + 1))
  # Consume the slot before dispatch, including failures/interruption. Resume
  # or a plain rerun cannot silently buy another two automatic writes.
  review_cycle_save
  FIX_RESULT="$REVIEW_ROOT_DIR/fix-$AUTOFIX_PASSES.json"
  echo ">> write phase $AUTOFIX_PASSES/$REVIEW_MAX_AUTOFIX_PASSES; findings: $REVIEW_RUN_DIR/findings.json"
  WRITE_FINDINGS="$REVIEW_RUN_DIR/write-context.json"
  jq -n --argjson verdict "$VERDICT" --argjson prior "${RESUME_CONTEXT:-null}" \
    --arg instructions "${PARENT_INSTRUCTIONS:-}" \
    '{findings:[$verdict.findings[] | select(.blocking)],prior_decisions:($prior.decisions // []),parent_instructions:$instructions}' > "$WRITE_FINDINGS"
  if ! run_review_child bash "$SCRIPT_DIR/lib/review-write.sh" --base "$BASE_BRANCH" \
      --findings "$WRITE_FINDINGS" --result "$FIX_RESULT"; then
    HANDOFF_REASON="fixer_failed"
    break
  fi
  if [ "$(git rev-parse HEAD)" != "$HEAD_SHA" ]; then
    echo 'Writer changed HEAD; refusing its result' >&2
    exit 1
  fi
  if ! review_validate_fix_result "$FIX_RESULT"; then
    HANDOFF_REASON="invalid_fixer_result"
    break
  fi
  FIX_DECISIONS="$(jq -c .decisions "$FIX_RESULT")"
  if [ "$(jq '.decisions | length' "$FIX_RESULT")" -gt 0 ]; then
    HANDOFF_REASON="needs_decision"
    break
  fi
  if ! jq -e '(.tests | length > 0) and all(.tests[]; .passed)' "$FIX_RESULT" >/dev/null; then
    HANDOFF_REASON="focused_tests_failed_or_missing"
    break
  fi
  # Resume the independent read-only reviewer. Its output must name the new
  # tree; the writer's summary cannot approve its own fixes.
done

if [ -n "$HANDOFF_REASON" ]; then
  STATUS_STATE="failure"
  STATUS_DESCRIPTION="$HANDOFF_REASON; $STATUS_DESCRIPTION"
  jq -n --arg reason "$HANDOFF_REASON" --arg head "$HEAD_SHA" \
    --arg tree "$(review_worktree_tree)" --arg reviewed_tree "$REVIEW_TREE" --argjson passes "$AUTOFIX_PASSES" \
    --argjson decisions "$FIX_DECISIONS" --argjson findings "$VERDICT" \
    --arg worktree "$(pwd -P)" --arg base "$MERGE_BASE" \
    '{status:"needs_parent",reason:$reason,head:$head,tree:$tree,reviewed_tree:$reviewed_tree,autofix_passes:$passes,decisions:$decisions,findings:$findings,worktree:$worktree,merge_base:$base}' \
    > "$REVIEW_ROOT_DIR/handoff.json"
  echo ">> structured parent handoff: $REVIEW_ROOT_DIR/handoff.json"
  if [ "$HANDOFF_REASON" != needs_commit ]; then
    echo ">> resolve decisions in a text file, then: make review RESUME=$REVIEW_ROOT_DIR/handoff.json INSTRUCTIONS=<file>"
  fi
fi

echo ""
echo "=========================================="
echo "verdict: $HEADLINE"
echo "  ci:    $CI_CHECKS_FILE"
echo "=========================================="

# --- optional GitHub post --------------------------------------------------

PR_NUMBER=""
PR_URL=""
if [ "$GH_AVAILABLE" = "1" ]; then
  PR_JSON="$(gh pr view --json number,url 2>/dev/null || true)"
  PR_NUMBER="$(echo "$PR_JSON" | jq -r '.number // empty' 2>/dev/null || true)"
  PR_URL="$(echo "$PR_JSON" | jq -r '.url // empty' 2>/dev/null || true)"
fi

if [ "$STATUS_STATE" = success ] && ! ci_run_green_for_head; then
  STATUS_STATE=pending
  STATUS_DESCRIPTION="Review passed; waiting for CI on $HEAD_SHA"
  echo ">> semantic verdict saved; rerun after CI without another model review"
fi
finalize_review_status "$STATUS_STATE" "$STATUS_DESCRIPTION" "$PR_URL"

if [ -z "$PR_NUMBER" ]; then
  echo ">> no PR for current branch; skipping GitHub comment"
else
  # A push between the final status and this comment would make the displayed
  # verdict stale even though branch protection correctly blocks the new head.
  review_assert_head_is_current "$HEAD_SHA" "$PI_REVIEW_STATUS_CONTEXT" || exit 2
  PRETTY="$(echo "$VERDICT" | jq .)"
  FINDINGS_LIST="$(echo "$VERDICT" | jq -r '.findings | map("- " + (if .blocking then "**Blocking** " else "Optional: " end) + "`" + .file + ":" + ((.line // "") | tostring) + "`: " + .issue + " Evidence: " + .evidence) | join("\n")')"
  # shellcheck disable=SC2016 # Markdown fences are literal.
  SUMMARY="$(printf '**%s**\n\n%s\n\n<details><summary>Verification and full verdict</summary>\n\n```json\n%s\n```\n\n</details>' "$STATUS_DESCRIPTION" "$FINDINGS_LIST" "$PRETTY")"

  MARKER="<!-- pi-review-marker -->"
  COMMENT_BODY="$MARKER
$SUMMARY"
  EXISTING_COMMENT_ID="$(gh api "repos/lobu-ai/lobu/issues/$PR_NUMBER/comments" --paginate --jq ".[] | select(.body | startswith(\"$MARKER\")) | .id" | head -n1)"
  if [ -n "$EXISTING_COMMENT_ID" ]; then
    echo ">> updating PR comment $EXISTING_COMMENT_ID"
    jq -n --arg body "$COMMENT_BODY" '{body:$body}' | gh api -X PATCH "repos/lobu-ai/lobu/issues/comments/$EXISTING_COMMENT_ID" --input - >/dev/null
  else
    echo ">> creating PR comment"
    jq -n --arg body "$COMMENT_BODY" '{body:$body}' | gh api -X POST "repos/lobu-ai/lobu/issues/$PR_NUMBER/comments" --input - >/dev/null
  fi
  echo ">> posted comment on PR #$PR_NUMBER"
fi

# Last line: machine-readable verdict for $(make review) capture.
echo "$VERDICT" | jq -c .

[ "$STATUS_STATE" != pending ] || exit 2
[ "$STATUS_STATE" = success ] || exit 1
