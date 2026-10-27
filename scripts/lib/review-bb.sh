#!/usr/bin/env bash
# review-bb.sh — visible BB child sessions for `make review` / `make review-fix`.
#
# When the driver runs inside a BB thread (BB_THREAD_ID names a live BB
# context), the reviewer/fixer must run as a VISIBLE BB child thread under the
# invoking thread — never as an invisible `claude -p` / `codex exec` process
# whose activity and usage bypass BB routing. Outside BB the existing direct
# CLI execution is unchanged.
#
# Rules this lib enforces:
# - BB routing is explicit: provider, model, and reasoning effort are selected
#   from the live BB catalog (no invented APIs/options), and the exact
#   reviewed worktree is attached by absolute path rather than blindly
#   inheriting BB_ENVIRONMENT_ID (the parent BB environment can point at main
#   while shell work happens in a task worktree).
# - Inside BB, any creation/auth/provider/context failure fails explicitly.
#   There is deliberately NO silent fallback to the invisible CLI.
# - The review child is read-only and independent: its prompt forbids
#   `make review`, `make review-fix`, `make land`, and spawning further
#   reviewers/threads. The driver owns those steps.
# - A successful idle child alone is never a passing review: the final output
#   must extract to exactly one schema-valid JSON verdict bound to the
#   reviewed HEAD/diff. Failed, stopped, approval-blocked, or malformed
#   sessions fail closed.
# - Cancellation/timeout stops ONLY the owned reviewer child
#   (`bb thread stop <owned-id>`), never a bare `bb wait` kill.
# - Dedup: an existing child bound to the exact same review inputs
#   (title carries branch, short SHA, reviewer identity, diff hash) is reused
#   or adopted instead of spawning a duplicate paid session.
# - `bb thread wait` is a polling CLI that holds no agent-turn lock, so a
#   waiting parent cannot deadlock a child queued behind it.
#
# Test seam: BB_CLI names the bb binary (default `bb`); tests put a fake
# `bb` earlier on PATH or export BB_CLI pointing at a shim.
#
# shellcheck shell=bash

# Owned BB child for cancellation. Set on spawn, cleared on settle.
REVIEW_BB_CHILD_ID=""
REVIEW_BB_WAIT_PID=""

review_bb_cli() {
  printf '%s\n' "${BB_CLI:-bb}"
}

# review_bb_active: 0 iff BB_THREAD_ID names a live BB context reachable
# through the BB CLI. Caches the parent `thread show` payload in
# REVIEW_BB_PARENT_JSON so later field reads cost nothing.
review_bb_active() {
  [ -n "${BB_THREAD_ID:-}" ] || return 1
  command -v "$(review_bb_cli)" >/dev/null 2>&1 || return 1
  if [ -z "${REVIEW_BB_PARENT_JSON:-}" ]; then
    local show_out
    if ! show_out="$(review_bb_cli_invoke thread show "$BB_THREAD_ID" --json 2>/dev/null)"; then
      return 1
    fi
    printf '%s\n' "$show_out" | jq -e --arg id "$BB_THREAD_ID" \
      '.thread.id == $id and (.thread.projectId | type == "string" and length > 0)' >/dev/null 2>&1 || return 1
    REVIEW_BB_PARENT_JSON="$show_out"
  fi
  return 0
}

review_bb_cli_invoke() {
  "$(review_bb_cli)" "$@"
}

# review_bb_wants_run: 0 iff the driver must route through BB. Honors
# BB_REVIEW_DIRECT=1 as an explicit escape hatch back to the direct CLI.
review_bb_wants_run() {
  [ "${BB_REVIEW_DIRECT:-0}" != "1" ] || return 1
  [ -n "${BB_THREAD_ID:-}" ]
}

review_bb_parent_field() {
  printf '%s\n' "$REVIEW_BB_PARENT_JSON" | jq -r "$1"
}

review_bb_project_id() {
  review_bb_parent_field '.thread.projectId // empty'
}

# review_bb_provider_for <codex|claude>: BB provider id for a reviewer CLI.
review_bb_provider_for() {
  case "$1" in
    codex) printf 'codex\n' ;;
    claude) printf 'claude-code\n' ;;
    *) return 2 ;;
  esac
}

# review_bb_model_for <codex|claude> <model>: resolve the reviewer model to a
# BB catalog model id. Codex ids pass through. Claude models must FIRST pass
# the same allowlist the direct CLI path enforces (review_validate_claude_model:
# fable, opus, or claude-opus-*); a disallowed literal such as a Sonnet id
# fails here, before any spawn, even when the catalog lists it. Allowed values
# then resolve against the live catalog so a renamed catalog fails explicitly
# instead of spawning on the wrong model.
review_bb_model_for() {
  local reviewer="$1" model="$2" provider catalog match
  provider="$(review_bb_provider_for "$reviewer")" || return 2
  if [ "$reviewer" = "codex" ]; then
    printf '%s\n' "$model"
    return 0
  fi
  review_validate_claude_model "$model" || return $?
  catalog="$(review_bb_cli_invoke provider models "$provider" --json 2>/dev/null)" || {
    echo "review_bb_model_for: could not list models for provider '$provider'" >&2
    return 1
  }
  # Prefer an exact id/model match; fall back to the first substring match.
  match="$(printf '%s\n' "$catalog" | jq -r --arg m "$model" '[.[] | select(.id == $m or .model == $m)][0].id // empty' | grep . || true)"
  if [ -z "$match" ]; then
    match="$(printf '%s\n' "$catalog" | jq -r --arg m "$model" '[.[] | select((.id | ascii_downcase | contains($m)) // false)][0].id // empty' | grep . || true)"
  fi
  if [ -z "$match" ]; then
    echo "review_bb_model_for: no '$provider' catalog model matches '$model'" >&2
    return 1
  fi
  printf '%s\n' "$match"
}

# review_bb_check_effort <provider> <model> <effort>: refuse an effort level
# the catalog does not list for the resolved model.
review_bb_check_effort() {
  local provider="$1" model="$2" effort="$3" catalog supported
  [ -n "$effort" ] || return 0
  catalog="$(review_bb_cli_invoke provider models "$provider" --json 2>/dev/null)" || {
    echo "review_bb_check_effort: could not list models for provider '$provider'" >&2
    return 1
  }
  supported="$(printf '%s\n' "$catalog" | jq -r --arg m "$model" '
    [.[] | select(.id == $m or .model == $m)][0]
    | if . == null then empty
      elif has("supportedReasoningEfforts") then
        (.supportedReasoningEfforts[] | if type == "object" then .reasoningEffort else . end)
      else empty end')"
  if [ -z "$supported" ] || ! printf '%s\n' "$supported" | grep -Fxq "$effort"; then
    echo "review_bb_check_effort: effort '$effort' not listed for model '$model' (supports: $(printf '%s' "$supported" | tr '\n' ' '))" >&2
    return 1
  fi
  return 0
}

review_bb_short_sha() {
  printf '%s' "$1" | cut -c1-12
}

# review_bb_review_title <branch> <head-sha> <reviewer> <model> <effort> <diff-hash> [pr-number]
review_bb_review_title() {
  local branch="$1" head="$2" reviewer="$3" model="$4" effort="$5" hash="$6" pr="${7:-}" base
  base="review $branch@$(review_bb_short_sha "$head") $reviewer/$model/$effort ${hash:0:12}"
  if [ -n "$pr" ]; then
    base="$base PR#$pr"
  fi
  printf '%s\n' "$base"
}

review_bb_fix_title() {
  local branch="$1" head="$2" fixer="$3" pr="${4:-}" base
  base="review-fix $branch@$(review_bb_short_sha "$head") $fixer"
  if [ -n "$pr" ]; then
    base="$base PR#$pr"
  fi
  printf '%s\n' "$base"
}

# review_bb_find_child <exact-title>: newest child of the invoking thread with
# this exact title. Prints "<id> <status>" or nothing.
review_bb_find_child() {
  local title="$1" list_json row
  list_json="$(review_bb_cli_invoke thread list --parent-thread "$BB_THREAD_ID" --include-hidden --json 2>/dev/null)" || return 0
  row="$(printf '%s\n' "$list_json" | jq -r --arg t "$title" '
    (if type == "array" then . else (.threads // .items // []) end)
    | map(select(.title == $t))
    | sort_by(.updatedAt // .createdAt // 0)
    | last // empty
    | "\(.id) \(.status)"' 2>/dev/null || true)"
  case "$row" in
    thr_*' '*) printf '%s\n' "$row" ;;
  esac
}

# review_bb_register_child <id>: take cancellation ownership of a BB child.
review_bb_register_child() {
  REVIEW_BB_CHILD_ID="$1"
}

review_bb_clear_child() {
  REVIEW_BB_CHILD_ID=""
}

# Cancel the driver's wait process and stop ONLY its owned reviewer child.
review_bb_cancel_owned() {
  if [ -n "$REVIEW_BB_WAIT_PID" ]; then
    kill "$REVIEW_BB_WAIT_PID" 2>/dev/null || true
    wait "$REVIEW_BB_WAIT_PID" 2>/dev/null || true
    REVIEW_BB_WAIT_PID=""
  fi
  [ -n "$REVIEW_BB_CHILD_ID" ] || return 0
  review_bb_cli_invoke thread stop "$REVIEW_BB_CHILD_ID" >/dev/null 2>&1 || true
  REVIEW_BB_CHILD_ID=""
}

# review_bb_spawn <prompt-file> <title> <provider> <model> <effort> <permission-mode> [extra spawn args...]
# Sets REVIEW_BB_CHILD_ID in the calling shell. Prints the link immediately so
# the invoking agent (and the user) can watch the visible session.
review_bb_spawn() {
  local prompt_file="$1" title="$2" provider="$3" model="$4" effort="$5" mode="$6"
  shift 6
  local spawn_out child_id
  local -a spawn_cmd
  spawn_cmd=(thread spawn --project "$(review_bb_project_id)" --parent-self
    --provider "$provider" --title "$title" --permission-mode "$mode" --visibility visible
    --prompt-file "$prompt_file")
  if [ -n "$model" ]; then
    spawn_cmd+=(--model "$model")
  fi
  if [ -n "$effort" ]; then
    spawn_cmd+=(--reasoning-level "$effort")
  fi
  spawn_cmd+=("$@")
  if ! spawn_out="$(review_bb_cli_invoke "${spawn_cmd[@]}" --json 2>/dev/null)"; then
    echo "review_bb_spawn: 'bb ${spawn_cmd[*]}' failed (auth, provider, or context error); refusing silent fallback to the invisible CLI" >&2
    return 1
  fi
  child_id="$(printf '%s\n' "$spawn_out" | jq -r '.id // empty' 2>/dev/null || true)"
  if [ -z "$child_id" ]; then
    echo "review_bb_spawn: spawn returned no thread id: $spawn_out" >&2
    return 1
  fi
  review_bb_register_child "$child_id"
  echo ">> visible BB child: @thread:$child_id" >&2
}

# review_bb_env_path <child-id>: absolute workspace path of a child thread.
review_bb_env_path() {
  review_bb_cli_invoke thread show "$1" --json 2>/dev/null |
    jq -r '.environment.path // empty' 2>/dev/null || true
}

# review_bb_wait_idle <child-id> <timeout>: wait for idle; on timeout or wait
# failure stop ONLY the owned child and fail.
review_bb_wait_idle() {
  local child="$1" timeout="${2:-20m}" wait_rc=0
  # Bash defers signal traps during a foreground command; waiting on an async
  # CLI lets the driver's EXIT/TERM cleanup stop its owned child promptly.
  "$(review_bb_cli)" thread wait "$child" --status idle --timeout "$timeout" --json >/dev/null 2>&1 &
  REVIEW_BB_WAIT_PID=$!
  wait "$REVIEW_BB_WAIT_PID" || wait_rc=$?
  REVIEW_BB_WAIT_PID=""
  if [ "$wait_rc" -ne 0 ]; then
    echo "review_bb_wait_idle: child @thread:$child did not reach idle (timeout $timeout); stopping the owned child" >&2
    review_bb_cli_invoke thread stop "$child" >/dev/null 2>&1 || true
    review_bb_clear_child
    return 1
  fi
  return 0
}

# review_bb_child_settled_idle <child-id>: 0 iff the child is idle now.
review_bb_child_settled_idle() {
  local child_id="$1" status
  status="$(review_bb_cli_invoke thread show "$child_id" --json 2>/dev/null | jq -r '.thread.status // empty' 2>/dev/null || true)"
  [ "$status" = "idle" ]
}

# Print the pending interaction count; unreadable state is an error.
review_bb_pending_interaction() {
  local child="$1" list_json
  list_json="$(review_bb_cli_invoke thread interactions list "$child" --json 2>/dev/null)" || return 1
  printf '%s\n' "$list_json" | jq -er '
    if type == "array" then
      ([.[] | select((.status // "pending") | test("pending|awaiting|open"))] | length)
    else error("expected interactions array") end' 2>/dev/null
}

# review_bb_child_output <child-id>: prints the final output text.
review_bb_child_output() {
  review_bb_cli_invoke thread output "$1" --json 2>/dev/null |
    jq -r '.output // empty' 2>/dev/null || true
}

# review_bb_guardrail_append <prompt-file> <kind> <head-sha> <base-branch>:
# append the BB-session guardrails (no recursive driver steps, independence
# rules) to a copy of the prompt. Prints the augmented prompt path.
review_bb_guardrail_append() {
  local prompt_file="$1" kind="$2" head_sha="$3" base_branch="$4" augmented
  augmented="$(mktemp /tmp/lobu-review-bb-prompt.XXXXXX)"
  cat "$prompt_file" > "$augmented" || { rm -f "$augmented"; return 1; }
  cat >> "$augmented" <<EOF

## BB session rules (read-only independent reviewer contract)

You are running as a VISIBLE BB child thread spawned by the review driver.
The driver owns every step you do not: do NOT run \`make review\`,
\`make review-fix\`, or \`make land\`, do NOT spawn, message, or wait on other
threads, and do NOT retry or re-dispatch this review.

- You are reviewing EXACTLY commit $head_sha against base $base_branch.
  Validate with \`git rev-parse HEAD\` before scoring; if HEAD differs, say so
  in your verdict notes and score what is actually checked out.
- Read-only: do NOT edit, commit, push, or post statuses or comments. The
  driver posts the verdict.
- Emit ONLY the JSON verdict object the review prompt specifies. No prose,
  no fences, no commentary before or after.
EOF
  if [ "$kind" = "fixer" ]; then
    cat >> "$augmented" <<'EOF'

## BB fixer amendment (applies to the fixer pass only)

The read-only rule above is replaced for this fixer pass: you MAY edit files
in your own worktree, but you still must NOT commit, push, post statuses, run
`make review` / `make review-fix` / `make land`, or spawn other threads. End
with the plain-text summary the fixer prompt specifies.
EOF
  fi
  printf '%s\n' "$augmented"
}

# --- reviewer flow (consumed by scripts/review.sh) --------------------------

# review_bb_inline_prompt <prompt-file> <head-sha> <base-branch> <ci-checks-file> <kind>:
# BB children do not inherit the driver's shell env, so substitute the prompt
# variables inline and append the BB guardrails. Prints the augmented path.
# Pure-bash substitution: branch names and paths contain slashes, which broke
# an earlier s///-based implementation.
review_bb_inline_prompt() {
  local prompt_file="$1" head_sha="$2" base_branch="$3" ci_file="$4" kind="$5"
  local staged content
  staged="$(review_bb_guardrail_append "$prompt_file" "$kind" "$head_sha" "$base_branch")" || return 1
  content="$(cat "$staged")" || return 1
  content="${content//\$HEAD_SHA/$head_sha}"
  content="${content//\$BASE_BRANCH/$base_branch}"
  if [ -n "$ci_file" ]; then
    content="${content//\$CI_CHECKS_FILE/$ci_file}"
  fi
  printf '%s\n' "$content" > "$staged" || return 1
  printf '%s\n' "$staged"
}

# review_bb_pr_number: best-effort PR number for titles; empty when unknown.
review_bb_pr_number() {
  command -v gh >/dev/null 2>&1 || return 0
  gh pr view --json number --jq '.number // empty' 2>/dev/null || true
}

# review_bb_run_reviewer <prompt-file> <head-sha> <base-branch> <diff-hash>
#   <reviewer> <model> <effort> <schema-jq> <ci-checks-file>
# Full visible-child review. Always returns 0; sets RAW (child output text)
# and REVIEWER_EXIT (0 on a settled child, 1 on any BB failure) so the
# caller's existing schema validation fails closed exactly like the direct
# CLI path. Persists the transcript via the caller's review_persist_inline_output.
review_bb_run_reviewer() {
  local prompt_file="$1" head_sha="$2" base_branch="$3" diff_hash="$4"
  local reviewer="$5" model="$6" effort="$7" schema_jq="$8" ci_file="$9"
  local provider bb_model title pr worktree child bb_prompt status pending out verdict
  RAW=""
  REVIEWER_EXIT=1
  if ! review_bb_active; then
    RAW="review_bb: invalid BB context; refusing silent fallback to the direct CLI"
    return 0
  fi

  provider="$(review_bb_provider_for "$reviewer")" || {
    RAW="review_bb: unknown reviewer '$reviewer'"
    return 0
  }
  bb_model="$(review_bb_model_for "$reviewer" "$model")" || {
    RAW="review_bb: could not resolve model '$model' for provider '$provider'; refusing silent fallback to the invisible CLI"
    return 0
  }
  review_bb_check_effort "$provider" "$bb_model" "$effort" || {
    RAW="review_bb: effort '$effort' not supported for model '$bb_model'"
    return 0
  }

  pr="$(review_bb_pr_number)"
  worktree="$(pwd -P)"
  title="$(review_bb_review_title "$(git branch --show-current 2>/dev/null || printf '%s' "$base_branch")" "$head_sha" "$reviewer" "$model" "$effort" "$diff_hash" "$pr")"

  # Dedup: reuse or adopt an existing child bound to these exact inputs.
  child="$(review_bb_find_child "$title")"
  if [ -n "$child" ]; then
    local existing_id="${child%% *}"
    status="${child#* }"
    case "$status" in
      idle)
        pending="$(review_bb_pending_interaction "$existing_id")" || pending=unknown
        out="$(review_bb_child_output "$existing_id")"
        verdict="$(extract_json_verdict "$out" 2>/dev/null || true)"
        if [ "$pending" = "0" ] && [ -n "$verdict" ] &&
           printf '%s\n' "$verdict" | jq -e "$schema_jq" >/dev/null 2>&1; then
          echo ">> reusing visible BB child @thread:$existing_id for identical review inputs" >&2
          child="$existing_id"
        else
          echo ">> existing child @thread:$existing_id is idle but has no valid verdict; spawning a retry" >&2
          title="$title (retry $(date +%s))"
          child=""
        fi
        ;;
      active|starting|stopping|pending)
        echo ">> adopting running BB child @thread:$existing_id for identical review inputs" >&2
        review_bb_register_child "$existing_id"
        child="$existing_id"
        ;;
      *)
        echo ">> existing child @thread:$existing_id is $status; spawning a fresh child" >&2
        title="$title (retry $(date +%s))"
        child=""
        ;;
    esac
  fi

  if [ -z "${child:-}" ]; then
    if ! bb_prompt="$(review_bb_inline_prompt "$prompt_file" "$head_sha" "$base_branch" "$ci_file" review)"; then
      RAW="review_bb: could not build the BB child prompt"
      return 0
    fi
    # `auto`, like the fixer: the reviewer runs read-only checks such as
    # `bun test`, and accept-edits stops each one on a human approval prompt,
    # which an unattended review waits out until it times out and fails closed.
    review_bb_spawn "$bb_prompt" "$title" "$provider" "$bb_model" "$effort" \
      auto --environment "$worktree" || {
      RAW="review_bb: failed to spawn a visible BB child; refusing silent fallback to the invisible CLI"
      rm -f "$bb_prompt"
      return 0
    }
    child="$REVIEW_BB_CHILD_ID"
    rm -f "$bb_prompt"
    # The exact reviewed worktree must be attached, not an inherited default.
    local child_path
    child_path="$(review_bb_env_path "$child")"
    if [ "$child_path" != "$worktree" ]; then
      RAW="review_bb: child @thread:$child attached to '$child_path', not the reviewed worktree '$worktree'"
      review_bb_cli_invoke thread stop "$child" >/dev/null 2>&1 || true
      review_bb_clear_child
      return 0
    fi
  fi

  if ! review_bb_wait_idle "$child" "${BB_REVIEW_WAIT_TIMEOUT:-20m}"; then
    RAW="review_bb: child @thread:$child did not settle (owned child stopped)"
    return 0
  fi
  review_bb_clear_child

  # Test seam (mirrors REVIEW_PROCESS_CONTROL_ROOT_FOR_TESTS): executed after
  # the child settles and before the HEAD/pinning checks accept its output.
  if [ -n "${REVIEW_BB_PRE_ACCEPT_HOOK_FOR_TESTS:-}" ]; then
    bash -c "$REVIEW_BB_PRE_ACCEPT_HOOK_FOR_TESTS" || true
  fi

  # Bind the verdict to the exact reviewed head/tree: the driver may have been
  # superseded while the child ran (the caller re-checks before posting, but
  # never accept a verdict for a moved HEAD here either).
  if [ "$(git rev-parse HEAD 2>/dev/null || true)" != "$head_sha" ]; then
    RAW="review_bb: HEAD moved during child review (was $head_sha); discarding child output"
    return 0
  fi
  if [ "$(review_bb_env_path "$child")" != "$worktree" ]; then
    RAW="review_bb: child @thread:$child is not attached to the reviewed worktree"
    return 0
  fi
  if ! review_bb_child_settled_idle "$child"; then
    RAW="review_bb: child @thread:$child is not idle after wait"
    return 0
  fi
  pending="$(review_bb_pending_interaction "$child")" || pending=unknown
  if [ "$pending" != "0" ]; then
    RAW="review_bb: child @thread:$child has a pending approval/interaction or unreadable interaction state; a blocked session is never a passing review"
    return 0
  fi
  out="$(review_bb_child_output "$child")"
  if [ -z "$(printf '%s' "$out" | tr -d '[:space:]')" ]; then
    RAW="review_bb: child @thread:$child produced no output"
    return 0
  fi
  RAW="$out"
  REVIEWER_EXIT=0
  review_bb_persist_output "$out"
  return 0
}

# review_bb_persist_output <text>: mirror the inline path's transcript file.
review_bb_persist_output() {
  local out_file
  out_file="$(mktemp /tmp/lobu-review-bb-raw.XXXXXX)"
  printf '%s\n' "$1" > "$out_file"
  REVIEW_INLINE_RAW_FILE="$out_file"
  review_persist_inline_output "$out_file" ""
  rm -f "$out_file"
  REVIEW_INLINE_RAW_FILE=""
}

# --- fixer flow (consumed by scripts/review-fix.sh) --------------------------

# Secret-looking basenames are never transferred into the fixer worktree.
review_bb_secret_basename() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    .env|.env.*|*.pem|*.key|*.p12|*.pfx|*.token|*credential*|*secret*|*passwd*|id_rsa*|id_ed25519*|*.age|*.gpg) return 0 ;;
  esac
  return 1
}

# Snapshot tracked and allowed untracked contents without touching the user's index.
review_bb_input_patch() (
  local snapshot_index tracked_patch f
  snapshot_index="$(mktemp /tmp/lobu-review-bb-index.XXXXXX)" || return 1
  tracked_patch="$(mktemp /tmp/lobu-review-bb-tracked.XXXXXX)" || return 1
  trap 'rm -f "$snapshot_index" "$tracked_patch"' EXIT
  git diff --binary --no-ext-diff --no-textconv HEAD > "$tracked_patch" || return 1
  export GIT_INDEX_FILE="$snapshot_index"
  git read-tree HEAD || return 1
  git apply --cached --allow-empty "$tracked_patch" || return 1
  while IFS= read -r -d '' f; do
    if ! review_bb_secret_basename "$(basename "$f")"; then
      git add -- "$f" || return 1
    fi
  done < <(git ls-files --others --exclude-standard -z)
  git diff --cached --binary --no-ext-diff --no-textconv HEAD
)

# Compare reproduced content as Git trees, independent of diff presentation.
review_bb_patch_tree() (
  local snapshot_index
  snapshot_index="$(mktemp /tmp/lobu-review-bb-index.XXXXXX)" || return 1
  trap 'rm -f "$snapshot_index"' EXIT
  export GIT_INDEX_FILE="$snapshot_index"
  git read-tree "$1" || return 1
  git apply --cached --allow-empty "$2" || return 1
  git write-tree
)

# Reject unavailable or truncated BB diffs before attempting any transfer.
review_bb_diff() {
  local result
  result="$(review_bb_cli_invoke environment diff "$@" --json)" || return 1
  printf '%s\n' "$result" | jq -jer '
    if .outcome == "available" and .diff.truncated == false and (.diff.diff | type == "string")
    then .diff.diff else error("BB diff unavailable or truncated") end'
}

# review_bb_run_fixer <base-branch>: full isolated-worktree fixer pass.
# Exit 0 when the fixer's reviewed changes were transferred (or there were
# none); exit 1 on any BB failure, concurrent-edit conflict, or patch conflict.
# Never overwrites, stashes, or discards driver/user changes.
review_bb_run_fixer() {
  local base_branch="$1"
  local head_sha branch input_patch untracked_list fixer_prompt title pr child
  local child_env child_path fixer_patch committed_patch pending summary
  if ! review_bb_active; then
    echo "review_bb: invalid BB context; refusing silent fallback to the direct CLI" >&2
    return 1
  fi

  head_sha="$(git rev-parse HEAD)"
  branch="$(git branch --show-current)"
  if [ -z "$branch" ]; then
    echo "review_bb: detached HEAD is not supported for the isolated fixer (no branch to base the worktree on)" >&2
    return 1
  fi
  input_patch="$(mktemp /tmp/lobu-review-fix-bb-input.XXXXXX)"
  review_bb_input_patch > "$input_patch" || { rm -f "$input_patch"; return 1; }
  untracked_list="$(git ls-files --others --exclude-standard || true)"

  local input_desc
  input_desc="$(mktemp /tmp/lobu-review-bb-input.XXXXXX)"
  {
    printf 'Parent worktree: %s\n' "$(pwd -P)"
    printf 'HEAD: %s\n' "$head_sha"
    printf 'Base: %s\n' "$base_branch"
    printf 'Branch: %s\n' "$branch"
    printf 'Input patch: %s\n' "$input_patch"
    printf 'The patch includes allowed untracked files; secret-looking basenames are excluded.\n'
  } > "$input_desc"

  fixer_prompt=""
  if ! fixer_prompt="$(review_bb_inline_prompt prompts/review-fix-prompt.md "$head_sha" "$base_branch" "" fixer)"; then
    echo "review_bb: could not build the BB fixer prompt" >&2
    rm -f "$input_desc" "$input_patch"
    return 1
  fi
  {
    printf '\n\n## BB fixer input (isolated worktree contract)\n\n'
    printf 'Your worktree was branched from %s at parent HEAD %s. The driving\n' "$branch" "$head_sha"
    printf 'agent may have uncommitted work; reproduce it first so you fix the\n'
    printf 'tree the next commit will snapshot:\n\n'
    printf '```\n'
    cat "$input_desc"
    printf '```\n\n'
    printf '1. Apply the input patch (including new files; it may be empty):\n'
    printf '   `git apply --allow-empty "%s"`\n' "$input_patch"
    printf '2. Stage ONLY the reproduced paths explicitly. No parent files need copying.\n'
    printf '3. Commit ONLY the reproduced input as `bb-fixer: reproduce driver input`\n'
    printf '   (skip the commit when the input patch is empty). Never push, and\n'
    printf '   never commit your fixes: your uncommitted\n'
    printf '   diff must contain ONLY your fixes, because the driver transfers\n'
    printf '   exactly that diff back.\n'
    printf '4. Do the fixer pass in YOUR worktree only. Never touch the parent path.\n'
  } >> "$fixer_prompt"

  pr="$(review_bb_pr_number)"
  local provider fixer_cli bb_model effort
  fixer_cli="${FIXER_CLI:-auto}"
  if [ "$fixer_cli" = "auto" ]; then
    fixer_cli="$(review_select_reviewer auto)"
  fi
  provider="$(review_bb_provider_for "$fixer_cli")" || {
    echo "review_bb: unknown fixer '$fixer_cli'" >&2
    rm -f "$fixer_prompt" "$input_desc" "$input_patch"
    return 1
  }
  if [ "$fixer_cli" = "claude" ]; then
    bb_model="$(review_bb_model_for claude "${CLAUDE_REVIEW_MODEL:-fable}")" || {
      echo "review_bb: could not resolve Claude fixer model; refusing silent fallback" >&2
      rm -f "$fixer_prompt" "$input_desc" "$input_patch"
      return 1
    }
    effort="${CLAUDE_REVIEW_EFFORT:-high}"
  else
    bb_model="${CODEX_REVIEW_MODEL:-gpt-6-astra}"
    effort="${CODEX_REVIEW_EFFORT:-xhigh}"
  fi
  review_bb_check_effort "$provider" "$bb_model" "$effort" || {
    rm -f "$fixer_prompt" "$input_desc" "$input_patch"
    return 1
  }
  title="$(review_bb_fix_title "$branch" "$head_sha" "$fixer_cli" "$pr") $(
    { printf '%s\n' "$(pwd -P)" "$base_branch" "$bb_model" "$effort"; cat "$input_patch"; } | sha1sum | cut -d' ' -f1
  )"
  # Fixer dedup: an idle fixer child with this exact title already transferred
  # or superseded is not rerun blindly; adopt a live one, else spawn.
  child="$(review_bb_find_child "$title")"
  if [ -n "$child" ]; then
    local existing_id="${child%% *}"
    local existing_status="${child#* }"
    case "$existing_status" in
      active|starting|stopping|pending)
        echo ">> adopting running BB fixer child @thread:$existing_id" >&2
        review_bb_register_child "$existing_id"
        child="$existing_id"
        ;;
      *)
        title="$title (retry $(date +%s))"
        child=""
        ;;
    esac
  fi

  if [ -z "${child:-}" ]; then
    review_bb_spawn "$fixer_prompt" "$title" "$provider" "$bb_model" "$effort" \
      auto --new-environment worktree --base-branch "$head_sha" || {
      rm -f "$fixer_prompt" "$input_desc" "$input_patch"
      return 1
    }
    child="$REVIEW_BB_CHILD_ID"
  fi
  rm -f "$fixer_prompt" "$input_desc"

  # Isolation: the fixer must NOT share the driver's worktree. A fresh
  # managed worktree provisions asynchronously, so an env that is merely
  # absent here is re-verified strictly after the child settles; an env
  # that is already present and equal to the driver tree is a violation now.
  child_env="$(review_bb_cli_invoke thread show "$child" --json 2>/dev/null | jq -r '.environment.id // empty' 2>/dev/null || true)"
  child_path="$(review_bb_env_path "$child")"
  if [ -n "$child_path" ] && [ "$child_path" = "$(pwd -P)" ]; then
    echo "review_bb: fixer child shares the driver worktree ($child_path); isolation violated, stopping it" >&2
    review_bb_cli_invoke thread stop "$child" >/dev/null 2>&1 || true
    review_bb_clear_child
    return 1
  fi
  if [ -n "$child_path" ]; then
    echo ">> fixer working in isolated worktree: $child_path (env $child_env)" >&2
  else
    echo ">> fixer worktree provisioning; will verify isolation after settle" >&2
  fi

  if ! review_bb_wait_idle "$child" "${BB_REVIEW_WAIT_TIMEOUT:-20m}"; then
    rm -f "$input_patch"
    return 1
  fi
  review_bb_clear_child

  if ! review_bb_child_settled_idle "$child"; then
    echo "review_bb: fixer child @thread:$child is not idle after wait; NOT transferring" >&2
    rm -f "$input_patch"
    return 1
  fi

  # Strict post-settle isolation verdict: the managed worktree is provisioned
  # by now, so the env must exist and differ from the driver worktree.
  child_env="$(review_bb_cli_invoke thread show "$child" --json 2>/dev/null | jq -r '.environment.id // empty' 2>/dev/null || true)"
  child_path="$(review_bb_env_path "$child")"
  if [ -z "$child_env" ] || [ -z "$child_path" ]; then
    echo "review_bb: fixer child @thread:$child has no usable environment after settle; leaving it for inspection" >&2
    return 1
  fi
  if [ "$child_path" = "$(pwd -P)" ]; then
    echo "review_bb: fixer child @thread:$child ran in the driver worktree ($child_path); isolation violated. NOT transferring anything; leaving it for inspection" >&2
    return 1
  fi
  echo ">> fixer worked in isolated worktree: $child_path (env $child_env)" >&2

  # The child's committed stack must be exactly the reproduced input: the
  # uncommitted diff transferred below is only the fixer's own changes when
  # the reproduction was committed separately.
  committed_patch="$(mktemp /tmp/lobu-review-bb-committed.XXXXXX)"
  if ! review_bb_diff "$child_env" --target branch_committed \
      --merge-base-branch "$head_sha" > "$committed_patch" 2>/dev/null; then
    echo "review_bb: could not read fixer committed stack from env $child_env; leaving child @thread:$child for inspection" >&2
    rm -f "$committed_patch" "$input_patch"
    return 1
  fi
  local expected_tree reproduced_tree
  expected_tree="$(review_bb_patch_tree "$head_sha" "$input_patch")" || return 1
  reproduced_tree="$(review_bb_patch_tree "$head_sha" "$committed_patch")" || return 1
  if [ "$expected_tree" != "$reproduced_tree" ]; then
    echo "review_bb: fixer committed tree does not match the driver input (reproduce input separately, leave fixes uncommitted). NOT transferring. Committed stack preserved at $committed_patch; fixer at @thread:$child" >&2
    rm -f "$input_patch"
    return 1
  fi
  rm -f "$committed_patch"

  pending="$(review_bb_pending_interaction "$child")" || pending=unknown
  if [ "$pending" != "0" ]; then
    echo "review_bb: fixer child @thread:$child has pending or unreadable interactions; stopping ONLY the owned child (inspect it at @thread:$child; no silent direct run)" >&2
    review_bb_cli_invoke thread stop "$child" >/dev/null 2>&1 || true
    review_bb_clear_child
    return 1
  fi
  summary="$(review_bb_child_output "$child")"
  if [ -z "$(printf '%s' "$summary" | tr -d '[:space:]')" ]; then
    echo "review_bb: fixer child @thread:$child produced no summary; NOT transferring" >&2
    rm -f "$input_patch"
    return 1
  fi

  # Fetch the fixer's reviewed changes as a patch. An empty diff means the
  # fixer found nothing to change — a legitimate no-op, not a failure.
  fixer_patch="$(mktemp /tmp/lobu-review-fix-bb.XXXXXX)"
  if ! review_bb_diff "$child_env" --target uncommitted > "$fixer_patch" 2>/dev/null; then
    echo "review_bb: could not read fixer diff from env $child_env; leaving child @thread:$child for inspection" >&2
    rm -f "$fixer_patch"
    return 1
  fi
  # A non-empty but unrecognized diff is never silently dropped as a no-op:
  # fail explicitly with the patch preserved for inspection.
  if [ -s "$fixer_patch" ] && ! grep -q '^diff --git' "$fixer_patch"; then
    echo "review_bb: fixer diff from env $child_env is not a git patch; NOT applying. Patch preserved at $fixer_patch; fixer at @thread:$child" >&2
    rm -f "$input_patch"
    return 1
  fi

  # Reconcile: transfer ONLY the fixer's reviewed changes, and only when the
  # original input hasn't changed underneath. Never overwrite/stash/discard.
  # Test seam (mirrors REVIEW_PROCESS_CONTROL_ROOT_FOR_TESTS): simulates a
  # concurrent driver edit between the fixer run and reconcile.
  if [ -n "${REVIEW_BB_PRE_RECONCILE_HOOK_FOR_TESTS:-}" ]; then
    bash -c "$REVIEW_BB_PRE_RECONCILE_HOOK_FOR_TESTS" || true
  fi
  if [ "$(git rev-parse HEAD)" != "$head_sha" ]; then
    echo "review_bb: HEAD moved during the fixer run (was $head_sha); NOT applying. Patch preserved at $fixer_patch; fixer at @thread:$child" >&2
    rm -f "$input_patch"
    return 1
  fi
  local current_input_hash snapshot_input_hash current_untracked
  current_input_hash="$(review_bb_input_patch | sha1sum | cut -d' ' -f1)" || return 1
  snapshot_input_hash="$(sha1sum "$input_patch" | cut -d' ' -f1)"
  current_untracked="$(git ls-files --others --exclude-standard || true)"
  if [ "$current_input_hash" != "$snapshot_input_hash" ] || [ "$current_untracked" != "$untracked_list" ]; then
    echo "review_bb: working tree changed during the fixer run (concurrent edits); NOT applying. Patch preserved at $fixer_patch; fixer at @thread:$child" >&2
    rm -f "$input_patch"
    return 1
  fi
  if [ ! -s "$fixer_patch" ]; then
    echo ""
    echo "========== fixer summary =========="
    printf '%s\n' "$summary"
    echo "==================================="
    echo ">> fixer made no working-tree changes (patch empty)"
    review_bb_cli_invoke thread archive "$child" >/dev/null 2>&1 || true
    rm -f "$fixer_patch" "$input_patch"
    return 0
  fi
  if ! git apply --check "$fixer_patch"; then
    echo "review_bb: fixer patch does not apply cleanly; NOT applying. Patch preserved at $fixer_patch; fixer at @thread:$child" >&2
    rm -f "$input_patch"
    return 1
  fi
  git apply "$fixer_patch" || {
    echo "review_bb: git apply failed; tree left untouched. Patch preserved at $fixer_patch" >&2
    rm -f "$input_patch"
    return 1
  }

  echo ""
  echo "========== fixer summary (via @thread:$child) =========="
  printf '%s\n' "$summary"
  echo "==================================="
  echo ""
  echo ">> fixer patch transferred from isolated worktree ($child_path); full patch preserved at $fixer_patch"
  review_bb_cli_invoke thread archive "$child" >/dev/null 2>&1 || true
  rm -f "$input_patch"
  echo ">> working-tree changes made by the fixer (staged + unstaged; verify before committing):"
  git status --short
  git diff --stat HEAD
  return 0
}
