#!/usr/bin/env bash
#
# App-image smoke: BOOT the lobu-app image that was just pushed and exercise the
# surfaces a user actually touches — HTTP health, the web UI and every asset it
# references, the MCP mount, the in-container `lobu` CLI, and the connector
# runtime.
#
# Why this exists, and why building the image is not enough.
#
# `build-images.yml` builds and pushes app/worker/embeddings, and Flux rolls the
# tag out. Nothing in that path ever RUNS the app image. The whole "image builds
# green, container is broken" class was therefore invisible:
#
#   #2231   no `lobu` on PATH inside the image — the CLI shipped, unreachable
#   #2183   app image serves 404s for assets the built SPA references
#   #430    execute tool dead in prod — isolated-vm (a V8 addon) cannot load
#           under the bun the container then ran on
#
# `connector-parity-smoke` already learned this lesson for the WORKER image (it
# `docker run`s the self-check rather than trusting the build). This is the same
# move for the APP image, which is the one users and the browser talk to.
#
# Runs against the candidate digest after `build-app`. Only a passing smoke
# allows promote-images to publish the deployment tags Flux watches.
#
# Keyless: needs only a Postgres with pgvector. No provider key, no secrets.
#
# Usage: app-image-smoke.sh <image-ref>
# Env:   DATABASE_URL  disposable local lobu_app_smoke DB with pgvector (required)
#        APP_PORT      host port to bind (default 8787)

set -uo pipefail

IMAGE="${1:?usage: app-image-smoke.sh <image-ref>}"
APP_PORT="${APP_PORT:-8787}"
: "${DATABASE_URL:?DATABASE_URL must point at a pgvector-enabled Postgres}"

BASE="http://127.0.0.1:${APP_PORT}"
CID=""
MCP_FIXTURE=$(mktemp) || exit 1
PASS=0
FAIL=0

note() { echo ""; echo "== $* =="; }
ok()   { echo "  ok   — $*"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL — $*"; FAIL=$((FAIL + 1)); }

cleanup() {
  rm -f "$MCP_FIXTURE"
  if [ -n "$CID" ]; then
    echo ""
    echo "---- container logs (tail) ----"
    docker logs --tail 120 "$CID" 2>&1 || true
    docker rm -f "$CID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "================================================================"
echo " app-image smoke"
echo "   image: ${IMAGE}"
echo "================================================================"

# ---------------------------------------------------------------------------
# 1. Boot. --network host so the container reaches the Postgres service on
#    127.0.0.1 and publishes 8787 on the runner without port-mapping games.
# ---------------------------------------------------------------------------
note "boot"
# A real generated key, not LOBU_ALLOW_EPHEMERAL_ENCRYPTION_KEY=1. The escape
# hatch would boot too, but it takes a different startup branch than prod does,
# and the point of this gate is to exercise the path operators actually run.
# Throwaway: the container and its database are destroyed at the end of the job.
CID=$(docker run -d --network host \
  -e "DATABASE_URL=${DATABASE_URL}" \
  -e "JWT_SECRET=app-image-smoke-not-a-real-secret" \
  -e "ENCRYPTION_KEY=$(openssl rand -base64 32)" \
  -e "ALLOW_DB_CREATE=1" \
  -e "PORT=${APP_PORT}" \
  "$IMAGE")
if [ -z "$CID" ]; then
  echo "RESULT: app-image smoke FAILED (docker run could not start the container)"
  exit 1
fi
echo "  container ${CID:0:12}"

# Migrations run at start against a BLANK database — the full ledger from the
# baseline, measured at ~113s on a runner — so the window has to clear that with
# room for a slower runner, not just the steady-state restart case. Poll /health
# rather than sleeping: a fixed sleep either wastes time or flakes.
booted=false
for _ in $(seq 1 150); do
  if curl -fsS --max-time 3 "${BASE}/health" >/dev/null 2>&1; then
    booted=true
    break
  fi
  if [ -z "$(docker ps -q --filter "id=${CID}")" ]; then
    bad "container exited before serving /health"
    break
  fi
  sleep 2
done

if [ "$booted" != true ]; then
  bad "/health never became ready"
  echo ""
  echo "RESULT: app-image smoke FAILED (boot)"
  exit 1
fi
ok "/health responded"

# ---------------------------------------------------------------------------
# 2. The in-container CLI (#2231). It shipped but was not on PATH, so
#    `docker exec <container> lobu ...` — the documented self-host recipe —
#    failed for every self-hoster while every build stayed green.
# ---------------------------------------------------------------------------
note "in-container CLI"
if docker exec "$CID" lobu --version >/dev/null 2>&1; then
  ok "\`lobu --version\` resolves on PATH"
else
  bad "\`lobu\` is not runnable inside the image (#2231 regression)"
fi

# ---------------------------------------------------------------------------
# 3. The web UI, and every asset it references (#2183).
#
#    Fetching `/` alone proves nothing: the SPA shell is served by a catch-all,
#    so it returns 200 even when the built bundle was never copied. The real
#    check is to parse the script/link refs out of the served HTML and demand
#    each one resolve — that is precisely the failure users saw as a blank page.
# ---------------------------------------------------------------------------
note "web UI + referenced assets"
html=$(curl -fsS --max-time 10 "$BASE/" 2>/dev/null)
if [ -z "$html" ]; then
  bad "GET / returned nothing"
else
  ok "GET / served HTML ($(printf '%s' "$html" | wc -c | tr -d ' ') bytes)"

  assets=$(printf '%s' "$html" \
    | grep -oE '(src|href)="[^"]+\.(js|css|mjs)"' \
    | sed -E 's/^(src|href)="//; s/"$//' \
    | sort -u)

  if [ -z "$assets" ]; then
    bad "no js/css assets referenced by / — the SPA bundle is very likely missing"
  else
    n=0
    missing=0
    for a in $assets; do
      url="$a"
      case "$a" in
        http*) ;;
        /*) url="${BASE}${a}" ;;
        *)  url="${BASE}/${a}" ;;
      esac
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url")
      n=$((n + 1))
      if [ "$code" != "200" ]; then
        bad "asset ${a} -> HTTP ${code}"
        missing=$((missing + 1))
      fi
    done
    if [ "$missing" -eq 0 ]; then
      ok "all ${n} referenced assets returned 200"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 4. MCP is mounted. Unauthenticated we expect an auth challenge, NOT a 404 —
#    401 proves the handler is wired; 404 means the route vanished.
# ---------------------------------------------------------------------------
note "MCP mount"
mcp_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  "${BASE}/mcp")
case "$mcp_code" in
  401|403) ok "/mcp challenged an unauthenticated call (HTTP ${mcp_code})" ;;
  404)     bad "/mcp returned 404 — the MCP handler is not mounted" ;;
  000)     bad "/mcp did not respond (connection failed)" ;;
  5*)      bad "/mcp returned HTTP ${mcp_code}" ;;
  *)       bad "/mcp unexpected HTTP ${mcp_code} — expected an auth challenge" ;;
esac

# ---------------------------------------------------------------------------
# 5. Connector runtime, inside the APP image.
#
#    `connector-parity-smoke` runs this on the worker image and the host CLI,
#    but the app image is a third build with its own COPY list — and the bug it
#    guards against (#1035-class: a missing `COPY packages/core` leaving a
#    dangling transitive import) is a per-image packaging mistake. Same check,
#    third surface.
# ---------------------------------------------------------------------------
note "connector runtime (app image)"
if docker exec "$CID" lobu connector runtime-self-check --json >/tmp/app-image-selfcheck.json 2>&1; then
  ok "connector runtime resolves + compiles + executes"
else
  bad "connector runtime self-check failed"
  tail -30 /tmp/app-image-selfcheck.json 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 7. Authenticated MCP, end to end. The unauthenticated probe above only proves
#    the route is mounted; this authenticates as a synthetic bare-account grant
#    in the disposable database and fails promotion on a discovery, dispatch,
#    audit, or widget regression. The wire smoke hands its real rejection and
#    real served shell to the browser smoke through $MCP_FIXTURE.
# ---------------------------------------------------------------------------
note "authenticated MCP and rendered app"
if node scripts/mcp-image-smoke.mjs "$BASE" "$MCP_FIXTURE"; then
  ok "authenticated MCP discovery, dispatch, audit, and resources"
  if node scripts/mcp-app-smoke.mjs "$BASE" "$MCP_FIXTURE"; then
    ok "rendered MCP errors, deadlines, cancellation, and late recovery"
  else
    bad "rendered MCP App smoke failed"
  fi
else
  bad "authenticated MCP smoke failed"
fi

echo ""
echo "  smoke summary: ${PASS} passed, ${FAIL} failed"
if [ "$FAIL" -ne 0 ]; then
  echo "RESULT: app-image smoke FAILED"
  exit 1
fi
echo "RESULT: app-image smoke PASSED"
