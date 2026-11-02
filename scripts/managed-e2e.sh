#!/usr/bin/env bash
#
# Managed-connector end-to-end gate ("cloud auth, local data").
#
# Proves the WHOLE managed-connector runtime path across TWO real `lobu run`
# instances on separate embedded-Postgres clusters + separate config dirs:
#
#   CLOUD (:8901, pg :59101): a PUBLIC org holding the OAuth grant. Seeded (via
#     SQL into its embedded PG) with a public org, a member user, a connector
#     definition with an `oauth` method, a managed `oauth_app` profile, an
#     `oauth_account` grant (an `account` row with a NON-expiring access token),
#     a CONSENT-ONLY connection owned by the member, and a PAT carrying
#     `mcp:read mcp:write connections:token`. Its /oauth/connection-token returns
#     ONLY a short-lived access token.
#
#   LOCAL (:8902, pg :59102): a `lobu apply`'d project whose connection is
#     `defineConnection({ managedBy: { org: <cloud-public-org> }, feeds })`. It
#     holds NO local grant. Pointed at the cloud via LOBU_CLOUD_URL +
#     LOBU_CLOUD_PAT (the env fallback in resolveCloudCredential).
#
# When the LOCAL feed syncs, resolveExecutionAuth detects `managedBy`, fetches a
# fresh token from the CLOUD over real HTTP, and runs the connector LOCALLY. The
# connector calls a mock DATA API with that bearer — the API 401s without the
# exact token, so a green sync that wrote an event proves the managed token was
# fetched AND used.
#
# Assertions (all must pass → exit 0):
#   1. CLOUD run log shows POST /oauth/connection-token → 200.
#   2. >=1 connector event landed in the LOCAL Postgres.
#   3. ZERO connector events for that connector landed in the CLOUD Postgres.
#   4. (bonus) the mock data API logged a request carrying the EXACT managed
#      bearer — the token wasn't just fetched, it was used upstream.
#
# Usage: scripts/managed-e2e.sh
set -euo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_HARNESS="$WT/scripts/sdk-e2e"
HARNESS="$WT/scripts/managed-e2e"
LOBU="node $WT/packages/cli/bin/lobu.js"
# shellcheck source=scripts/lib/process-cleanup.sh
. "$WT/scripts/lib/process-cleanup.sh"

CLOUD_PORT="${CLOUD_PORT:-8901}"
LOCAL_PORT="${LOCAL_PORT:-8902}"
CLOUD_PG_PORT="${CLOUD_PG_PORT:-59101}"
LOCAL_PG_PORT="${LOCAL_PG_PORT:-59102}"
MOCK_PORT="${MOCK_PORT:-11534}"      # mock LLM provider (distinct from sdk-e2e's)
MOCK_DATA_PORT="${MOCK_DATA_PORT:-8911}"  # mock external data API
MOCK_REPLY="MANAGED_E2E_OK"

CONNECTOR_KEY="managede2e-pulse"
MANAGED_ACCESS_TOKEN="managed-access-token-xyz"
CLOUD_ORG_SLUG="managed-cloud-pub"

RUN_DIR="$WT/.managed-e2e-run"
CLOUD_DATA="$RUN_DIR/cloud-data"
LOCAL_DATA="$RUN_DIR/local-data"
CLOUD_CFG="$RUN_DIR/cloud-config"
LOCAL_CFG="$RUN_DIR/local-config"
CLOUD_LOG="$RUN_DIR/cloud-run.log"
LOCAL_LOG="$RUN_DIR/local-run.log"
MOCK_LOG="$RUN_DIR/mock.log"
DATA_LOG="$RUN_DIR/mock-data.log"

CLOUD_DB="postgresql://postgres:postgres@127.0.0.1:$CLOUD_PG_PORT/postgres?sslmode=disable"
LOCAL_DB="postgresql://postgres:postgres@127.0.0.1:$LOCAL_PG_PORT/postgres?sslmode=disable"

# Keep supported Node 22-24 and 26+ on their matching native addon.
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ -x /opt/homebrew/opt/node@22/bin/node ] && { [ "$NODE_MAJOR" -lt 22 ] || [ "$NODE_MAJOR" -eq 25 ]; }; then
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi

MOCK_PID=""; DATA_PID=""; CLOUD_PID=""; LOCAL_PID=""

kill_pg_orphans() {
  pkill -9 -f "embedded-postgres/darwin-arm64/native/bin/postgres" 2>/dev/null || true
  pkill -9 -f "embedded-postgres/.*/native/bin/postgres" 2>/dev/null || true
}
cleanup() {
  [ -n "$LOCAL_PID" ] && kill -9 "$LOCAL_PID" 2>/dev/null || true
  [ -n "$CLOUD_PID" ] && kill -9 "$CLOUD_PID" 2>/dev/null || true
  [ -n "$MOCK_PID" ] && kill -9 "$MOCK_PID" 2>/dev/null || true
  [ -n "$DATA_PID" ] && kill -9 "$DATA_PID" 2>/dev/null || true
  for p in "$CLOUD_PORT" "$LOCAL_PORT" "$MOCK_PORT" "$MOCK_DATA_PORT" "$CLOUD_PG_PORT" "$LOCAL_PG_PORT"; do lobu_kill_listening_port "$p"; done
  kill_pg_orphans
}
trap cleanup EXIT

fail() {
  echo "❌ managed-connector e2e FAILED: $*" >&2
  for f in "$CLOUD_LOG" "$LOCAL_LOG"; do
    [ -f "$f" ] && { echo "--- last 40 lines of $(basename "$f") ---" >&2; tail -40 "$f" >&2; }
  done
  exit 1
}

# psql helper bound to a given DB URL. Args: <db_url> <sql>
psql_db() { psql "$1" -v ON_ERROR_STOP=1 -tA -c "$2"; }

echo "▶ node $(node --version) | cloud :$CLOUD_PORT (pg :$CLOUD_PG_PORT) | local :$LOCAL_PORT (pg :$LOCAL_PG_PORT)"
command -v psql >/dev/null || fail "psql not found (needed to seed/inspect the embedded clusters)"

rm -rf "$RUN_DIR"; mkdir -p "$CLOUD_DATA" "$LOCAL_DATA" "$CLOUD_CFG" "$LOCAL_CFG"
cleanup  # free ports / kill orphans from a prior run

# 0) Embedded-PG ICU prep (no-op on macOS; needed on Linux/CI).
node "$SDK_HARNESS/fix-embedded-pg-icu.mjs" || fail "could not prepare embedded-postgres ICU symlinks"

# 1) Mock LLM provider (both instances auto-apply a project that declares an
#    agent; lobu run pushes the provider key at apply time).
MOCK_PORT="$MOCK_PORT" MOCK_REPLY="$MOCK_REPLY" node "$SDK_HARNESS/mock-openai.mjs" > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!; disown "$MOCK_PID" 2>/dev/null || true
for _ in $(seq 1 20); do
  curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 || fail "mock LLM provider did not come up"
echo "✓ mock LLM provider up (:$MOCK_PORT)"

# 2) Mock external DATA API (401 without the exact managed bearer).
EXPECTED_TOKEN="$MANAGED_ACCESS_TOKEN" MOCK_DATA_PORT="$MOCK_DATA_PORT" node "$HARNESS/mock-data-api.mjs" > "$DATA_LOG" 2>&1 &
DATA_PID=$!; disown "$DATA_PID" 2>/dev/null || true
for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$MOCK_DATA_PORT/items" >/dev/null 2>&1 && break  # 401 is still a response
  curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$MOCK_DATA_PORT/items" 2>/dev/null | grep -qE '401|200' && break
  sleep 0.5
done
curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$MOCK_DATA_PORT/items" 2>/dev/null | grep -qE '401|200' || fail "mock data API did not come up"
echo "✓ mock data API up (:$MOCK_DATA_PORT, 401 without bearer)"

export LOBU_PROVIDER_REGISTRY_PATH="$SDK_HARNESS/providers.json"
export LOBU_ALLOW_EPHEMERAL_ENCRYPTION_KEY=1

# Stable, VALID 32-byte encryption keys per instance (base64 of 32 random bytes;
# the install-operator provisioner rejects anything that isn't a canonical
# 32-byte base64/hex key). Stable across restarts within one run.
CLOUD_ENC_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')"
LOCAL_ENC_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')"

# ─── CLOUD instance ────────────────────────────────────────────────────────
# A minimal project: one agent (so apply has something to do + a provider). The
# managed org/grant/connection are seeded directly via SQL after boot.
CLOUD_PROJ="$RUN_DIR/cloud-proj"; mkdir -p "$CLOUD_PROJ"
( cd "$CLOUD_PROJ" && $LOBU init . -y --here --provider gemini >/dev/null 2>&1 )
rm -f "$CLOUD_PROJ/package.json"
cat > "$CLOUD_PROJ/lobu.config.ts" <<'TS'
import { defineAgent, defineConfig, secret } from "@lobu/cli/config";
const agent = defineAgent({
  id: "echo", name: "Echo", dir: "./agents/echo",
  providers: [{ id: "mock", model: "mock-model", key: secret("MOCK_API_KEY") }],
});
export default defineConfig({ agents: [agent] });
TS
{
  printf '\n'
  echo "MOCK_API_KEY=mock-key-e2e"
  echo "DATABASE_URL=file://$CLOUD_DATA"
} >> "$CLOUD_PROJ/.env"

echo "▶ booting CLOUD instance…"
( cd "$CLOUD_PROJ" \
    && LOBU_CONFIG_DIR="$CLOUD_CFG" LOBU_DATA_DIR="$CLOUD_DATA" DATABASE_URL="file://$CLOUD_DATA" \
       LOBU_PG_PORT="$CLOUD_PG_PORT" ENCRYPTION_KEY="$CLOUD_ENC_KEY" \
       $LOBU run --port "$CLOUD_PORT" > "$CLOUD_LOG" 2>&1 ) &
CLOUD_PID=$!
for _ in $(seq 1 90); do
  grep -qiE "Apply complete|auto-apply skipped|Apply halted" "$CLOUD_LOG" 2>/dev/null && break
  sleep 1
done
grep -qi "Apply complete" "$CLOUD_LOG" || fail "CLOUD auto-apply did not complete"
echo "✓ CLOUD instance booted + applied"

# Wait until the cloud embedded PG accepts connections on the pinned port.
for _ in $(seq 1 60); do psql_db "$CLOUD_DB" "SELECT 1" >/dev/null 2>&1 && break; sleep 1; done
psql_db "$CLOUD_DB" "SELECT 1" >/dev/null 2>&1 || fail "could not connect to CLOUD embedded PG on :$CLOUD_PG_PORT"
echo "✓ CLOUD embedded PG reachable on :$CLOUD_PG_PORT"

# ─── Seed the CLOUD managed grant via SQL ───────────────────────────────────
# Mirror packages/server/src/__tests__/integration/connectors/connection-token.test.ts
# seedManagedConnection(), but with a NON-expiring access token so no refresh is
# needed (the connector receives MANAGED_ACCESS_TOKEN verbatim → the data API
# accepts it). The PAT hash is sha256(token) (auth/oauth/utils.hashToken).
CLOUD_OWNER_ID="user_managed_e2e_owner"
CLOUD_ORG_ID="org_managed_e2e_pub"
PAT="owl_pat_managed_e2e_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
PAT_HASH="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$PAT")"
ACCOUNT_ID="acct_managed_e2e"
NONEXPIRY="$(node -e 'process.stdout.write(new Date(Date.now()+365*86400000).toISOString())')"

# A heredoc'd SQL transaction. Identifiers/values are static (no user input), so
# inlining is safe here.
psql "$CLOUD_DB" -v ON_ERROR_STOP=1 <<SQL || fail "CLOUD seed SQL failed"
BEGIN;
INSERT INTO "organization" (id, name, slug, visibility, "createdAt")
  VALUES ('$CLOUD_ORG_ID', 'Managed Cloud Public', '$CLOUD_ORG_SLUG', 'public', NOW())
  ON CONFLICT (id) DO UPDATE SET visibility = 'public', slug = '$CLOUD_ORG_SLUG';

INSERT INTO "user" (id, email, name, username, "emailVerified", "createdAt", "updatedAt")
  VALUES ('$CLOUD_OWNER_ID', 'managed-owner@test.example.com', 'Managed Owner', 'managed-owner', true, NOW(), NOW())
  ON CONFLICT (id) DO NOTHING;

INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
  VALUES ('member_managed_e2e', '$CLOUD_OWNER_ID', '$CLOUD_ORG_ID', 'member', NOW())
  ON CONFLICT (id) DO NOTHING;

INSERT INTO connector_definitions (key, name, version, feeds_schema, auth_schema, organization_id, status, created_at, updated_at)
  VALUES (
    '$CONNECTOR_KEY', 'Managed e2e pulse', '1.0.0',
    '{"pulse":{"key":"pulse","name":"Pulse"}}'::jsonb,
    '{"methods":[{"type":"oauth","provider":"demo","requiredScopes":["read"],"tokenUrl":"https://demo.invalid/token","clientIdKey":"DEMO_CLIENT_ID","clientSecretKey":"DEMO_CLIENT_SECRET","tokenEndpointAuthMethod":"client_secret_post"}]}'::jsonb,
    '$CLOUD_ORG_ID', 'active', NOW(), NOW()
  ) ON CONFLICT DO NOTHING;

-- Managed oauth_app profile (the real client secret — never leaves the cloud).
INSERT INTO auth_profiles (organization_id, connector_key, slug, display_name, profile_kind, provider, auth_data, status, created_at, updated_at)
  VALUES (
    '$CLOUD_ORG_ID', '$CONNECTOR_KEY', 'managed-app', 'Managed Demo App', 'oauth_app', 'demo',
    '{"DEMO_CLIENT_ID":"managed-cid","DEMO_CLIENT_SECRET":"managed-secret"}'::jsonb,
    'active', NOW(), NOW()
  );

-- The grant: a NON-expiring access token (no refresh needed → token returned verbatim).
INSERT INTO "account" (id, "accountId", "providerId", "userId", "accessToken", "refreshToken", "accessTokenExpiresAt", scope, "createdAt", "updatedAt")
  VALUES (
    '$ACCOUNT_ID', '$ACCOUNT_ID', 'demo', '$CLOUD_OWNER_ID',
    '$MANAGED_ACCESS_TOKEN', 'managed-refresh-token', '$NONEXPIRY', 'read', NOW(), NOW()
  ) ON CONFLICT (id) DO NOTHING;

INSERT INTO auth_profiles (organization_id, connector_key, slug, display_name, profile_kind, provider, account_id, status, created_at, updated_at)
  VALUES (
    '$CLOUD_ORG_ID', '$CONNECTOR_KEY', 'managed-account', 'Managed Demo Account', 'oauth_account', 'demo',
    '$ACCOUNT_ID', 'active', NOW(), NOW()
  );

-- Consent-only connection OWNED by the member, wiring the grant + managed app.
INSERT INTO connections (organization_id, connector_key, slug, display_name, status, account_id, auth_profile_id, app_auth_profile_id, created_by, config, created_at, updated_at)
  VALUES (
    '$CLOUD_ORG_ID', '$CONNECTOR_KEY', 'managed-consent', 'Managed Consent Connection', 'active',
    '$ACCOUNT_ID',
    (SELECT id FROM auth_profiles WHERE organization_id='$CLOUD_ORG_ID' AND slug='managed-account'),
    (SELECT id FROM auth_profiles WHERE organization_id='$CLOUD_ORG_ID' AND slug='managed-app'),
    '$CLOUD_OWNER_ID', '{"consent_only":true}'::jsonb, NOW(), NOW()
  );

-- The instance's cloud PAT: the owner's own credential WITH connections:token.
INSERT INTO personal_access_tokens (token_hash, token_prefix, user_id, organization_id, name, scope, created_at, updated_at)
  VALUES (
    '$PAT_HASH', '${PAT:0:12}', '$CLOUD_OWNER_ID', '$CLOUD_ORG_ID', 'managed-e2e PAT',
    'mcp:read mcp:write connections:token', NOW(), NOW()
  );
COMMIT;
SQL
echo "✓ CLOUD seeded (public org, consent-only grant, owner PAT w/ connections:token)"

# Sanity: the PAT actually mints a token over real HTTP (pre-flight on the cloud
# endpoint). This is also the first proof of the endpoint working.
PREFLIGHT="$RUN_DIR/preflight.json"
curl -s -o "$PREFLIGHT" -w '%{http_code}' \
  -X POST "http://127.0.0.1:$CLOUD_PORT/oauth/connection-token" \
  -H "authorization: Bearer $PAT" -H 'content-type: application/json' \
  -d "{\"org\":\"$CLOUD_ORG_SLUG\",\"connector_key\":\"$CONNECTOR_KEY\"}" > "$RUN_DIR/preflight.code" 2>/dev/null || true
PREFLIGHT_CODE="$(cat "$RUN_DIR/preflight.code" 2>/dev/null || echo)"
PREFLIGHT_TOKEN="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).access_token||"")}catch{}})' < "$PREFLIGHT" 2>/dev/null || echo)"
[ "$PREFLIGHT_CODE" = "200" ] || { cat "$PREFLIGHT" >&2; fail "pre-flight POST /oauth/connection-token returned $PREFLIGHT_CODE (expected 200)"; }
[ "$PREFLIGHT_TOKEN" = "$MANAGED_ACCESS_TOKEN" ] || { cat "$PREFLIGHT" >&2; fail "cloud returned token '$PREFLIGHT_TOKEN', expected '$MANAGED_ACCESS_TOKEN'"; }
echo "✓ pre-flight: cloud /oauth/connection-token → 200 with the managed token"

# ─── LOCAL instance ─────────────────────────────────────────────────────────
LOCAL_PROJ="$RUN_DIR/local-proj"; mkdir -p "$LOCAL_PROJ/connectors"
( cd "$LOCAL_PROJ" && $LOBU init . -y --here --provider gemini >/dev/null 2>&1 )
rm -f "$LOCAL_PROJ/package.json"
cp "$HARNESS/managed.connector.ts" "$LOCAL_PROJ/connectors/managed.connector.ts"

cat > "$LOCAL_PROJ/lobu.config.ts" <<TS
import { defineAgent, defineConfig, defineConnection, connectorFromFile, secret } from "@lobu/cli/config";

const agent = defineAgent({
  id: "echo", name: "Echo", dir: "./agents/echo",
  providers: [{ id: "mock", model: "mock-model", key: secret("MOCK_API_KEY") }],
});

// The LOCAL connection: managed by the CLOUD public org. No local grant. It
// KEEPS its feed (local data), unlike the cloud's consent-only connection.
const managedConn = defineConnection({
  slug: "managed-pulse",
  connector: "$CONNECTOR_KEY",
  name: "Managed pulse",
  managedBy: { org: "$CLOUD_ORG_SLUG" },
  feeds: [{ feed: "pulse", name: "Pulse" }],
});

export default defineConfig({
  agents: [agent],
  connections: [managedConn],
  connectors: [connectorFromFile("./connectors/managed.connector.ts")],
});
TS

{
  printf '\n'
  echo "MOCK_API_KEY=mock-key-e2e"
  echo "DATABASE_URL=file://$LOCAL_DATA"
  echo "MANAGED_E2E_DATA_URL=http://127.0.0.1:$MOCK_DATA_PORT/items"
  # The env fallback in resolveCloudCredential: point the managed resolver at
  # the CLOUD instance with the owner's connections:token-scoped PAT.
  echo "LOBU_CLOUD_URL=http://127.0.0.1:$CLOUD_PORT"
  echo "LOBU_CLOUD_PAT=$PAT"
} >> "$LOCAL_PROJ/.env"

echo "▶ booting LOCAL instance…"
( cd "$LOCAL_PROJ" \
    && LOBU_CONFIG_DIR="$LOCAL_CFG" LOBU_DATA_DIR="$LOCAL_DATA" DATABASE_URL="file://$LOCAL_DATA" \
       LOBU_PG_PORT="$LOCAL_PG_PORT" ENCRYPTION_KEY="$LOCAL_ENC_KEY" \
       LOBU_CLOUD_URL="http://127.0.0.1:$CLOUD_PORT" LOBU_CLOUD_PAT="$PAT" \
       MANAGED_E2E_DATA_URL="http://127.0.0.1:$MOCK_DATA_PORT/items" \
       $LOBU run --port "$LOCAL_PORT" > "$LOCAL_LOG" 2>&1 ) &
LOCAL_PID=$!
for _ in $(seq 1 120); do
  grep -qiE "Apply complete|auto-apply skipped|Apply halted" "$LOCAL_LOG" 2>/dev/null && break
  sleep 1
done
grep -qi "Apply complete" "$LOCAL_LOG" || fail "LOCAL auto-apply did not complete (connector compile failed?)"
grep -qiE "Apply halted" "$LOCAL_LOG" && fail "LOCAL apply halted"
echo "✓ LOCAL instance booted + applied (managed connection + compiled connector)"

for _ in $(seq 1 60); do psql_db "$LOCAL_DB" "SELECT 1" >/dev/null 2>&1 && break; sleep 1; done
psql_db "$LOCAL_DB" "SELECT 1" >/dev/null 2>&1 || fail "could not connect to LOCAL embedded PG on :$LOCAL_PG_PORT"

# Confirm the local connection is managedBy (not consent-only) and has a feed.
LOCAL_MANAGED_BY="$(psql_db "$LOCAL_DB" "SELECT config->'managedBy'->>'org' FROM connections WHERE connector_key='$CONNECTOR_KEY'")"
[ "$LOCAL_MANAGED_BY" = "$CLOUD_ORG_SLUG" ] || fail "LOCAL connection is not managedBy the cloud org (got '$LOCAL_MANAGED_BY')"
echo "✓ LOCAL connection is managedBy '$CLOUD_ORG_SLUG'"

# ─── Trigger the LOCAL feed sync via the admin API (same path as sdk-e2e) ────
GW="http://localhost:$LOCAL_PORT"
TOKEN="$( ( cd "$LOCAL_PROJ" && LOBU_CONFIG_DIR="$LOCAL_CFG" $LOBU token create -c local --scope "mcp:read mcp:write mcp:admin" --json 2>/dev/null ) | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{}})' )"
[ -n "$TOKEN" ] || fail "could not mint a LOCAL API token"
LOCAL_ORG="$( ( cd "$LOCAL_PROJ" && LOBU_CONFIG_DIR="$LOCAL_CFG" $LOBU org current -c local 2>/dev/null ) | grep -oE '[a-z0-9][a-z0-9-]*' | grep -v '^local$' | tail -1 )"
[ -n "$LOCAL_ORG" ] || fail "could not resolve the LOCAL org slug"
echo "▶ LOCAL API: org=$LOCAL_ORG token=…${TOKEN: -6}"

api() {
  curl -fsS -X POST "$GW/api/$LOCAL_ORG/$1" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$2"
}

FEEDS="$RUN_DIR/feeds.json"
api manage_feeds '{"action":"list_feeds"}' > "$FEEDS" || fail "manage_feeds list_feeds failed"
FEED_ID="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const f=(j.feeds||[]).find(x=>x.feed_key==="pulse");process.stdout.write(f?String(f.id):"")})' < "$FEEDS")"
[ -n "$FEED_ID" ] || { cat "$FEEDS" >&2; fail "no 'pulse' feed found on the LOCAL managed connection"; }
echo "✓ LOCAL apply created the pulse feed (id=$FEED_ID)"

api manage_feeds "{\"action\":\"trigger_feed\",\"feed_id\":$FEED_ID}" > "$RUN_DIR/trigger.json" || { cat "$RUN_DIR/trigger.json" >&2; fail "trigger_feed failed"; }

SYNC_OK=""; RUN_ITEMS=0; LAST_STATUS=none
for _ in $(seq 1 90); do
  api manage_feeds "{\"action\":\"read_feed\",\"feed_id\":$FEED_ID}" > "$RUN_DIR/get-feed.json" 2>/dev/null || { sleep 1; continue; }
  RUN_STATUS="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.stdout.write("none");return}const r=(j.recent_runs||[])[0]||{};process.stdout.write(String(r.status||"none"))})' < "$RUN_DIR/get-feed.json" || echo none)"
  RUN_ITEMS="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.stdout.write("0");return}const r=(j.recent_runs||[])[0]||{};process.stdout.write(String(r.items_collected??0))})' < "$RUN_DIR/get-feed.json" || echo 0)"
  LAST_STATUS="$RUN_STATUS"
  case "$RUN_STATUS" in
    completed) SYNC_OK=1; break ;;
    failed|error) cat "$RUN_DIR/get-feed.json" >&2; fail "LOCAL connector sync ended in status '$RUN_STATUS'" ;;
  esac
  sleep 1
done
[ -n "$SYNC_OK" ] || { cat "$RUN_DIR/get-feed.json" >&2; fail "LOCAL connector sync did not complete (last status: $LAST_STATUS)"; }
echo "✓ LOCAL connector sync completed (items_collected=$RUN_ITEMS)"

# ─── ASSERTIONS ──────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════ ASSERTIONS ════════════════════════"

# 1) CLOUD log shows POST /oauth/connection-token resolving a token.
#    The endpoint logs "Resolved managed connection token" on success. The local
#    resolver hit it over real HTTP during the sync (and the pre-flight).
if grep -qiE "Resolved managed connection token" "$CLOUD_LOG"; then
  CLOUD_HIT_LINE="$(grep -iE "Resolved managed connection token" "$CLOUD_LOG" | tail -1)"
  echo "✅ [1] CLOUD served the managed token over HTTP:"
  echo "       $CLOUD_HIT_LINE"
else
  fail "[1] CLOUD log has no 'Resolved managed connection token' (the local resolver never fetched a token)"
fi

# 2) >=1 connector event landed in the LOCAL Postgres.
LOCAL_EVENTS="$(psql_db "$LOCAL_DB" "SELECT count(*) FROM events WHERE connector_key='$CONNECTOR_KEY'")"
[ "${LOCAL_EVENTS:-0}" -ge 1 ] 2>/dev/null || fail "[2] LOCAL Postgres has 0 connector events (expected >=1)"
LOCAL_SAMPLE="$(psql_db "$LOCAL_DB" "SELECT origin_id || ' | ' || payload_text || ' | tok=' || COALESCE(metadata->>'token_prefix','?') FROM events WHERE connector_key='$CONNECTOR_KEY' ORDER BY id DESC LIMIT 1")"
echo "✅ [2] LOCAL Postgres has $LOCAL_EVENTS connector event(s). Sample row:"
echo "       $LOCAL_SAMPLE"

# 3) ZERO connector events in the CLOUD Postgres (data stayed local).
CLOUD_EVENTS="$(psql_db "$CLOUD_DB" "SELECT count(*) FROM events WHERE connector_key='$CONNECTOR_KEY'")"
[ "${CLOUD_EVENTS:-0}" -eq 0 ] 2>/dev/null || fail "[3] CLOUD Postgres has $CLOUD_EVENTS connector events (expected 0 — data must stay local)"
echo "✅ [3] CLOUD Postgres has 0 connector events for '$CONNECTOR_KEY' (data stayed local)"

# 4) (bonus) the mock data API received the EXACT managed bearer.
if grep -qF "bearer:$MANAGED_ACCESS_TOKEN" "$DATA_LOG"; then
  echo "✅ [4] mock data API received the managed bearer (token was USED upstream):"
  echo "       $(grep -F "bearer:$MANAGED_ACCESS_TOKEN" "$DATA_LOG" | tail -1)"
else
  fail "[4] mock data API never saw the managed bearer '$MANAGED_ACCESS_TOKEN' (token not used upstream)"
fi

echo "═════════════════════════════════════════════════════════════"
echo ""
echo "✅ managed-connector e2e PASSED (cloud auth, local data)"
