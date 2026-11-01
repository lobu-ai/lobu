#!/usr/bin/env bash
set -euo pipefail

# With the worker Deployment running, the app must not claim runs itself. The
# worker drains in-flight runs for its grace period on SIGTERM, but the app's
# in-process worker drains for a fixed 15s, so any agent turn or sync it holds
# during a rollout is killed. Without worker pods, the app's worker is the only
# one, so it stays on.

chart_dir="${1:-charts/lobu}"
render_app() {
  helm template topology-test "$chart_dir" --show-only templates/deployment.yaml "$@"
}
expect_absent() {
  local label="$1"
  shift
  if grep -q 'name: LOBU_DISABLE_EMBEDDED_WORKER' <<<"$(render_app "$@")"; then
    echo "expected no LOBU_DISABLE_EMBEDDED_WORKER: $label" >&2
    exit 1
  fi
}

grep -A1 'name: LOBU_DISABLE_EMBEDDED_WORKER' <<<"$(render_app)" | grep -q 'value: "1"'
expect_absent "worker disabled" --set worker.enabled=false
expect_absent "no worker replicas" --set worker.replicaCount=0

# An explicit app.env value wins and is rendered once.
override_render="$(render_app --set-string app.env.LOBU_DISABLE_EMBEDDED_WORKER=0)"
[ "$(grep -c 'name: LOBU_DISABLE_EMBEDDED_WORKER' <<<"$override_render")" = 1 ]
grep -A1 'name: LOBU_DISABLE_EMBEDDED_WORKER' <<<"$override_render" | grep -q 'value: "0"'
