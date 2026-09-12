#!/usr/bin/env bash
# Build/install Owletto (Developer ID) and probe prod computer_use.
# Usage: ORG=example-org CONN_ID=123 scripts/owletto-mac-e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTEXT="${CONTEXT:-lobu}"
: "${ORG:?Set ORG to the organization slug to test}"
: "${CONN_ID:?Set CONN_ID to the Owletto connection ID to test}"
# CONN_ID is interpolated into the `lobu memory exec` script body below, so it
# must be a bare integer literal rather than arbitrary text.
[[ "$CONN_ID" =~ ^[0-9]+$ ]] || { echo "error: CONN_ID must be numeric (got '$CONN_ID')" >&2; exit 1; }

cd "$ROOT"
git -c submodule.recurse=false pull --ff-only origin main
"$ROOT/scripts/sync-owletto-submodule.sh"

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "== build + install =="
  INSTALL=1 OPEN=1 "$ROOT/scripts/build-owletto-mac.sh"
else
  echo "== SKIP_BUILD=1 — using existing /Applications/Lobu.app =="
fi

echo "== codesign =="
codesign -dv --verbose=4 /Applications/Lobu.app 2>&1 | grep -E "Authority|Identifier|TeamIdentifier" || true

echo "== waiting for Lobu to pair/poll (${POLL_WAIT_SECS:-45}s) =="
echo "   (menubar Lobu should show connected to prod before probes run)"
sleep "${POLL_WAIT_SECS:-45}"

probe() {
  local op="$1"
  local attempt max_attempts="${PROBE_RETRIES:-3}"
  echo "== $op =="
  for attempt in $(seq 1 "$max_attempts"); do
    if [ "$attempt" -gt 1 ]; then
      echo "   retry $attempt/$max_attempts (server or device may still be waking)..."
      sleep 10
    fi
    if lobu memory exec "export default async (_ctx, client) => {
      return await client.operations.execute({
        connection_id: ${CONN_ID}, operation_key: \"${op}\", input: {},
      });
    }" -c "$CONTEXT" --org "$ORG" 2>&1 | tee /tmp/owletto-e2e-"$op".log | grep -q '"success": true'; then
      cat /tmp/owletto-e2e-"$op".log
      return 0
    fi
    cat /tmp/owletto-e2e-"$op".log
    if ! grep -qE 'CONNECTION_ENDED|CONNECTION_CLOSED|CONNECTION_DESTROYED|device worker did not complete' /tmp/owletto-e2e-"$op".log; then
      return 1
    fi
  done
  echo "error: $op failed after $max_attempts attempts" >&2
  echo "  • Confirm Lobu menubar is connected (prod gateway, signed in)" >&2
  echo "  • Connection ${CONN_ID} should be bound to this Mac device" >&2
  return 1
}

probe permissions
probe list_windows

echo "== done =="
