#!/usr/bin/env bash
# Local review runner: an independent CLI reviewer over the diff against the
# base branch. Prints a JSON verdict on the last line.
#
# The deterministic suites (typecheck / unit / integration / migrations /
# frontend) run in GitHub CI, NOT here — they are separate required status
# checks on main, so auto-merge already blocks on them. This script's job is
# only the agent verdict: it snapshots the head commit's CI check state for
# the reviewer's context, runs the reviewer on the diff, and posts the
# verdict. Because nothing here boots Postgres or binds ports, reviews of
# different commits execute concurrently — there is no host-wide lock. The
# one serialization left is per commit: every run posts the same pi-review
# status for its HEAD sha, so a duplicate run of the SAME commit is refused
# rather than allowed to race the owner's status posts.
#
# Usage:
#   ./scripts/review.sh                 # base = origin/main when available
#   ./scripts/review.sh --base develop  # override base
#   BASE=develop ./scripts/review.sh    # env-var override
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
# shellcheck source=scripts/lib/review-skip.sh
. "$SCRIPT_DIR/lib/review-skip.sh"
# shellcheck source=scripts/lib/review-cache.sh
. "$SCRIPT_DIR/lib/review-cache.sh"
# shellcheck source=scripts/lib/remote-ci.sh
. "$SCRIPT_DIR/lib/remote-ci.sh"

# --- preflight --------------------------------------------------------------

for cmd in jq git node perl python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "$cmd not found on PATH." >&2; exit 2; }
done
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not inside a git work tree." >&2; exit 2; }

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
CLAUDE_REVIEW_MODEL="${CLAUDE_REVIEW_MODEL:-fable}"
CLAUDE_REVIEW_EFFORT="${CLAUDE_REVIEW_EFFORT:-high}"
# Codex defaults assume API-key auth: the ChatGPT account backend rejects
# gpt-5.6-sol ("not supported when using Codex with a ChatGPT account"), so
# ChatGPT-backed operators must override CODEX_REVIEW_MODEL.
CODEX_REVIEW_MODEL="${CODEX_REVIEW_MODEL:-gpt-5.6-sol}"
CODEX_REVIEW_EFFORT="${CODEX_REVIEW_EFFORT:-xhigh}"
REVIEWER_CLI="${REVIEWER_CLI:-auto}"
# light (default): skip the cross-harness reviewer for small safe-class diffs
# (docs/renames/generated/root bun.lock/snapshots/additive-tests, exact model
# route swaps, or a pure Owletto pointer bump; <100 lines). full: always run it.
# REVIEWER_SHADOW=1 runs the full reviewer on a would-be-skipped diff and logs
# the skip decision alongside the real verdict for measuring the false-skip rate.
REVIEWER_MODE="${REVIEWER_MODE:-light}"
REVIEWER_SHADOW="${REVIEWER_SHADOW:-0}"
REVIEW_ALLOW_LOCAL_BUILD="${REVIEW_ALLOW_LOCAL_BUILD:-0}"
PI_REVIEW_STATUS_CONTEXT="${PI_REVIEW_STATUS_CONTEXT:-pi-review}"

# Verdict shape both the fresh-review validation and the cache-hit check rely
# on. Shared so a cached verdict is validated with the exact same predicate
# that validated it at store time.
SCHEMA_JQ='(.bug_free_confidence | type == "number" and floor == . and . >= 0 and . <= 100) and (.bugs | type == "number" and floor == . and . >= 0) and (.slop | type == "number" and floor == . and . >= 0 and . <= 100) and (.simplicity | type == "number" and floor == . and . >= 0 and . <= 100) and (.blockers | type == "array") and (.change_type | IN("feat", "fix", "refactor", "docs", "chore", "test", "deps")) and (.runtime_change_risk | IN("none", "low", "medium", "high")) and (.tests_adequate | type == "boolean") and (.suggested_fixes | type == "array") and (.notes | type == "string") and (.categories | type == "object")'
PI_REVIEW_MIN_BUG_FREE="${PI_REVIEW_MIN_BUG_FREE:-80}"
PI_REVIEW_MAX_SLOP="${PI_REVIEW_MAX_SLOP:-15}"
PI_REVIEW_MIN_SIMPLICITY="${PI_REVIEW_MIN_SIMPLICITY:-70}"
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE_BRANCH="$2"; shift 2 ;;
    --full) REVIEWER_MODE="full"; shift 1 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

REVIEWER_CLI_SELECTED="$(review_select_reviewer "$REVIEWER_CLI")"

# Only the actual review run needs the reviewer CLI. A skip-eligible diff
# (REVIEWER_MODE=light) or a cached verdict reuses the gate without one, so the
# availability check is deferred into the run path below instead of failing the
# preflight.
review_require_reviewer() {
  if [ "$REVIEWER_CLI_SELECTED" = "claude" ]; then
    review_validate_claude_model "$CLAUDE_REVIEW_MODEL" || exit $?
  fi
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

echo ">> cwd:  $(pwd)"
echo ">> base: $BASE_BRANCH (merge-base $MERGE_BASE)"
echo ">> head: $HEAD_SHA"
echo ">> reviewer: $REVIEWER_CLI_SELECTED"

# Before spending a reviewer run, make sure the verdict can actually land on
# the PR head. Runs ahead of the build and the commit lock so a superseded
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
    || echo ">> warning: failed to post GitHub commit status '$PI_REVIEW_STATUS_CONTEXT'" >&2
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
  jq -n --arg reason "$1" \
    '{bug_free_confidence:100,bugs:0,slop:0,simplicity:100,blockers:[],change_type:"chore",runtime_change_risk:"none",tests_adequate:true,suggested_fixes:[],notes:("Cross-harness review skipped: " + $reason + ". Pass REVIEWER_MODE=full to force an independent review."),categories:{},skipped_cross_harness:true}'
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

extract_json_verdict() {
  local raw="$1"
  local fenced object
  fenced="$(
    printf '%s\n' "$raw" | awk '
      /^[[:space:]]*```json[[:space:]]*$/ { in_json = 1; next }
      /^[[:space:]]*```[[:space:]]*$/ && in_json { exit }
      in_json { print }
    '
  )"
  if [ -n "$fenced" ] && printf '%s\n' "$fenced" | jq -e . >/dev/null 2>&1; then
    printf '%s\n' "$fenced"
    return
  fi

  if command -v node >/dev/null 2>&1; then
    object="$(
      printf '%s\n' "$raw" | node -e '
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8");

function candidateFrom(start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return null;
}

for (let i = 0; i < raw.length; i += 1) {
  if (raw[i] !== "{") continue;
  const candidate = candidateFrom(i);
  if (!candidate) continue;
  try {
    JSON.parse(candidate);
    process.stdout.write(candidate);
    process.exit(0);
  } catch {
  }
}

process.exit(1);
' 2>/dev/null || true
    )"
    if [ -n "$object" ] && printf '%s\n' "$object" | jq -e . >/dev/null 2>&1; then
      printf '%s\n' "$object"
      return
    fi
  fi

  printf '%s\n' "$raw" | sed -e 's/^```json//' -e 's/^```//' -e 's/```$//'
}

review_exit_cleanup() {
  local ec=$? post_failure_status=0
  trap - EXIT INT TERM HUP
  stop_active_review_child
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

REVIEW_RUN_DIR="$(mktemp -d /tmp/lobu-review.XXXXXX)"

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
if [ "$REVIEWER_MODE" != "full" ] && review_classify_diff "$BASE_BRANCH"; then
  REVIEW_SKIP_ELIGIBLE=1
  if [ "$REVIEWER_SHADOW" != "1" ]; then
    SKIP_DESCRIPTION="Skipped cross-harness review: $REVIEW_SKIP_REASON"
    echo ""
    echo "=========================================="
    echo "verdict: $SKIP_DESCRIPTION"
    echo "  (pass REVIEWER_MODE=full to force the cross-harness review)"
    echo "=========================================="
    finalize_review_status success "$SKIP_DESCRIPTION (REVIEWER_MODE=full to force)"
    post_skip_comment "$SKIP_DESCRIPTION"
    skip_verdict_json "$REVIEW_SKIP_REASON" | jq -c .
    exit 0
  fi
  echo ">> REVIEWER_SHADOW=1: running full review despite skip eligibility ($REVIEW_SKIP_REASON)"
fi

# --- diff-hash verdict cache -------------------------------------------------
# The reviewer is non-deterministic, so an unchanged diff must not be
# re-reviewed: a passed diff can flip to fail and spawn a phantom fix cycle.
# Cache the verdict on the exact diff content + reviewer identity, and reuse it
# whenever the diff hash matches a previously issued verdict.
DIFF_HASH="$(review_diff_hash "$BASE_BRANCH")"
REVIEWER_SIG="$(review_reviewer_signature)"
CACHE_FILE="$(review_cache_lookup "$DIFF_HASH" "$REVIEWER_SIG" || true)"
CACHE_HIT=0
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

# True when a completed ci.yml run for the exact commit passed.
# ci.yml triggers on pull_request events, so runs are found by head sha.
#
# Asks across every run for the sha rather than the single newest one: a push
# can dispatch two runs in the same second, the concurrency group cancels the
# duplicate, and both then carry an identical `createdAt`. `--limit 1` orders
# by that timestamp, so it returns the cancelled twin about half the time and
# the gate rejects a commit whose CI is green. Any completed success for this
# sha validated this exact tree, which is what the gate needs to establish.
ci_run_green_for_head() {
  local sha="$1"
  gh run list --workflow=ci.yml --commit "$sha" --limit 20 \
    --json status,conclusion \
    --jq 'any(.[]; .status == "completed" and .conclusion == "success")' \
    2>/dev/null | grep -qx true
}

# A fresh full review must reuse the exact committed tree that GitHub CI
# validated. Refuse to surprise the operator with a CPU-heavy local package
# build; the explicit override is for when CI cannot run for this HEAD.
GITHUB_CI_GREEN=0
if [ -z "$(git status --porcelain)" ] && ci_run_green_for_head "$HEAD_SHA"; then
  GITHUB_CI_GREEN=1
fi
if [ "$GITHUB_CI_GREEN" != "1" ] && [ "$CACHE_HIT" != "1" ] && [ "$REVIEW_ALLOW_LOCAL_BUILD" != "1" ]; then
  echo "make review requires GitHub CI (workflow ci.yml) to have passed for $HEAD_SHA." >&2
  echo "Push the commit and wait for the PR's CI to finish, then re-run." >&2
  echo "Override only when CI cannot run: REVIEW_ALLOW_LOCAL_BUILD=1 make review" >&2
  exit 2
fi

REVIEW_STATUS_STARTED=0
if [ "$CACHE_HIT" != "1" ]; then
  review_require_reviewer
  REVIEW_STATUS_STARTED=1
  post_review_status pending "$REVIEWER_CLI_SELECTED review running"
fi

# --- run path: snapshot, build, reviewer ------------------------------------
# Only reached when there is no usable cached verdict. Snapshotting CI, the
# build, and the reviewer session are all only useful for a fresh review.
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

# --- build ------------------------------------------------------------------
# The reviewer's exploratory probes (targeted bun test runs, CLI invocations)
# need workspace packages built. Reuse the clean tree GitHub CI already built;
# otherwise rebuild locally so a stale or missing dist cannot create noise.

BUILD_LOG="$REVIEW_RUN_DIR/build.log"
if [ "$GITHUB_CI_GREEN" = "1" ]; then
  echo ">> GitHub CI already passed for $HEAD_SHA; skipping duplicate local package build"
  printf 'Skipped: GitHub CI passed for %s\n' "$HEAD_SHA" > "$BUILD_LOG"
  BUILD_EXIT=0
else
  echo ">> make build-packages → $BUILD_LOG"
  set +e
  run_review_child make build-packages > "$BUILD_LOG" 2>&1
  BUILD_EXIT=$?
  set -e
  if [ $BUILD_EXIT -ne 0 ]; then
    echo "!! build failed (exit $BUILD_EXIT) — proceeding so $REVIEWER_CLI_SELECTED can review the diff, but exploratory probes may fail" >&2
  fi
fi

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
cat "$PROMPT_FILE" > "$REVIEW_PROMPT_FILE"
printf '\n\nReview the diff. Emit only the JSON verdict.\n' >> "$REVIEW_PROMPT_FILE"
run_reviewer "$REVIEW_PROMPT_FILE"
rm -f "$REVIEW_PROMPT_FILE"

VERDICT="$RAW"
VERDICT="$(extract_json_verdict "$VERDICT")"
fi

# On the cache-hit path REVIEWER_EXIT/BUILD_LOG were never set (the verdict
# already passed this exact predicate at lookup, so this branch is unreachable
# there); default them so `set -u` cannot turn a future edit into a crash.
if ! echo "$VERDICT" | jq -e "$SCHEMA_JQ" >/dev/null 2>&1; then
  if [ "${REVIEWER_EXIT:-0}" -ne 0 ]; then
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

# Only schema-valid fresh verdicts are cached; a cached verdict is re-validated
# on read with the same predicate, so a tampered or stale entry self-heals.
if [ "$CACHE_HIT" != "1" ]; then
  review_cache_store "$DIFF_HASH" "$REVIEWER_SIG" "$BASE_BRANCH" "$HEAD_SHA" "$VERDICT"
fi

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

BUG_FREE="$(echo "$VERDICT" | jq -r .bug_free_confidence)"
BUGS="$(echo "$VERDICT" | jq -r .bugs)"
SLOP="$(echo "$VERDICT" | jq -r .slop)"
SIMPLICITY="$(echo "$VERDICT" | jq -r .simplicity)"
TESTS_ADEQUATE="$(echo "$VERDICT" | jq -r .tests_adequate)"
RISK="$(echo "$VERDICT" | jq -r .runtime_change_risk)"
BLOCKER_COUNT="$(echo "$VERDICT" | jq -r '.blockers|length')"
HEADLINE="bug_free $BUG_FREE, simplicity $SIMPLICITY, slop $SLOP, bugs $BUGS, $BLOCKER_COUNT blockers, risk $RISK"
STATUS_STATE="success"
STATUS_REASONS=()
[ "$BUG_FREE" -ge "$PI_REVIEW_MIN_BUG_FREE" ] || STATUS_REASONS+=("bug_free<$PI_REVIEW_MIN_BUG_FREE")
[ "$BUGS" -eq 0 ] || STATUS_REASONS+=("bugs>0")
[ "$SLOP" -le "$PI_REVIEW_MAX_SLOP" ] || STATUS_REASONS+=("slop>$PI_REVIEW_MAX_SLOP")
[ "$SIMPLICITY" -ge "$PI_REVIEW_MIN_SIMPLICITY" ] || STATUS_REASONS+=("simplicity<$PI_REVIEW_MIN_SIMPLICITY")
[ "$BLOCKER_COUNT" -eq 0 ] || STATUS_REASONS+=("blockers>0")
[ "$TESTS_ADEQUATE" = "true" ] || STATUS_REASONS+=("tests inadequate")
# `runtime_change_risk` is REPORTED in the headline (see HEADLINE above) but
# never gates. The check exists so the reviewer catches DEFECTS before a merge,
# and bugs/blockers already cover those; a self-reported tier is not a defect.
# Its rubric (docs/REVIEW_SCHEMA.md) classifies any queue/scheduler/retry change
# as "high", so gating on it blocked routine fixes at 0 bugs and 0 blockers, and
# the only way past was disabling enforce_admins on main — strictly worse than
# merging the change under review. Gate matrix is tested in
# scripts/lib/__tests__/review-reviewer.test.sh.
if [ "${#STATUS_REASONS[@]}" -gt 0 ]; then
  STATUS_STATE="failure"
  STATUS_DESCRIPTION="$HEADLINE; $(IFS=', '; echo "${STATUS_REASONS[*]}")"
else
  STATUS_DESCRIPTION="$HEADLINE"
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

finalize_review_status "$STATUS_STATE" "$STATUS_DESCRIPTION" "$PR_URL"

if [ -z "$PR_NUMBER" ]; then
  echo ">> no PR for current branch; skipping GitHub comment"
else
  # A push between the final status and this comment would make the displayed
  # verdict stale even though branch protection correctly blocks the new head.
  review_assert_head_is_current "$HEAD_SHA" "$PI_REVIEW_STATUS_CONTEXT" || exit 2
  NOTES="$(echo "$VERDICT" | jq -r '.notes // ""')"
  PRETTY="$(echo "$VERDICT" | jq .)"
  SUGGESTIONS_TABLE="$(echo "$VERDICT" | jq -r '
    if (.suggested_fixes // []) | length == 0 then ""
    else "\n\n### Suggested fixes\n\n| File | Line | Change |\n| --- | --- | --- |\n" +
      ((.suggested_fixes // []) | map("| `\(.file)` | \(.line // "") | \(.change) |") | join("\n"))
    end')"
  BLOCKERS_LIST="$(echo "$VERDICT" | jq -r '
    if (.blockers // []) | length == 0 then ""
    else "\n\n### Blockers\n\n" + ((.blockers // []) | map("- " + .) | join("\n"))
    end')"
  # shellcheck disable=SC2016
  SUMMARY="$(printf '**%s**\n\n%s%s%s\n\n<details><summary>Full verdict JSON</summary>\n\n```json\n%s\n```\n\n</details>\n\n_Local review gate — branch protection can require the `pi-review` commit status. See `docs/REVIEW_SCHEMA.md`._' \
    "$HEADLINE" "$NOTES" "$BLOCKERS_LIST" "$SUGGESTIONS_TABLE" "$PRETTY")"

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
