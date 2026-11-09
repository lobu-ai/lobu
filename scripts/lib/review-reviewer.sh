#!/usr/bin/env bash

review_is_codex_harness() {
  [ -n "${CODEX_THREAD_ID:-}" ] ||
    [ -n "${CODEX_MANAGED_PACKAGE_ROOT:-}" ] ||
    [ "${CODEX_CI:-}" = "1" ]
}

review_select_reviewer() {
  case "$1" in
    auto)
      if review_is_codex_harness; then
        printf 'claude\n'
      else
        printf 'codex\n'
      fi
      ;;
    codex|claude)
      printf '%s\n' "$1"
      ;;
    *)
      echo "invalid REVIEWER_CLI=$1 (expected auto, codex, or claude)" >&2
      return 2
      ;;
  esac
}

review_validate_claude_model() {
  case "$1" in
    fable|opus|claude-opus-?*) return 0 ;;
    *)
      echo "invalid CLAUDE_REVIEW_MODEL=$1 (only fable, opus, or a claude-opus-* model is allowed)" >&2
      return 2
      ;;
  esac
}

review_should_retry_inline() {
  [ "$1" -eq 0 ] || return 1
  [ -z "$(printf '%s' "$2" | tr -d '[:space:]')" ]
}

review_fail_closed_message() {
  local reviewer="$1"
  local detail="$2"
  printf "Independent review could not be completed by '%s': %s. The review gate fails closed and will not fall back to another reviewer. Fix the selected reviewer's installation, authentication, quota, or configuration, then rerun; use REVIEWER_CLI=claude|codex only to explicitly select the intended independent reviewer.\n" \
    "$reviewer" "$detail"
}

# review_refuse_submodule: the review driver and writer review lobu itself. Started
# inside a submodule checkout (packages/owletto), review.sh takes HEAD, the
# diff and `gh pr view` from the submodule but posts the PR comment to the
# hard-coded lobu-ai/lobu repo, so the verdict lands on the same-numbered
# lobu PR; review-write.sh cd's to the superproject and silently fixes lobu
# instead. The submodule's repository owns its content review; a pure
# pointer bump in lobu is a safe class.
review_refuse_submodule() {
  local superproject
  superproject="$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)"
  [ -n "$superproject" ] || return 0
  echo "Refusing to review from inside submodule $(git rev-parse --show-toplevel) of $superproject." >&2
  echo "Review submodule changes in the submodule's own repository; run this from the lobu checkout for lobu changes." >&2
  return 2
}

# Parse dotenv as data, never shell code; load only review settings. Shell
# values win (including explicit empty values), then .env.local, then .env.
review_load_config() {
  local root="$1" settings key value
  settings="$(node - "$root" <<'JS'
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const path = require('node:path');
const root = process.argv[2];
const values = {};
for (const file of ['.env', '.env.local']) {
  const name = path.join(root, file);
  if (fs.existsSync(name)) Object.assign(values, parseEnv(fs.readFileSync(name, 'utf8')));
}
const keys = ['CLAUDE_REVIEW_MODEL', 'CODEX_REVIEW_MODEL', 'CLAUDE_REVIEW_EFFORT',
  'CODEX_REVIEW_EFFORT', 'REVIEWER_CLI', 'REVIEW_MAX_AUTOFIX_PASSES'];
for (const key of keys) {
  if (Object.hasOwn(values, key)) console.log(key + '=' + JSON.stringify(values[key]));
}
JS
)" || return 2
  while IFS='=' read -r key value; do
    [ -n "$key" ] || continue
    if [ -z "${!key+x}" ]; then
      value="$(printf '%s' "$value" | jq -r .)" || return 2
      printf -v "$key" '%s' "$value"
      export "$key"
    fi
  done <<< "$settings"
}

review_require_model() {
  local reviewer="$1" model
  if [ "$reviewer" = claude ]; then
    model="${CLAUDE_REVIEW_MODEL:-}"
    review_validate_claude_model "$model" || return $?
  else
    model="${CODEX_REVIEW_MODEL:-}"
    if [ -z "$model" ]; then
      echo 'Set CODEX_REVIEW_MODEL in .env, .env.local, or the exported environment.' >&2
      return 2
    fi
  fi
}

# Internal write-phase result, separate from the stable read-only verdict.
review_validate_fix_result() {
  jq -e '
    (.summary | type == "string") and
    (.decisions | type == "array" and all(.[];
      (.kind | IN("product", "architecture", "credentials", "verification")) and
      (.finding | type == "string") and (.question | type == "string"))) and
    (.tests | type == "array" and all(.[];
      (.command | type == "string" and length > 0) and (.passed | type == "boolean")))
  ' "$1" >/dev/null 2>&1
}

# Validate the closed verdict plus the decision/findings relationship. The tree
# binds an output to this request even when a BB session has older verdicts.
review_verdict_predicate() {
  cat <<'JQ'
def text: type == "string" and length > 0;
def strings: type == "array" and all(.[]; text);
(type == "object" and (keys == ["decision","findings","verification"])) and
(.decision | IN("pass","changes_needed","verification_blocked")) and
(.findings | type == "array" and all(.[];
  type == "object" and (keys == ["blocking","evidence","file","issue","line"]) and
  (.file | text) and (.issue | text) and (.evidence | text) and
  (.blocking | type == "boolean") and
  (.line == null or (.line | type == "number" and floor == . and . >= 1)))) and
(.verification | type == "object" and (keys == ["checked","missing","tree"]) and
  (.tree | type == "string" and test("^[0-9a-f]{40,64}$")) and
  (.checked | strings) and (.missing | strings)) and
(if .decision == "pass" then
  all(.findings[]; .blocking == false) and (.verification.missing | length == 0)
elif .decision == "changes_needed" then any(.findings[]; .blocking)
else (.verification.missing | length > 0) end)
JQ
}

# Accept one JSON object with optional surrounding prose/fences. Never choose
# arbitrarily between multiple verdicts. json's decoder handles escaped quotes
# and braces in evidence strings, which hand-written brace scanners got wrong.
extract_json_verdict() {
  printf '%s\n' "$1" | python3 -c '
import json, sys
raw = sys.stdin.read()
decoder = json.JSONDecoder()
objects = []
i = 0
while i < len(raw):
    if raw[i] != "{":
        i += 1
        continue
    try:
        value, end = decoder.raw_decode(raw, i)
    except ValueError:
        i += 1
        continue
    objects.append(value)
    i = end
if len(objects) != 1:
    sys.exit(1)
print(json.dumps(objects[0]))
'
}
