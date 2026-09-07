#!/bin/sh
# Opt-in: dummy deployments only; requires namespace creation and SA impersonation.
set -eu
: "${KUBE_CONTEXT:?Set KUBE_CONTEXT to the cluster for this disposable test}"
chart_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
test_dir=$(mktemp -d)
namespace="lobu-recovery-test-$(date +%s)-$$"
release=lobu-recovery-test
export KUBE_CONTEXT
export TEST_SERVICE_ACCOUNT="system:serviceaccount:$namespace:$release-migration-quiesce"
kube() { kubectl --context "$KUBE_CONTEXT" --namespace "$namespace" "$@"; }
cleanup() {
  kube delete namespace "$namespace" --ignore-not-found --timeout=120s
  rm -rf "$test_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
kube create namespace "$namespace"
helm template "$release" "$chart_dir" --namespace "$namespace" --is-upgrade \
  --set migrations.enabled=true --show-only templates/migration-upgrade-rbac.yaml \
  >"$test_dir/rbac.yaml"
kube apply -f "$test_dir/rbac.yaml"

for component in app worker; do
  cat <<YAML >"$test_dir/$component.yaml"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $release-$component
spec:
  replicas: 1
  selector:
    matchLabels:
      recovery-test: $component
  template:
    metadata:
      labels:
        recovery-test: $component
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 1
      containers:
        - name: http
          image: busybox:1.37.0
          command: [sh, -c, "sleep 5; exec httpd -f -p 8080 -h /tmp"]
          resources:
            requests: {cpu: 10m, memory: 8Mi}
            limits: {cpu: 100m, memory: 32Mi}
          readinessProbe:
            tcpSocket: {port: 8080}
            periodSeconds: 1
YAML
  kube apply -f "$test_dir/$component.yaml"
done
kube wait --for=condition=Available deployment --all --timeout=120s

cat >"$test_dir/kubectl" <<'KUBECTL'
#!/bin/sh
exec kubectl --context "$KUBE_CONTEXT" --as "$TEST_SERVICE_ACCOUNT" "$@"
KUBECTL
chmod +x "$test_dir/kubectl"
recovery_status=0
KUBECTL_BIN="$test_dir/kubectl" NAMESPACE="$namespace" \
APP_DEPLOYMENT="$release-app" APP_SELECTOR=recovery-test=app \
WORKER_DEPLOYMENT="$release-worker" WORKER_SELECTOR=recovery-test=worker \
QUIESCE_TIMEOUT=60s MIGRATION_PENDING_CHECK=true \
  sh "$chart_dir/files/migrate-upgrade.sh" sh -c 'exit 42' \
  >"$test_dir/recovery.log" 2>&1 || recovery_status=$?
cat "$test_dir/recovery.log"
test "$recovery_status" -eq 42
grep -Fxq 'old deployments restored to readiness' "$test_dir/recovery.log"
for component in app worker; do
  state=$(kube get deployment "$release-$component" \
    -o 'jsonpath={.spec.replicas}/{.status.readyReplicas}/{.status.availableReplicas}')
  test "$state" = 1/1/1
done
echo 'live migration failure recovered both deployments with chart-scoped RBAC'
