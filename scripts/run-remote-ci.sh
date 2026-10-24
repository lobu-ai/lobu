#!/usr/bin/env bash
# Run the Linux CI graph against local changes (optional; GitHub CI is canonical).
#
# Provider (REMOTE_CI_PROVIDER, default: auto):
#   auto    - prefer Boat, then Daytona, then local when CLIs are absent.
#             An installed but unusable provider fails closed.
#   boat    - require Boat (fail closed if unavailable).
#   daytona - require Daytona (fail closed if unavailable).
#   local   - force local execution.
#
# Job list: pass job names as args (see scripts/lib/gate-runner.sh) or rely on
# the default full Linux graph. REMOTE_JOBS on the make target narrows it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/remote-ci.sh
. "$SCRIPT_DIR/lib/remote-ci.sh"
cd "$REPO_ROOT"

REMOTE_CI_TIMEOUT_SECONDS="${REMOTE_CI_TIMEOUT_SECONDS:-2700}"
# All Linux jobs; mac-build-smoke requires macOS and stays on GitHub/Mac.
# Keep in sync with GATE_JOBS in scripts/lib/gate-runner.sh.
DEFAULT_JOBS=(
  unit
  frontend
  server-integration-vitest
  server-integration-bun
  integration
  format-lint
  typecheck
  migrations
  sdk-cli-build
  sdk-lifecycle-e2e
  sdk-error-taxonomy-e2e
  cli-command-smoke
  sdk-cli-e2e
  dead-code-report
  optional-smoke-filter
  connector-parity-smoke
)

# ── provider resolution ────────────────────────────────────────────────────

# Daytona provider state: "ready" (usable), "absent" (CLI/jq not on PATH),
# or "faulty" (CLI present but not usable — e.g. not logged in). The caller
# decides: absent is a legitimate not-set-up case (fall back to local), but
# faulty is a misconfiguration/regression that must not be silently masked.
daytona_probe() {
  command -v daytona >/dev/null 2>&1 || { echo absent; return; }
  # Sandbox polling pipes `daytona list --format json` through jq; without
  # jq the run would fail mid-way, so treat a missing jq as faulty too.
  command -v jq >/dev/null 2>&1 || { echo faulty; return; }
  # `daytona list` fails when not logged in — that's the readiness probe.
  if daytona list >/dev/null 2>&1; then echo ready; else echo faulty; fi
}

daytona_ready() {
  [ "$(daytona_probe)" = "ready" ]
}

boat_probe() {
  command -v boat >/dev/null 2>&1 || { echo absent; return; }
  # `run` and `status --check` require a current CLI (verified with 1.0.68).
  boat run --help >/dev/null 2>&1 || { echo faulty; return; }
  if boat status --check >/dev/null 2>&1; then echo ready; else echo faulty; fi
}

PROVIDER="${REMOTE_CI_PROVIDER:-auto}"
case "$PROVIDER" in
  auto)
    case "$(boat_probe)" in
      ready) PROVIDER=boat ;;
      faulty)
        echo "Boat CLI is installed but not usable — refusing to silently fall back." >&2
        echo "Update Boat (boat self-update) and run 'boat login', or select REMOTE_CI_PROVIDER=daytona|local explicitly." >&2
        exit 2 ;;
      absent)
        case "$(daytona_probe)" in
          ready) PROVIDER=daytona ;;
          absent) PROVIDER=local ;;
          faulty)
            echo "Daytona CLI is installed but not usable — refusing to silently fall back." >&2
            echo "Run 'daytona login', or select REMOTE_CI_PROVIDER=local explicitly." >&2
            exit 2 ;;
        esac ;;
    esac
    echo ">> provider: $PROVIDER"
    ;;
  boat)
    [ "$(boat_probe)" = ready ] || {
      echo "REMOTE_CI_PROVIDER=boat requires a current authenticated Boat CLI (boat self-update; boat login)." >&2
      exit 2
    } ;;
  daytona)
    daytona_ready || {
      echo "REMOTE_CI_PROVIDER=daytona but the Daytona CLI is not available or not logged in." >&2
      exit 2
    } ;;
  local) ;;
  *)
    echo "Unknown REMOTE_CI_PROVIDER '$PROVIDER' (auto | boat | daytona | local)." >&2
    exit 2 ;;
esac

if [ "$#" -eq 0 ]; then
  jobs=("${DEFAULT_JOBS[@]}")
else
  jobs=("$@")
fi

# ── local fallback ─────────────────────────────────────────────────────────

run_local() {
  local jobs=("$@")
  echo ">> running ${#jobs[@]} jobs locally: ${jobs[*]}"
  bash scripts/lib/gate-runner.sh "${jobs[@]}"
}

# ── Daytona ephemeral sandbox ──────────────────────────────────────────────

run_daytona() {
  local jobs=("$@")
  # The sandbox only sees committed/staged content, so require a settled tree
  # (GATE_SKIP_SETTLED_CHECK=1 is a test-only escape hatch so the dispatch
  # tests don't depend on this checkout's tree state).
  if [ "${GATE_SKIP_SETTLED_CHECK:-0}" != "1" ]; then
    remote_ci_staged_tree >/dev/null || exit $?
  fi
  # base/name are GLOBALS on purpose: the EXIT trap runs after this function
  # returns, when its locals are gone — a local would silently skip cleanup.
  local stage ctx ws
  base="$(mktemp -d "${TMPDIR:-/tmp}/lobu-pr-full.XXXXXX")"
  stage="$base/stage"
  ctx="$base/ctx"
  mkdir -p "$stage" "$ctx"
  remote_ci_materialize "$stage"
  # Daytona's build context excludes .github / .env* by default, and the CI
  # wrapper guards in format-lint read .github/actions + ci.yml. Ship the tree
  # as ONE tarball so nothing is filtered, and let the Dockerfile ADD-extract it.
  tar -czf "$ctx/repo.tar.gz" -C "$stage" .
  printf 'FROM ubuntu:24.04\nADD repo.tar.gz /workspace/lobu\nWORKDIR /workspace/lobu\n' > "$ctx/Dockerfile"
  # $$ keeps the name unique when a previous run is still deleting its sandbox.
  name="lobu-pr-full-$(git rev-parse --short HEAD 2>/dev/null || echo local)-$$"
  echo ">> creating ephemeral Daytona sandbox '$name' (${#jobs[@]} jobs)"
  local create_out create_rc=0
  # NOTE: --memory is in GB on CLI v0.204.0 despite the help text saying MB.
  # Empirically verified: --memory 4096 → API rejects "Memory request 4096GB
  # exceeds maximum allowed per sandbox (8GB)"; --memory 4 → sandbox reports
  # memory=4 (GB). Do NOT switch to MB units — that would request 4GB×1024.
  # The org's free tier caps total running memory (~10GiB), so default small.
  create_out="$(daytona create -c "$ctx" --dockerfile "$ctx/Dockerfile" --name "$name" \
    --cpu "${DAYTONA_CPU:-4}" --memory "${DAYTONA_MEMORY_GB:-4}" --disk "${DAYTONA_DISK_GB:-10}" \
    --auto-delete 0 --auto-stop 0 --ttl "${DAYTONA_TTL_MINUTES:-120}" \
    --target "${DAYTONA_TARGET:-eu}" 2>&1)" || create_rc=$?
  if [ "$create_rc" -ne 0 ]; then
    echo "Daytona create failed:" >&2
    echo "$create_out" >&2
    rm -rf "$base"
    exit 1
  fi
  echo "$create_out" | grep -viE '^\[[0-9]+m' | tail -3 || true

  # Cleanup: delete the sandbox and the context dir on every exit path.
  # The trap outlives run_daytona, so guard the function locals (set -u).
  cleanup() {
    if [ -n "${name:-}" ]; then
      # This CLI has no --force flag; delete by name.
      daytona delete "$name" >/dev/null 2>&1 || true
    fi
    if [ -n "${base:-}" ]; then
      rm -rf "$base"
    fi
  }
  trap cleanup EXIT

  # Wait for the sandbox to reach RUNNING.
  local deadline=$((SECONDS + 600))
  while ! daytona_sandbox_running "$name"; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "sandbox $name did not reach RUNNING within 600s" >&2
      exit 1
    fi
    sleep 5
  done

  ws="/workspace/lobu"  # deterministic: the generated Dockerfile COPYs the tree here
  echo ">> sandbox running; workspace $ws"
  local job_args="" j
  for j in "${jobs[@]}"; do job_args+="$(printf '%q ' "$j")"; done
  local log rc=0 remote_rc
  log="$(mktemp "${TMPDIR:-/tmp}/lobu-pr-full-daytona.XXXXXX")"
  set +e
  daytona exec "$name" --cwd "$ws" --timeout "${DAYTONA_EXEC_TIMEOUT_SECONDS:-7200}" -- \
    bash -lc "cd '$ws' && GATE_PROVISION=1 bash scripts/lib/gate-runner.sh $job_args; echo GATE_REMOTE_EXIT=\$?" \
    2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  set -e
  # -a: the gate log can contain binary (esbuild error dumps); force text
  # mode so the sentinel is still parseable, and ignore non-numeric noise.
  remote_rc="$(grep -a '^GATE_REMOTE_EXIT=' "$log" | tail -1 | cut -d= -f2 || true)"
  rm -f "$log"
  if [[ "$remote_rc" =~ ^[0-9]+$ ]]; then
    echo ">> remote gate exit: $remote_rc"
    rc="$remote_rc"
  elif [ "$rc" -ne 0 ]; then
    echo "daytona exec failed (exit $rc) before the gate produced a result." >&2
  fi
  return "$rc"
}

daytona_sandbox_running() { # name
  local name="$1" state
  # This CLI reports a usable sandbox as "started" (stopped/starting otherwise).
  state="$(daytona list --format json 2>/dev/null | jq -r --arg n "$name" '.items[] | select(.name == $n) | .state' | head -1)"
  [ "$state" = "started" ] || [ "$state" = "running" ]
}

# ── Boat ephemeral VM ─────────────────────────────────────────────────────

run_boat() {
  [[ "$REMOTE_CI_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || {
    echo "REMOTE_CI_TIMEOUT_SECONDS must be a positive integer." >&2
    return 2
  }
  remote_ci_staged_tree >/dev/null || return $?
  # Global: the EXIT trap runs after this function's locals are gone.
  boat_base="$(mktemp -d "${TMPDIR:-/tmp}/lobu-pr-full-boat.XXXXXX")"
  trap 'rm -rf "$boat_base"' EXIT
  local stage="$boat_base/stage" ctx="$boat_base/payload"
  mkdir -p "$stage" "$ctx"
  remote_ci_materialize "$stage"
  # One archive preserves dotfiles and the exact index; ignored local secrets,
  # dependencies and .git never enter the payload sent by `boat run --push`.
  tar -czf "$ctx/repo.tar.gz" -C "$stage" .
  local args=(run --no-env --type "${BOAT_TYPE:-default}"
    --timeout "$REMOTE_CI_TIMEOUT_SECONDS" --push "$ctx")
  if [ -n "${BOAT_SNAPSHOT:-}" ]; then args+=(--from "$BOAT_SNAPSHOT"); fi
  local job_args="" job
  for job in "$@"; do job_args+="$(printf '%q ' "$job")"; done
  echo ">> running $# jobs on Boat: $*"
  # Boat owns VM cleanup on success/failure/cancellation. Its renewable 15m
  # auto-stop erases the VM if the launcher dies. Never pass --keep.
  # No tee/parser: retain the CLI's remote exit code, including timeout (124).
  boat "${args[@]}" -- bash -lc \
    "mkdir -p repo && tar -xzf repo.tar.gz -C repo && cd repo && GATE_PROVISION=1 bash scripts/lib/gate-runner.sh $job_args"
}

# ── dispatch ───────────────────────────────────────────────────────────────

case "$PROVIDER" in
  local) run_local "${jobs[@]}" ;;
  daytona) run_daytona "${jobs[@]}" ;;
  boat) run_boat "${jobs[@]}" ;;
esac
