#!/usr/bin/env bash
#
# Prod smoke: verify the DEPLOYED system, not an artifact.
#
# The other two gates each answer a question this one cannot:
#
#   app-image-smoke        is the image broken?      (boots with its OWN env + db)
#   published-artifact-…   can users install it?     (npm tarball, 4 environments)
#   THIS                   did the rollout land, and does prod work with the
#                          REAL Helm config, ingress, TLS, and database?
#
# Nothing here overlaps. An image smoke can never catch a missing Helm env var,
# a broken ingress route, an expired certificate, or Flux rolling a tag whose
# migration failed against real data — it boots with its own environment. Equally
# this can never gate a release: by the time it is red, users are already broken.
# It is a detector and an alarm, not a gate.
#
# READ-ONLY BY CONSTRUCTION. `events` is append-only, so a smoke that writes
# cannot clean up after itself. Every request below is a GET or an
# unauthenticated POST that is expected to be REJECTED. Nothing is created.
#
# Usage: prod-smoke.sh [base-url]
# Env:
#   PROD_URL       base URL (default https://app.lobu.ai)
#   EXPECT_SHA     if set, require this commit to be an ancestor of the
#                  deployed revision — i.e. "the rollout actually landed"
#   ROLLOUT_WAIT   total seconds to wait for the rollout to land, SHARED by the
#                  liveness probe (the app sits at zero replicas while migrations
#                  run) and the EXPECT_SHA gate (default 0 = no wait, one attempt)

set -uo pipefail

BASE="${1:-${PROD_URL:-https://app.lobu.ai}}"
BASE="${BASE%/}"
EXPECT_SHA="${EXPECT_SHA:-}"
ROLLOUT_WAIT="${ROLLOUT_WAIT:-0}"
# ROLLOUT_WAIT feeds `[ ... -ge ... ]` in the rollout loop; a non-integer would
# make that test error forever and spin until the job timeout instead of failing.
case "$ROLLOUT_WAIT" in
  *[!0-9]*)
    echo "ROLLOUT_WAIT must be a non-negative integer (seconds), got: ${ROLLOUT_WAIT}" >&2
    exit 1
    ;;
esac

PASS=0
FAIL=0
note() { echo ""; echo "== $* =="; }
ok()   { echo "  ok   — $*"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL — $*"; FAIL=$((FAIL + 1)); }

echo "================================================================"
echo " prod smoke — ${BASE}"
echo "================================================================"

# ---------------------------------------------------------------------------
# 1. Liveness + the deployed revision.
#
#    /health returns {status, version, revision, build_time, environment};
#    `revision` is APP_GIT_SHA baked into the image at build time.
# ---------------------------------------------------------------------------
# One wait budget for the whole rollout, spent here first and continued by the
# EXPECT_SHA gate below. Liveness and revision are the same wait: a deploy that
# is still quiescing has not landed, so each must not spend ROLLOUT_WAIT in full.
waited=0

note "health"
# Retried, because a `workflow_run` smoke fires while the rollout it verifies is
# still in progress: migrations scale the app to zero, so /health returns
# nothing for the gap between the old pod terminating and the new one serving.
# A single attempt failed the entire gate before the caller's wait budget was
# ever consulted — run 1539 asked for ROLLOUT_WAIT=1200, gave up 0.7s in at
# 04:12:31, and the replacement pod was ready at 04:13:04.
# ROLLOUT_WAIT=0 (the default) keeps the previous single-attempt path exactly.
health=""
while :; do
  health=$(curl -fsS --max-time 15 "${BASE}/health" 2>/dev/null)
  [ -n "$health" ] && break
  [ "$waited" -ge "$ROLLOUT_WAIT" ] && break
  sleep 30
  waited=$((waited + 30))
done
if [ -z "$health" ]; then
  bad "GET /health returned nothing after ${waited}s — prod is down or unreachable"
  echo ""
  echo "RESULT: prod smoke FAILED (unreachable)"
  exit 1
fi

status=$(printf '%s' "$health" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
revision=$(printf '%s' "$health" | sed -n 's/.*"revision":"\([^"]*\)".*/\1/p')
environment=$(printf '%s' "$health" | sed -n 's/.*"environment":"\([^"]*\)".*/\1/p')
version=$(printf '%s' "$health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')

if [ "$status" = "ok" ]; then
  ok "/health status=ok"
else
  bad "/health status='${status}'"
fi
echo "       version=${version} revision=${revision} environment=${environment}"

if [ "$revision" = "unknown" ] || [ -z "$revision" ]; then
  bad "deployed revision is unknown — APP_GIT_SHA was not baked into the image"
fi

# ---------------------------------------------------------------------------
# 2. Readiness. Distinct from liveness on purpose: /health is dependency-free
#    (a DB blip must not CrashLoop the pod), /health/ready proves the pod can
#    actually reach the database. Only the latter says "serving traffic".
# ---------------------------------------------------------------------------
note "readiness"
ready_code=$(curl -s -o /tmp/prod-smoke-ready.json -w '%{http_code}' --max-time 15 "${BASE}/health/ready")
if [ "$ready_code" = "200" ]; then
  ok "/health/ready 200 — pod can reach the database"
else
  bad "/health/ready ${ready_code} — $(head -c 200 /tmp/prod-smoke-ready.json 2>/dev/null)"
fi

# ---------------------------------------------------------------------------
# 3. Rollout gate (opt-in).
#
#    Ancestor test, NOT equality: prod may be several commits ahead. Argument
#    order matters — EXPECT_SHA first, deployed second. Reversed, it accepts a
#    stale deploy. And EXPECT_SHA must be the SQUASH commit: a squash merge
#    writes a new commit with no ancestry link to the branch head, so gating on
#    the branch head exits 1 forever (PR #2280 has identical trees and still
#    fails).
# ---------------------------------------------------------------------------
if [ -n "$EXPECT_SHA" ]; then
  note "rollout"
  # Continues the budget the liveness probe may already have spent.
  landed=false
  while :; do
    cur=$(curl -fsS --max-time 15 "${BASE}/health" 2>/dev/null \
      | sed -n 's/.*"revision":"\([^"]*\)".*/\1/p')
    if [ -n "$cur" ] && git merge-base --is-ancestor "$EXPECT_SHA" "$cur" 2>/dev/null; then
      landed=true
      break
    fi
    [ "$waited" -ge "$ROLLOUT_WAIT" ] && break
    sleep 30
    waited=$((waited + 30))
  done

  if [ "$landed" = true ]; then
    ok "${EXPECT_SHA:0:12} is live (deployed ${cur:0:12})"
  else
    bad "${EXPECT_SHA:0:12} is NOT in the deployed revision ${cur:0:12} after ${waited}s"
  fi
fi

# ---------------------------------------------------------------------------
# 4. The web UI and every asset it references.
#
#    The SPA shell is served by a catch-all, so `/` returns 200 even when the
#    built bundle never made it into the image. Parsing the refs out of the
#    served HTML and demanding each resolve is what actually catches the blank
#    page users saw in #2183 — here against the real ingress and CDN path.
# ---------------------------------------------------------------------------
note "web UI + referenced assets"
html=$(curl -fsS --max-time 20 "${BASE}/" 2>/dev/null)
if [ -z "$html" ]; then
  bad "GET / returned nothing"
else
  ok "GET / served HTML ($(printf '%s' "$html" | wc -c | tr -d ' ') bytes)"
  assets=$(printf '%s' "$html" \
    | grep -oE '(src|href)="[^"]+\.(js|css|mjs)"' \
    | sed -E 's/^(src|href)="//; s/"$//' \
    | sort -u)
  if [ -z "$assets" ]; then
    bad "no js/css assets referenced by / — SPA bundle likely missing"
  else
    n=0; missing=0
    for a in $assets; do
      case "$a" in
        http*) url="$a" ;;
        /*)    url="${BASE}${a}" ;;
        *)     url="${BASE}/${a}" ;;
      esac
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url")
      n=$((n + 1))
      [ "$code" != "200" ] && { bad "asset ${a} -> HTTP ${code}"; missing=$((missing + 1)); }
    done
    [ "$missing" -eq 0 ] && ok "all ${n} referenced assets returned 200"
  fi
fi

# ---------------------------------------------------------------------------
# 5. MCP is mounted and CHALLENGES. 401/403 is the pass: it proves the handler
#    is wired AND that it refuses anonymous callers. A 200 here would mean prod
#    is serving MCP unauthenticated, which is worse than a 404.
# ---------------------------------------------------------------------------
note "MCP mount"
mcp_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  "${BASE}/mcp")
case "$mcp_code" in
  401|403) ok "/mcp challenged an anonymous call (HTTP ${mcp_code})" ;;
  404)     bad "/mcp returned 404 — MCP handler is not mounted" ;;
  200)     bad "/mcp answered an ANONYMOUS initialize with 200 — auth is not enforced" ;;
  *)       bad "/mcp unexpected HTTP ${mcp_code}" ;;
esac

# ---------------------------------------------------------------------------
# 6. OAuth discovery. MCP clients (ChatGPT, Claude Desktop, Cursor) bootstrap
#    from this document; if it stops resolving, every browser-managed client
#    silently fails to connect while /mcp itself still looks healthy.
# ---------------------------------------------------------------------------
note "OAuth discovery"
oauth_code=$(curl -s -o /tmp/prod-smoke-oauth.json -w '%{http_code}' --max-time 20 \
  "${BASE}/.well-known/oauth-authorization-server")
if [ "$oauth_code" = "200" ] && grep -q "issuer" /tmp/prod-smoke-oauth.json 2>/dev/null; then
  ok "/.well-known/oauth-authorization-server serves an issuer"
else
  bad "/.well-known/oauth-authorization-server -> HTTP ${oauth_code}"
fi

# ---------------------------------------------------------------------------
# 7. TLS expiry. A certificate is the one dependency that breaks with no deploy
#    and no code change, and it takes the whole surface down at once.
# ---------------------------------------------------------------------------
note "TLS"
host="${BASE#https://}"; host="${host%%/*}"
end=$(echo | openssl s_client -servername "$host" -connect "${host}:443" 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -z "$end" ]; then
  bad "could not read the TLS certificate for ${host}"
else
  end_s=$(date -d "$end" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$end" +%s 2>/dev/null)
  if [ -z "$end_s" ]; then
    ok "certificate expires ${end} (could not parse for comparison)"
  else
    days=$(( (end_s - $(date +%s)) / 86400 ))
    if [ "$days" -lt 10 ]; then
      bad "TLS certificate expires in ${days} days (${end})"
    else
      ok "TLS certificate valid for ${days} more days"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 8. The delivered MCP widget, rendered against a synthetic host. Only its
#    public shell and assets are fetched; every tool notification stays inside
#    the local browser, so nothing is written to prod.
# ---------------------------------------------------------------------------
note "rendered MCP App"
if node "$(dirname "$0")/mcp-app-smoke.mjs" "$BASE"; then
  ok "MCP App failures are visible and late results recover without replay"
else
  bad "MCP App browser smoke failed"
fi

echo ""
echo "  prod smoke: ${PASS} passed, ${FAIL} failed"
if [ "$FAIL" -ne 0 ]; then
  echo "RESULT: prod smoke FAILED"
  exit 1
fi
echo "RESULT: prod smoke PASSED"
