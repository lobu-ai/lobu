#!/bin/sh
set -eu

kubectl_bin=${KUBECTL_BIN:-/migration-tools/kubectl}
namespace=${NAMESPACE:?NAMESPACE is required}
app_deployment=${APP_DEPLOYMENT:?APP_DEPLOYMENT is required}
app_selector=${APP_SELECTOR:?APP_SELECTOR is required}
worker_deployment=${WORKER_DEPLOYMENT:-}
worker_selector=${WORKER_SELECTOR:-}
timeout=${QUIESCE_TIMEOUT:-300s}
pending_check=${MIGRATION_PENDING_CHECK:-}
quiescence_started=0
app_replicas=absent
worker_replicas=absent

deployment_replicas() {
  deployment=$1
  replicas=$("$kubectl_bin" --namespace "$namespace" get deployment "$deployment" \
    --ignore-not-found --output 'jsonpath={.spec.replicas}')
  if [ -z "$replicas" ]; then
    printf 'absent'
    return
  fi
  printf '%s' "$replicas"
}

restore_deployment() {
  deployment=$1
  replicas=$2
  if [ "$replicas" = absent ]; then
    return
  fi
  echo "restoring deployment $deployment to $replicas replicas"
  "$kubectl_bin" --namespace "$namespace" scale deployment "$deployment" \
    --replicas="$replicas"
}

wait_for_restored_deployment() {
  deployment=$1
  replicas=$2
  if [ "$replicas" = absent ] || [ "$replicas" -eq 0 ]; then
    return
  fi
  "$kubectl_bin" --namespace "$namespace" rollout status deployment "$deployment" \
    --timeout "$timeout"
}

restore_on_failure() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ] && [ "$quiescence_started" -eq 1 ]; then
    echo "migration failed with status $status; restoring old deployments" >&2
    restore_failed=0
    restore_deployment "$app_deployment" "$app_replicas" || restore_failed=1
    if [ -n "$worker_deployment" ]; then
      restore_deployment "$worker_deployment" "$worker_replicas" || restore_failed=1
    fi
    # Start both services before waiting: either may depend on the other.
    wait_for_restored_deployment "$app_deployment" "$app_replicas" || restore_failed=1
    if [ -n "$worker_deployment" ]; then
      wait_for_restored_deployment "$worker_deployment" "$worker_replicas" || restore_failed=1
    fi
    if [ "$restore_failed" -ne 0 ]; then
      echo "ERROR: migration failed and one or more deployments could not be restored to readiness" >&2
    else
      echo "old deployments restored to readiness"
    fi
  fi
  exit "$status"
}

# Quiescing scales the app to zero for the length of a pod restart, which the
# ingress answers with 503. Only a schema change the old code cannot run
# against needs that window, and most deploys ship none, so ask the ledger
# first, including its read-only prerequisite checks. Only a successful check
# permits deployment. An unknown answer aborts before touching old replicas.
migrations_pending() {
  if [ -z "$pending_check" ]; then
    echo 'ERROR: no pending-migration check configured; aborting before quiesce' >&2
    exit 1
  fi
  set +e
  # Word splitting is intended: the check is configured as a full command line.
  $pending_check
  pending_status=$?
  set -e
  # 3 is CHECK_PENDING_NONE_EXIT and 4 is CHECK_PENDING_COMPATIBLE_EXIT in
  # scripts/migrate-up.mjs -- the two statuses that mean "the ledger was read
  # and no old replica needs to stop".
  if [ "$pending_status" -eq 3 ] || [ "$pending_status" -eq 4 ]; then
    return 1
  fi
  if [ "$pending_status" -ne 0 ]; then
    echo "ERROR: pending-migration check failed with status $pending_status; aborting before quiesce" >&2
    exit "$pending_status"
  fi
  return 0
}

quiesce_deployment() {
  deployment=$1
  selector=$2
  replicas=$3
  if [ "$replicas" = absent ]; then
    echo "deployment $deployment is absent; nothing to quiesce"
    return
  fi
  "$kubectl_bin" --namespace "$namespace" scale deployment "$deployment" --replicas=0
  pods=$("$kubectl_bin" --namespace "$namespace" get pods \
    --selector "$selector" --output name)
  if [ -n "$pods" ]; then
    "$kubectl_bin" --namespace "$namespace" wait --for=delete pod \
      --selector "$selector" --timeout "$timeout"
  fi
}

if [ "$#" -eq 0 ]; then
  echo 'migration command is required' >&2
  exit 2
fi

trap restore_on_failure EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if migrations_pending; then
  app_replicas=$(deployment_replicas "$app_deployment")
  if [ -n "$worker_deployment" ]; then
    worker_replicas=$(deployment_replicas "$worker_deployment")
  fi

  quiescence_started=1
  quiesce_deployment "$app_deployment" "$app_selector" "$app_replicas"
  if [ -n "$worker_deployment" ]; then
    quiesce_deployment "$worker_deployment" "$worker_selector" "$worker_replicas"
  fi
  echo 'all old database clients are quiesced; running migration'
else
  echo 'no migration requires stopping the old replicas; skipping quiesce so Helm can roll without downtime'
fi

"$@"
echo 'migration completed; Helm may apply the new deployments'
