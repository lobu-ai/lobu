# review-skip.sh — safe-class diff classifier for the cross-harness review.
# shellcheck shell=bash
#
# REVIEWER_MODE=light (default) skips the cross-harness reviewer when the diff
# contains only inert docs or small changes where an independent LLM review
# adds near-zero signal: snapshots, exact renames between safe-class paths, additive-only
# test changes, exact model-literal swaps in lobu.config.ts, or a pure
# packages/owletto pointer bump. Everything else — non-test source, migrations,
# runtime-affecting config, static assets, other/mixed submodule changes, and
# the gate/CI machinery itself — forces the full review regardless of size.
#
# The classifier is deterministic and path-gated. The driving agent may only
# escalate (REVIEWER_MODE=full), never skip on self-assessed confidence: the
# whole point of the cross-harness review is independence from the authoring
# model's blind spots, and confidence is anti-correlated with exactly those.

# Output contract read by review.sh and the tests.
# shellcheck disable=SC2034
REVIEW_SKIP_REASON=""

# Any diff that touches these paths must run the full review, no matter how
# small. Package manifests and runtime-affecting config control the same
# subsystems (auth, queues, deps) that a src change would escalate on; and the
# gate machinery itself must never be reviewed by its own skip rule.
#
# The packages/owletto pointer is handled below: Owletto owns semantic review
# of its content, and `check-drift` forbids pinning anything not on its main
# branch. Only a pointer-to-pointer change with no companion path is safe;
# additions, removals, type changes, and every other submodule still escalate.
review_skip_hard_escalate() {
  local path="$1"
  case "$path" in
    scripts/review*|scripts/lib/review*|prompts/*|docs/REVIEW_SCHEMA.md|Makefile|makefile|.github/*|AGENTS.md|CLAUDE.md|*/AGENTS.md|*/CLAUDE.md|skills/*|.claude/*|.agents/*|.codex/*) return 0 ;;
    db/migrations/*|db/schema.sql) return 0 ;;
    package.json) return 0 ;;
    config/*|.env*|.gitmodules) return 0 ;;
    bun.lock) return 1 ;;
    *.toml|*.yaml|*.yml) return 0 ;;
  esac
  return 1
}

# A model route literal swap is a narrow declarative change. Keep this
# deliberately strict: both sides must be quoted model literals, and any
# companion prompt, trigger, notification, or structural edit makes the whole
# file require review.
review_skip_is_model_only_change() {
  local diff_spec="$1" path="$2"
  git diff --unified=0 --no-color "$diff_spec" -- "$path" 2>/dev/null | awk '
    function model_shape(value, quote_pos, quote_char, tail, close_pos) {
      quote_pos = match(value, /["\047]/)
      quote_char = substr(value, quote_pos, 1)
      tail = substr(value, quote_pos + 1)
      close_pos = index(tail, quote_char)
      return substr(value, 1, quote_pos) "<model>" substr(tail, close_pos)
    }
    /^--- / || /^\+\+\+ / { next }
    /^@@ / {
      hunk++
      next
    }
    /^[+-]/ {
      line = substr($0, 2)
      if (line !~ /^[[:space:]]*model:[[:space:]]*["\047][^"\047]+["\047][[:space:]]*,?[[:space:]]*$/) {
        bad = 1
        next
      }
      shape = model_shape(line)
      if (substr($0, 1, 1) == "+") {
        added[hunk]++
        added_shapes[hunk, shape]++
      } else {
        removed[hunk]++
        removed_shapes[hunk, shape]++
      }
    }
    END {
      if (hunk == 0 || bad != 0) exit 1
      for (current = 1; current <= hunk; current++) {
        if (added[current] == 0 || removed[current] == 0 || added[current] != removed[current]) exit 1
      }
      for (key in added_shapes) {
        if (added_shapes[key] != removed_shapes[key]) exit 1
      }
      for (key in removed_shapes) {
        if (removed_shapes[key] != added_shapes[key]) exit 1
      }
      exit 0
    }
  '
}

review_skip_is_test_path() {
  case "$1" in
    */__tests__/*) return 0 ;;
  esac
  case "$1" in
    *.test.ts) return 0 ;;
    *.test.tsx) return 0 ;;
    *.test.js) return 0 ;;
    *.test.jsx) return 0 ;;
  esac
  return 1
}

# review_classify_diff <base> [head|worktree]
# Returns 0 when the cross-harness review may be skipped, setting
# REVIEW_SKIP_REASON; returns 1 when the full review is required.
review_classify_diff() {
  local base="$1" scope="${2:-head}" merge_base diff_spec total changed_paths status p1 p2 path
  local base_mode head_mode del saw_file saw_submodule exact_rename untracked submodule_dirty
  REVIEW_SKIP_REASON=""
  saw_file=0
  saw_submodule=0

  merge_base="$(git merge-base "$base" HEAD 2>/dev/null)"
  if [ -z "$merge_base" ]; then
    REVIEW_SKIP_REASON="no merge base between '$base' and HEAD"
    return 1
  fi

  case "$scope" in
    head) diff_spec="$merge_base..HEAD" ;;
    worktree)
      # Compare the prospective committed tree to the same merge base used by
      # the posted review. Base-only commits are not part of this branch.
      diff_spec="$merge_base"
      untracked="$(git ls-files --others --exclude-standard | head -n 1)"
      if [ -n "$untracked" ]; then
        REVIEW_SKIP_REASON="untracked file '$untracked'"
        return 1
      fi
      ;;
    *)
      REVIEW_SKIP_REASON="invalid classification scope '$scope'"
      return 1
      ;;
  esac

  # -M100% pins rename detection to exact content matches regardless of the
  # user's diff.renames config, so the line count is deterministic.
  total="$(git diff --numstat -M100% "$diff_spec" 2>/dev/null | awk '{a+=$1; d+=$2} END {print a+d}')"
  [ -n "$total" ] || total=0

  changed_paths="$(git diff --name-only -M100% "$diff_spec" 2>/dev/null | awk 'END {print NR + 0}')"

  # --name-status with exact-only rename detection (-M100%): a rename reports
  # BOTH sides, and both must be safe-class — otherwise `git mv src/x.ts x.md`
  # would hide a source deletion behind a docs-looking destination. NOTE:
  # -M100 without the % is a ~10% similarity threshold, which would also pair
  # a mostly-rewritten delete/add across classes; exact-only keeps every
  # content change visible under its real path.
  while IFS=$'\t' read -r status p1 p2; do
    [ -n "$p1" ] || continue
    saw_file=1
    exact_rename=0
    case "$status" in
      R*) exact_rename=1 ;;
    esac

    for path in "$p1" ${p2:+"$p2"}; do
      if review_skip_hard_escalate "$path"; then
        REVIEW_SKIP_REASON="touches '$path'"
        return 1
      fi

      # Inspect both trees before extension-based safe classes: a gitlink can
      # have a docs-looking name. Only an existing Owletto pointer changing SHA
      # as the sole path may skip; all other gitlink changes receive review.
      base_mode="$(git ls-tree "$merge_base" -- "$path" 2>/dev/null | awk 'NR==1 {print $1}')"
      if [ "$scope" = "worktree" ]; then
        head_mode="$(git ls-files --stage -- "$path" 2>/dev/null | awk 'NR==1 {print $1}')"
        if [ "$head_mode" = "160000" ] \
          && git -C "$path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
          if ! submodule_dirty="$(git -C "$path" status --porcelain --untracked-files=normal 2>/dev/null)"; then
            REVIEW_SKIP_REASON="could not inspect submodule path '$path'"
            return 1
          fi
          if [ -n "$submodule_dirty" ]; then
            REVIEW_SKIP_REASON="submodule path '$path' has uncommitted content"
            return 1
          fi
        fi
      else
        head_mode="$(git ls-tree HEAD -- "$path" 2>/dev/null | awk 'NR==1 {print $1}')"
      fi
      if [ "$base_mode" = "160000" ] || [ "$head_mode" = "160000" ]; then
        if [ "$path" != "packages/owletto" ] \
          || [ "$base_mode" != "160000" ] \
          || [ "$head_mode" != "160000" ]; then
          REVIEW_SKIP_REASON="touches submodule path '$path'"
          return 1
        fi
        if [ "$changed_paths" -ne 1 ]; then
          REVIEW_SKIP_REASON="submodule pointer bump is mixed with other changes"
          return 1
        fi
        saw_submodule=1
        continue
      fi

      # Documentation must be regular text. A docs-looking symlink or binary,
      # executable file, or script under docs/ is not an inert prose change.
      case "$base_mode:$head_mode" in
        *120000*|*100755*)
          REVIEW_SKIP_REASON="non-regular documentation or executable path '$path'"; return 1 ;;
      esac
      if git diff --numstat "$diff_spec" -- "$path" | awk '$1 == "-" || $2 == "-" { found=1 } END { exit !found }'; then
        REVIEW_SKIP_REASON="binary change '$path'"; return 1
      fi
      case "$path" in
        README|README.txt|LICENSE|LICENSE.txt) continue ;;
        *.md)
          case "$path" in
            docs/*|*/docs/*|*/README.md|*/CHANGELOG.md) continue ;;
            */*) ;; # Markdown under runtime source is not automatically docs.
            *) continue ;;
          esac
          ;;
      esac
      # Size alone does not escalate inert prose. Other safe classes retain
      # the conservative small-change bound.
      if [ "$total" -ge 100 ]; then
        REVIEW_SKIP_REASON="non-documentation diff too large ($total lines)"; return 1
      fi
      case "$path" in
        packages/owletto/src/routeTree.gen.ts) continue ;;
        */__snapshots__/*|*.snap) continue ;;
      esac
      case "$path" in
        lobu.config.ts|*/lobu.config.ts)
          if review_skip_is_model_only_change "$diff_spec" "$path"; then
            continue
          fi
          ;;
      esac
      if review_skip_is_test_path "$path"; then
        # An exact rename changes no content, so no assertion can have moved.
        if [ "$exact_rename" = "1" ]; then
          continue
        fi
        # Additive-only tests are safe; a test change that deletes or rewrites
        # assertions is exactly where regressions hide, so it escalates.
        del="$(git diff --numstat "$diff_spec" -- "$path" 2>/dev/null | awk 'NR==1 {print $2}')"
        if [ "${del:-0}" -eq 0 ]; then
          continue
        fi
        REVIEW_SKIP_REASON="test change deletes/changes assertions in '$path'"
        return 1
      fi
      REVIEW_SKIP_REASON="unclassified file '$path'"
      return 1
    done
  done < <(git diff --name-status -M100% "$diff_spec" 2>/dev/null)

  if [ "$saw_file" = "0" ]; then
    REVIEW_SKIP_REASON="no diff against $base"
  elif [ "$saw_submodule" = "1" ]; then
    REVIEW_SKIP_REASON="pure packages/owletto submodule pointer bump"
  else
    REVIEW_SKIP_REASON="path/content-gated safe-class diff ($total lines)"
  fi
  return 0
}

# CI copies this trusted base-branch file outside the checkout before inspecting
# the PR tree. No script, config, dependency or action from the PR is executed.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  if review_classify_diff "${1:?base commit required}"; then
    printf '%s\n' "$REVIEW_SKIP_REASON"
  else
    printf 'Independent review required: %s\n' "$REVIEW_SKIP_REASON" >&2
    exit 1
  fi
fi
