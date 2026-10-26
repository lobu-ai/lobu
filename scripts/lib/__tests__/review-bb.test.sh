#!/usr/bin/env bash
# review-bb.test.sh — regression coverage for the visible BB child routing in
# scripts/lib/review-bb.sh. Uses a fake `bb` shim (BB_CLI) plus fixture JSON
# so no paid BB session is spent; real end-to-end proof lives in the PR body.
#
# Covers: BB/non-BB routing, exact environment/model/parent selection,
# valid/malformed/failed/cancelled child output, dedup (reuse + adopt),
# cancellation ownership, and fixer input/patch isolation.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# shellcheck source=scripts/lib/review-reviewer.sh
. "$repo_root/scripts/lib/review-reviewer.sh"
# shellcheck source=scripts/lib/review-bb.sh
. "$repo_root/scripts/lib/review-bb.sh"

# extract_json_verdict lives in review.sh (which cannot be sourced — it runs
# on source). Extract the single-source function instead of duplicating it.
eval "$(sed -n '/^extract_json_verdict()/,/^review_exit_cleanup()/p' "$repo_root/scripts/review.sh" | sed '$d')"

TEST_DIR="$(mktemp -d /tmp/lobu-review-bb-test.XXXXXX)"
TEST_DIR="$(cd "$TEST_DIR" && pwd -P)"
# Keep library temp files under the test's cleanup trap.
mktemp() { command mktemp "$TEST_DIR/${1##*/}"; }
FAKE_BIN="$TEST_DIR/bin"
FAKE_STATE="$TEST_DIR/state"
mkdir -p "$FAKE_BIN" "$FAKE_STATE"
export BB_CLI="$FAKE_BIN/bb"
export BB_THREAD_ID="thr_parent1"

cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# --- fake bb shim -----------------------------------------------------------
# Dispatches on argv; canned payloads live in $FAKE_STATE files the test
# rewrites per case. Every invocation appends its argv to calls.log.

cat > "$FAKE_BIN/bb" <<'SHIM'
#!/usr/bin/env bash
set -u
state="${BB_FAKE_STATE:?}"
printf '%s\n' "$*" >> "$state/calls.log"
case "$1 $2" in
  "thread show")
    if [ -z "${3:-}" ]; then printf '{"ok":false,"error":{"code":"missing_thread_id"}}\n'; exit 1; fi
    if [ "${3:-}" = "thr_parent1" ]; then cat "$state/parent.json"
    elif [ -d "$state/show-queue" ] && [ -n "$(ls -A "$state/show-queue" 2>/dev/null)" ]; then
      first="$(ls "$state/show-queue" | sort | head -n1)"
      cat "$state/show-queue/$first"; rm -f "$state/show-queue/$first"
    else cat "$state/child-show.json"; fi
    ;;
  "provider models") cat "$state/models-$3.json" ;;
  "thread list") cat "$state/list.json" ;;
  "thread spawn")
    args=("$@")
    for ((i=0; i<${#args[@]}; i++)); do
      if [ "${args[$i]}" = --prompt-file ]; then cp "${args[$((i+1))]}" "$state/prompt.txt"; fi
    done
    cat "$state/spawn.json" ;;
  "thread wait")
    if [ "${BB_FAKE_WAIT_SIGNAL:-0}" = 1 ]; then
      kill -TERM "$PPID"
      exec sleep 5
    fi
    if [ "${BB_FAKE_ASSERT_OWNER:-0}" = 1 ] && [ "${REVIEW_BB_CHILD_ID:-}" != "${BB_FAKE_EXPECT_OWNER:-thr_child9}" ]; then
      exit 1
    fi
    exit "${BB_FAKE_WAIT_RC:-0}" ;;
  "thread interactions") cat "$state/interactions.json" ;;
  "thread output") "$BB_FAKE_JQ" -n --arg o "$(cat "$state/output.txt")" '{output:$o}' ;;
  "thread stop") printf '{"ok":true}\n' ;;
  "thread archive") printf '{"ok":true}\n' ;;
  "environment diff")
    case "$*" in
      *branch_committed*) patch="$state/committed.patch" ;;
      *) patch="$state/fixer.patch" ;;
    esac
    "$BB_FAKE_JQ" -n --rawfile patch "$patch" --argjson truncated "${BB_FAKE_TRUNCATED:-false}" '{outcome:"available",diff:{diff:$patch,truncated:$truncated}}'
    ;;
  *) printf '{}\n' ;;
esac
SHIM
chmod +x "$FAKE_BIN/bb"
export BB_FAKE_STATE="$FAKE_STATE"
export BB_FAKE_JQ="jq"
export PATH="$FAKE_BIN:$PATH"

# Fake gh: no PR in tests (best-effort title suffix stays empty).
cat > "$FAKE_BIN/gh" <<'SHIM'
#!/usr/bin/env bash
exit 1
SHIM
chmod +x "$FAKE_BIN/gh"

cat > "$FAKE_STATE/parent.json" <<'JSON'
{"thread":{"id":"thr_parent1","projectId":"proj_TEST","environmentId":"env_parent1","providerId":"acp-opencode","title":"parent","status":"active","parentThreadId":null},"environment":{"id":"env_parent1","path":"/tmp/parent-worktree"}}
JSON
cat > "$FAKE_STATE/child-show.json" <<'JSON'
{"thread":{"id":"thr_child9","projectId":"proj_TEST","status":"idle"},"environment":{"id":"env_child9","path":"/tmp/review-worktree"}}
JSON
cat > "$FAKE_STATE/models-codex.json" <<'JSON'
[{"id":"gpt-6-astra","model":"gpt-6-astra","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"xhigh"}]}]
JSON
cat > "$FAKE_STATE/models-claude-code.json" <<'JSON'
[{"id":"claude-fable-5-1","model":"claude-fable-5-1","supportedReasoningEfforts":[{"reasoningEffort":"high"},{"reasoningEffort":"xhigh"}]},{"id":"claude-opus-5-5","model":"claude-opus-5-5","supportedReasoningEfforts":[{"reasoningEffort":"high"}]},{"id":"claude-sonnet-5-5","model":"claude-sonnet-5-5","supportedReasoningEfforts":[{"reasoningEffort":"high"}]}]
JSON
printf '[]\n' > "$FAKE_STATE/list.json"
printf '{"id":"thr_child9"}\n' > "$FAKE_STATE/spawn.json"
printf '[]\n' > "$FAKE_STATE/interactions.json"
printf '{"ok":true}\n' > "$FAKE_STATE/output.txt"
: > "$FAKE_STATE/calls.log"
printf '' > "$FAKE_STATE/fixer.patch"

# review_persist_inline_output stub: persist into the test dir.
REVIEW_RUN_DIR="$TEST_DIR"
review_persist_inline_output() {
  cp "$1" "$TEST_DIR/persisted.log"
}

reset_calls() { : > "$FAKE_STATE/calls.log"; }
spawn_calls() { grep -c '^thread spawn' "$FAKE_STATE/calls.log" || true; }

# --- routing ----------------------------------------------------------------

# 1. Outside BB there is no BB routing.
(
  unset BB_THREAD_ID
  review_bb_wants_run && fail "BB routing must be off without BB_THREAD_ID"
  true
)
# 2. BB_REVIEW_DIRECT=1 forces the direct CLI even inside BB.
(
  BB_REVIEW_DIRECT=1
  review_bb_wants_run && fail "BB_REVIEW_DIRECT=1 must force the direct CLI"
  true
)
# 3. Invalid BB context still routes to BB, where it must fail closed.
(
  export BB_THREAD_ID="thr_missing"
  cat > "$FAKE_BIN/bb-invalid" <<'SHIM2'
#!/usr/bin/env bash
exit 1
SHIM2
  chmod +x "$FAKE_BIN/bb-invalid"
  BB_CLI="$FAKE_BIN/bb-invalid" review_bb_wants_run || fail "invalid BB context must never select direct CLI"
  true
)
# 4. Valid context routes.
review_bb_wants_run || fail "valid BB context must route to BB"
review_bb_active || fail "valid BB context must load"
[ "$(review_bb_project_id)" = "proj_TEST" ] || fail "project must come from the parent thread"

# --- provider / model / effort selection -------------------------------------

[ "$(review_bb_provider_for codex)" = "codex" ] || fail "codex provider mapping"
[ "$(review_bb_provider_for claude)" = "claude-code" ] || fail "claude provider mapping"
review_bb_provider_for pi >/dev/null 2>&1 && fail "unknown reviewer must fail"
true
[ "$(review_bb_model_for codex gpt-6-astra)" = "gpt-6-astra" ] || fail "codex model passthrough"
[ "$(review_bb_model_for claude fable)" = "claude-fable-5-1" ] || fail "fable must resolve to the catalog id"
[ "$(review_bb_model_for claude claude-opus-5-5)" = "claude-opus-5-5" ] || fail "literal claude model must pass through"
# The Claude allowlist (review_validate_claude_model) applies BEFORE any
# catalog lookup: a disallowed alias or literal fails even when the live
# catalog lists that model.
review_bb_model_for claude sonnet >/dev/null 2>&1 && fail "disallowed claude alias must fail"
true
review_bb_model_for claude claude-sonnet-5-5 >/dev/null 2>&1 && fail "disallowed claude literal must fail even when catalogued"
true
review_bb_model_for claude does-not-exist >/dev/null 2>&1 && fail "unknown model must fail explicitly"
true
review_bb_check_effort codex gpt-6-astra xhigh || fail "listed effort must pass"
review_bb_check_effort codex gpt-6-astra max >/dev/null 2>&1 && fail "unlisted effort must fail explicitly"
review_bb_check_effort codex missing-model xhigh >/dev/null 2>&1 && fail "missing catalog model must fail explicitly"
true

# --- reviewer flow -----------------------------------------------------------

SCRATCH="$TEST_DIR/scratch"
git init -qb main "$SCRATCH"
git -C "$SCRATCH" config user.email t@t.t
git -C "$SCRATCH" -c init.defaultBranch=main commit -q --allow-empty -m init
HEAD_SHA_SCRATCH="$(git -C "$SCRATCH" rev-parse HEAD)"
pushd "$SCRATCH" >/dev/null

PROMPT="$TEST_DIR/prompt.md"
printf 'review $HEAD_SHA on $BASE_BRANCH ($CI_CHECKS_FILE)\n' > "$PROMPT"

# The fake child attaches to the scratch worktree (the "exact reviewed tree").
jq -n --arg p "$SCRATCH" '{thread:{id:"thr_child9",projectId:"proj_TEST",status:"idle"},environment:{id:"env_child9",path:$p}}' > "$FAKE_STATE/child-show.json"

# 5. Fresh spawn: exact environment/model/parent selection + @thread link,
#    valid verdict accepted.
printf '[]\n' > "$FAKE_STATE/list.json"
printf '{"ok":true,"note":"fine"}\n' > "$FAKE_STATE/output.txt"
reset_calls
RAW=""; REVIEWER_EXIT=99; REVIEW_BB_CHILD_ID=""
export REVIEW_BB_CHILD_ID
export BB_FAKE_ASSERT_OWNER=1
link_out_file="$TEST_DIR/link.out"
review_bb_run_reviewer "$PROMPT" "$HEAD_SHA_SCRATCH" "origin/main" "abcdef123456" \
  codex gpt-6-astra xhigh '(.ok == true)' "/tmp/ci.txt" >"$link_out_file" 2>&1
unset BB_FAKE_ASSERT_OWNER
link_out="$(cat "$link_out_file")"
[ "$REVIEWER_EXIT" = "0" ] || fail "valid child output must be accepted (got $REVIEWER_EXIT: $RAW)"
case "$RAW" in *'"ok":true'*) ;; *) fail "RAW must carry the child output" ;; esac
case "$link_out" in *"@thread:thr_child9"*) ;; *) fail "@thread link must print immediately, got: $link_out" ;; esac
grep -q -- '--parent-self' "$FAKE_STATE/calls.log" || fail "spawn must parent to the invoking thread"
grep -q -- '--provider codex' "$FAKE_STATE/calls.log" || fail "spawn must select the codex provider"
grep -q -- '--model gpt-6-astra' "$FAKE_STATE/calls.log" || fail "spawn must select the Codex model"
grep -q -- '--reasoning-level xhigh' "$FAKE_STATE/calls.log" || fail "spawn must select the effort"
grep -q -- "--environment $SCRATCH" "$FAKE_STATE/calls.log" || fail "spawn must attach the exact reviewed worktree"
grep -q -- '--permission-mode accept-edits' "$FAKE_STATE/calls.log" || fail "review child must use accept-edits"
grep -q -- '--visibility visible' "$FAKE_STATE/calls.log" || fail "review child must stay visible under a hidden parent"
grep -q -- '--project proj_TEST' "$FAKE_STATE/calls.log" || fail "spawn must use the parent project"
[ "$(spawn_calls)" = "1" ] || fail "exactly one spawn expected, got $(spawn_calls)"
[ -z "$REVIEW_BB_CHILD_ID" ] || fail "settled child ownership must be cleared"

# 6. Malformed child output is returned unsettled-neutral; the caller's schema
#    validation (mirrored here exactly as review.sh runs it) must reject it —
#    malformed output never becomes green.
printf 'not json at all\n' > "$FAKE_STATE/output.txt"
reset_calls
RAW=""; REVIEWER_EXIT=99
review_bb_run_reviewer "$PROMPT" "$HEAD_SHA_SCRATCH" "origin/main" "abcdef123456" \
  codex gpt-6-astra xhigh '(.ok == true)' "/tmp/ci.txt" >/dev/null 2>&1
[ "$REVIEWER_EXIT" = "0" ] || fail "settled malformed output reaches caller validation (got $REVIEWER_EXIT)"
MALFORMED_VERDICT="$(extract_json_verdict "$RAW" 2>/dev/null || true)"
if printf '%s\n' "$MALFORMED_VERDICT" | jq -e '(.ok == true)' >/dev/null 2>&1; then
  fail "malformed output must fail the caller's schema validation"
fi

# 7. Error-status child fails closed and is not reused.
jq -n --arg p "$SCRATCH" '{thread:{id:"thr_child9",projectId:"proj_TEST",status:"error"},environment:{id:"env_child9",path:$p}}' > "$FAKE_STATE/child-show.json"
printf '{"ok":true}\n' > "$FAKE_STATE/output.txt"
reset_calls
RAW=""; REVIEWER_EXIT=99
review_bb_run_reviewer "$PROMPT" "$HEAD_SHA_SCRATCH" "origin/main" "abcdef123456" \
  codex gpt-6-astra xhigh '(.ok == true)' "/tmp/ci.txt" >/dev/null 2>&1
[ "$REVIEWER_EXIT" = "1" ] || fail "error-status child must fail closed"
jq -n --arg p "$SCRATCH" '{thread:{id:"thr_child9",projectId:"proj_TEST",status:"idle"},environment:{id:"env_child9",path:$p}}' > "$FAKE_STATE/child-show.json"

# 8. Pending approval fails closed (a blocked session is never green).
printf '[{"kind":"approval"}]\n' > "$FAKE_STATE/interactions.json"
printf '{"ok":true}\n' > "$FAKE_STATE/output.txt"
reset_calls
RAW=""; REVIEWER_EXIT=99
review_bb_run_reviewer "$PROMPT" "$HEAD_SHA_SCRATCH" "origin/main" "abcdef123456" \
  codex gpt-6-astra xhigh '(.ok == true)' "/tmp/ci.txt" >/dev/null 2>&1
[ "$REVIEWER_EXIT" = "1" ] || fail "pending interaction must fail closed"
case "$RAW" in *approval*) ;; *) fail "RAW must name the approval block, got: $RAW" ;; esac
printf '[]\n' > "$FAKE_STATE/interactions.json"

# Failed interaction discovery cannot be accepted as zero pending approvals.
printf 'INVALID JSON\n' > "$FAKE_STATE/interactions.json"
review_bb_run_reviewer "$PROMPT" "$HEAD_SHA_SCRATCH" "origin/main" "abcdef123456" \
  codex gpt-6-astra xhigh '(.ok == true)' "/tmp/ci.txt" >/dev/null 2>&1
[ "$REVIEWER_EXIT" = "1" ] || fail "unreadable interactions must fail closed"
printf '[]\n' > "$FAKE_STATE/interactions.json"

# 9. HEAD moving mid-review discards the verdict.
printf '{"ok":true}\n' > "$FAKE_STATE/output.txt"
reset_calls
RAW=""; REVIEWER_EXIT=99
export REVIEW_BB_PRE_ACCEPT_HOOK_FOR_TESTS="git -C '$SCRATCH' commit -q --allow-empty -m moved"
review_bb_run_reviewer "$PROMPT" "$HEAD_SHA_SCRATCH" "origin/main" "abcdef123456" \
  codex gpt-6-astra xhigh '(.ok == true)' "/tmp/ci.txt" >/dev/null 2>&1
unset REVIEW_BB_PRE_ACCEPT_HOOK_FOR_TESTS
[ "$REVIEWER_EXIT" = "1" ] || fail "moved HEAD must discard the verdict"
HEAD_SHA_SCRATCH="$(git -C "$SCRATCH" rev-parse HEAD)"

# 10. Dedup: idle child with a valid verdict is reused (no new spawn).
TITLE_FOR_REUSE="$(review_bb_review_title "$(git branch --show-current)" "$HEAD_SHA_SCRATCH" codex gpt-6-astra xhigh abcdef123456 "")"
jq -n --arg t "$TITLE_FOR_REUSE" '[{id:"thr_old9",title:$t,status:"idle",updatedAt:2}]' > "$FAKE_STATE/list.json"
jq -n --arg p "$SCRATCH" '{thread:{id:"thr_old9",projectId:"proj_TEST",status:"idle"},environment:{id:"env_old",path:$p}}' > "$FAKE_STATE/child-show.json"
printf '{"ok":true,"note":"reused"}\n' > "$FAKE_STATE/output.txt"
reset_calls
RAW=""; REVIEWER_EXIT=99
review_bb_run_reviewer "$PROMPT" "$HEAD_SHA_SCRATCH" "origin/main" "abcdef123456" \
  codex gpt-6-astra xhigh '(.ok == true)' "/tmp/ci.txt" >/dev/null 2>&1
[ "$REVIEWER_EXIT" = "0" ] || fail "reused verdict must be accepted"
case "$RAW" in *reused*) ;; *) fail "must reuse the existing child output, got: $RAW" ;; esac
[ "$(spawn_calls)" = "0" ] || fail "dedup must not spawn a duplicate paid session"
jq -n --arg p "$SCRATCH" '{thread:{id:"thr_child9",projectId:"proj_TEST",status:"idle"},environment:{id:"env_child9",path:$p}}' > "$FAKE_STATE/child-show.json"
printf '[]\n' > "$FAKE_STATE/list.json"

# Reuse must not skip the checked-out HEAD or environment checks.
jq -n --arg t "$TITLE_FOR_REUSE" '[{id:"thr_old9",title:$t,status:"idle",updatedAt:2}]' > "$FAKE_STATE/list.json"
jq -n '{thread:{id:"thr_old9",status:"idle"},environment:{path:"/tmp/wrong-worktree"}}' > "$FAKE_STATE/child-show.json"
review_bb_run_reviewer "$PROMPT" "$HEAD_SHA_SCRATCH" "origin/main" "abcdef123456" \
  codex gpt-6-astra xhigh '(.ok == true)' "/tmp/ci.txt" >/dev/null 2>&1
[ "$REVIEWER_EXIT" = 1 ] || fail "reused verdict from the wrong environment must fail"
jq -n --arg p "$SCRATCH" '{thread:{id:"thr_child9",status:"idle"},environment:{path:$p}}' > "$FAKE_STATE/child-show.json"
printf '[]\n' > "$FAKE_STATE/list.json"

# 11. Dedup: a running child for identical inputs is adopted, not duplicated.
TITLE_RUNNING="$(review_bb_review_title "$(git branch --show-current)" "$HEAD_SHA_SCRATCH" codex gpt-6-astra xhigh abcdef123456 "")"
jq -n --arg t "$TITLE_RUNNING" '[{id:"thr_live9",title:$t,status:"active",updatedAt:3}]' > "$FAKE_STATE/list.json"
printf '{"ok":true,"note":"adopted"}\n' > "$FAKE_STATE/output.txt"
reset_calls
RAW=""; REVIEWER_EXIT=99
review_bb_run_reviewer "$PROMPT" "$HEAD_SHA_SCRATCH" "origin/main" "abcdef123456" \
  codex gpt-6-astra xhigh '(.ok == true)' "/tmp/ci.txt" >/dev/null 2>&1
[ "$REVIEWER_EXIT" = "0" ] || fail "adopted child output must be accepted"
[ "$(spawn_calls)" = "0" ] || fail "a running identical child must be adopted, not duplicated"
grep -q '^thread wait thr_live9' "$FAKE_STATE/calls.log" || fail "must wait on the adopted child"
printf '[]\n' > "$FAKE_STATE/list.json"

# 12. Cancellation ownership: only the owned child is stopped.
reset_calls
REVIEW_BB_CHILD_ID="thr_owned1"
review_bb_cancel_owned
grep -q '^thread stop thr_owned1' "$FAKE_STATE/calls.log" || fail "cancel must stop the owned child"
[ -z "$REVIEW_BB_CHILD_ID" ] || fail "cancel must clear ownership"
reset_calls
review_bb_cancel_owned
[ "$(grep -c '^thread stop' "$FAKE_STATE/calls.log" || true)" = "0" ] || fail "cancel with no owned child must stop nothing"

# A real TERM while waiting must trigger cleanup before the CLI timeout.
reset_calls
signal_rc=0
(
  trap 'review_bb_cancel_owned' EXIT
  trap 'exit 143' TERM
  REVIEW_BB_CHILD_ID=thr_signal1
  export BB_FAKE_WAIT_SIGNAL=1
  review_bb_wait_idle thr_signal1 20m
) >/dev/null 2>&1 || signal_rc=$?
[ "$signal_rc" = 143 ] || fail "TERM must interrupt the asynchronous CLI wait"
grep -q '^thread stop thr_signal1' "$FAKE_STATE/calls.log" || fail "TERM must stop the owned child"

# 13b. A disallowed Claude model fails before any spawn (reviewer flow).
printf '[]\n' > "$FAKE_STATE/list.json"
reset_calls
RAW=""; REVIEWER_EXIT=99
review_bb_run_reviewer "$PROMPT" "$HEAD_SHA_SCRATCH" "origin/main" "abcdef123456" \
  claude claude-sonnet-5-5 high '(.ok == true)' "/tmp/ci.txt" >/dev/null 2>&1
[ "$REVIEWER_EXIT" = "1" ] || fail "disallowed reviewer model must fail closed"
[ "$(spawn_calls)" = "0" ] || fail "disallowed reviewer model must never spawn"
case "$RAW" in *could\ not\ resolve*|*invalid*|*allowlist*) ;; *) fail "failure must name the model policy, got: $RAW" ;; esac

# 13. Wait timeout stops ONLY the owned child and fails.
export BB_FAKE_WAIT_RC=1
printf '{"ok":true}\n' > "$FAKE_STATE/output.txt"
reset_calls
RAW=""; REVIEWER_EXIT=99
review_bb_run_reviewer "$PROMPT" "$HEAD_SHA_SCRATCH" "origin/main" "abcdef123456" \
  codex gpt-6-astra xhigh '(.ok == true)' "/tmp/ci.txt" >/dev/null 2>&1
[ "$REVIEWER_EXIT" = "1" ] || fail "wait timeout must fail closed"
grep -q '^thread stop thr_child9' "$FAKE_STATE/calls.log" || fail "timeout must stop the owned child"
unset BB_FAKE_WAIT_RC

popd >/dev/null

# --- fixer flow ---------------------------------------------------------------

FIXSCRATCH="$TEST_DIR/fixscratch"
git init -qb main "$FIXSCRATCH"
git -C "$FIXSCRATCH" config user.email t@t.t
printf 'one\n' > "$FIXSCRATCH/file.txt"
mkdir -p "$FIXSCRATCH/prompts"
cp "$repo_root/prompts/review-fix-prompt.md" "$FIXSCRATCH/prompts/review-fix-prompt.md"
git -C "$FIXSCRATCH" add -- file.txt prompts/review-fix-prompt.md
git -C "$FIXSCRATCH" commit -qm init
pushd "$FIXSCRATCH" >/dev/null

fixer_env_ready() {
  # Child in an isolated worktree with a one-line patch.
  cat > "$FAKE_STATE/child-show.json" <<'JSON'
{"thread":{"id":"thr_fix9","projectId":"proj_TEST","status":"idle"},"environment":{"id":"env_fix9","path":"/tmp/isolated-worktree"}}
JSON
  printf '{"id":"thr_fix9"}\n' > "$FAKE_STATE/spawn.json"
  printf '[]\n' > "$FAKE_STATE/list.json"
  printf '[]\n' > "$FAKE_STATE/interactions.json"
  printf 'fixed it\n' > "$FAKE_STATE/output.txt"
  printf 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-one\n+two\n' > "$FAKE_STATE/fixer.patch"
  printf '' > "$FAKE_STATE/committed.patch"
  reset_calls
}

# Input snapshots preserve binary data, spaces, and the driver's real index.
printf 'staged\n' > staged.txt
git add -- staged.txt
printf '\0binary\377' > 'new file.bin'
printf 'excluded\n' > credentials.txt
index_before="$(git diff --cached | sha1sum)"
review_bb_input_patch > "$TEST_DIR/input.patch"
[ "$(git diff --cached | sha1sum)" = "$index_before" ] || fail "snapshot must not mutate the real index"
! grep -q credentials.txt "$TEST_DIR/input.patch" || fail "secret-looking files must be excluded"
grep -q 'new file.bin' "$TEST_DIR/input.patch" || fail "spaces and binary new files must be snapshotted"
review_bb_patch_tree HEAD "$TEST_DIR/input.patch" >/dev/null || fail "binary input must reproduce cleanly"
git reset -q HEAD -- staged.txt
rm -f staged.txt 'new file.bin' credentials.txt

# Failed, empty, blocked, and truncated fixer results cannot transfer changes.
for failure in error empty interactions truncated; do
  fixer_env_ready
  case "$failure" in
    error) jq '.thread.status = "error"' "$FAKE_STATE/child-show.json" > "$TEST_DIR/error.json"; cp "$TEST_DIR/error.json" "$FAKE_STATE/child-show.json" ;;
    empty) : > "$FAKE_STATE/output.txt" ;;
    interactions) printf 'invalid\n' > "$FAKE_STATE/interactions.json" ;;
    truncated) export BB_FAKE_TRUNCATED=true ;;
  esac
  review_bb_run_fixer "origin/main" >/dev/null 2>&1 && fail "$failure fixer must fail closed"
  unset BB_FAKE_TRUNCATED
  [ "$(cat file.txt)" = one ] || fail "$failure fixer must preserve parent content"
done

# 14. Fixer spawns isolated (new worktree, never the shared path) and the
#     reviewed patch is transferred.
fixer_env_ready
export BB_FAKE_ASSERT_OWNER=1 BB_FAKE_EXPECT_OWNER=thr_fix9
review_bb_run_fixer "origin/main" >/dev/null 2>&1 || fail "fixer run must succeed"
unset BB_FAKE_ASSERT_OWNER BB_FAKE_EXPECT_OWNER
grep -q -- "--base-branch $(git rev-parse HEAD)" "$FAKE_STATE/calls.log" || fail "fixer must branch at the pinned commit"
[ "$(cat file.txt)" = "two" ] || fail "fixer patch must be applied"
grep -q -- '--new-environment worktree' "$FAKE_STATE/calls.log" || fail "fixer must use an isolated worktree"
grep -q -- "--environment $FIXSCRATCH" "$FAKE_STATE/calls.log" && fail "fixer must NOT attach the driver worktree"
grep -q '^thread archive thr_fix9' "$FAKE_STATE/calls.log" || fail "successful fixer child must be archived (cleanup ownership)"
printf 'one\n' > file.txt
git -C "$FIXSCRATCH" diff --quiet || git -C "$FIXSCRATCH" commit -qam restore-14 >/dev/null 2>&1 || true

# 14b. Async worktree provisioning: env absent pre-wait is verified post-settle.
fixer_env_ready
mkdir -p "$FAKE_STATE/show-queue"
printf '{"thread":{"id":"thr_fix9","projectId":"proj_TEST","status":"starting"},"environment":null}\n' > "$FAKE_STATE/show-queue/01-pending.json"
review_bb_run_fixer "origin/main" >/dev/null 2>&1 || fail "fixer must tolerate async env provisioning"
[ "$(cat file.txt)" = "two" ] || fail "fixer patch must apply after async provisioning"
rm -rf "$FAKE_STATE/show-queue"
printf 'one\n' > "$FIXSCRATCH/file.txt"
git -C "$FIXSCRATCH" diff --quiet || git -C "$FIXSCRATCH" commit -qam restore-14b >/dev/null 2>&1 || true

# 14d. A committed stack that does not match the driver input is rejected.
fixer_env_ready
printf 'diff --git a/other.txt b/other.txt\n--- /dev/null\n+++ b/other.txt\n@@ -0,0 +1 @@\n+sneaky commit\n' > "$FAKE_STATE/committed.patch"
review_bb_run_fixer "origin/main" >/dev/null 2>&1 && fail "committed-stack mismatch must fail explicitly"
[ "$(cat file.txt)" = "one" ] || fail "committed-stack mismatch must leave the tree untouched"

# 14e. A disallowed Claude fixer model fails before any spawn (fixer flow
# shares the same resolver choke point as the reviewer flow).
fixer_env_ready
export FIXER_CLI=claude CLAUDE_REVIEW_MODEL=claude-sonnet-5-5
review_bb_run_fixer "origin/main" >/dev/null 2>&1 && fail "disallowed fixer model must fail closed"
unset FIXER_CLI CLAUDE_REVIEW_MODEL
[ "$(spawn_calls)" = "0" ] || fail "disallowed fixer model must never spawn"
[ "$(cat file.txt)" = "one" ] || fail "disallowed fixer model must leave the tree untouched"

# 15. Concurrent driver edits abort the transfer; the tree is untouched.
printf 'one\n' > file.txt
git -C "$FIXSCRATCH" commit -qam restore-after-14 >/dev/null 2>&1 || true
fixer_env_ready
export REVIEW_BB_PRE_RECONCILE_HOOK_FOR_TESTS="printf 'concurrent\n' > '$FIXSCRATCH/file.txt'"
review_bb_run_fixer "origin/main" >/dev/null 2>&1 && fail "concurrent edits must abort the transfer"
unset REVIEW_BB_PRE_RECONCILE_HOOK_FOR_TESTS
[ "$(cat file.txt)" = "concurrent" ] || fail "concurrent driver content must be preserved verbatim"
printf 'one\n' > file.txt
git -C "$FIXSCRATCH" diff --quiet || git -C "$FIXSCRATCH" commit -qam restore

# 16. A patch that does not apply is preserved, never forced.
fixer_env_ready
printf 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-NOPE\n+two\n' > "$FAKE_STATE/fixer.patch"
review_bb_run_fixer "origin/main" >/dev/null 2>&1 && fail "unapplicable patch must fail"
[ "$(cat file.txt)" = "one" ] || fail "failed patch must leave the tree untouched"

# 16b. A non-empty but unrecognized fixer diff is never silently dropped.
fixer_env_ready
printf 'SOME UNRECOGNIZED FORMAT\n' > "$FAKE_STATE/fixer.patch"
review_bb_run_fixer "origin/main" >/dev/null 2>&1 && fail "unrecognized fixer diff must fail explicitly"
[ "$(cat file.txt)" = "one" ] || fail "unrecognized diff must leave the tree untouched"

# 17. Secret-looking untracked files never enter the fixer input.
fixer_env_ready
printf 'AKIAEXAMPLE\n' > "$FIXSCRATCH/.env"
printf 'notes\n' > "$FIXSCRATCH/todo.txt"
git diff --no-index -- /dev/null todo.txt > "$FAKE_STATE/committed.patch" || [ "$?" = 1 ]
review_bb_run_fixer "origin/main" >/dev/null 2>&1 || fail "fixer with untracked files must succeed"
[ -f "$FIXSCRATCH/.env" ] || fail "untracked files must be left alone in the driver tree"
[ "$(cat file.txt)" = "two" ] || fail "fixer patch must still apply with untracked files present"
printf 'one\n' > file.txt
fixer_env_ready
git diff --no-index -- /dev/null todo.txt > "$FAKE_STATE/committed.patch" || [ "$?" = 1 ]
export REVIEW_BB_PRE_RECONCILE_HOOK_FOR_TESTS="printf 'changed\n' > '$FIXSCRATCH/todo.txt'"
review_bb_run_fixer "origin/main" >/dev/null 2>&1 && fail "untracked content changes must abort transfer"
unset REVIEW_BB_PRE_RECONCILE_HOOK_FOR_TESTS
[ "$(cat file.txt)" = one ] || fail "untracked conflict must preserve tracked files"
[ "$(cat todo.txt)" = changed ] || fail "untracked conflict must preserve new content"
rm -f "$FIXSCRATCH/.env" "$FIXSCRATCH/todo.txt"
git -C "$FIXSCRATCH" checkout -q -- file.txt 2>/dev/null || printf 'one\n' > "$FIXSCRATCH/file.txt"

popd >/dev/null

# --- wiring pins (review.sh / review-fix.sh must route through this lib) ------

REVIEW_SH="$repo_root/scripts/review.sh"
REVIEW_FIX_SH="$repo_root/scripts/review-fix.sh"

grep -Fq '. "$SCRIPT_DIR/lib/review-bb.sh"' "$REVIEW_SH" ||
  fail "review.sh must source review-bb.sh"
grep -Fq 'review_bb_wants_run' "$REVIEW_SH" ||
  fail "review.sh must branch on BB context"
grep -Fq 'review_bb_run_reviewer' "$REVIEW_SH" ||
  fail "review.sh must run the reviewer through the visible BB child"
grep -Fq 'review_bb_cancel_owned' "$REVIEW_SH" ||
  fail "review.sh must cancel the owned BB child on exit"
# The BB branch must precede any direct local spawn inside run_reviewer_inline.
bb_branch_line="$(grep -n 'review_bb_run_reviewer' "$REVIEW_SH" | head -n1 | cut -d: -f1)"
direct_spawn_line="$(grep -n 'run_review_child' "$REVIEW_SH" | head -n1 | cut -d: -f1)"
[ -n "$bb_branch_line" ] && [ -n "$direct_spawn_line" ] && [ "$bb_branch_line" -lt "$direct_spawn_line" ] ||
  fail "the BB child branch must precede the direct local spawn"

grep -Fq '. "$SCRIPT_DIR/lib/review-bb.sh"' "$REVIEW_FIX_SH" ||
  fail "review-fix.sh must source review-bb.sh"
grep -Fq 'review_bb_run_fixer' "$REVIEW_FIX_SH" ||
  fail "review-fix.sh must route through the isolated BB fixer"
grep -Fq 'review_bb_cancel_owned' "$REVIEW_FIX_SH" ||
  fail "review-fix.sh must cancel the owned BB child on exit"
# The BB fixer owns isolation; the direct path must not gain a second writer.
if grep -Eq 'codex exec --sandbox workspace-write' "$REVIEW_SH"; then
  fail "review.sh must stay read-only; the writer belongs to review-fix.sh"
fi

echo "review bb tests passed"
