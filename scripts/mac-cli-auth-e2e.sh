#!/usr/bin/env bash
# End-to-end gate for Mac CLI auth delegation (#263 / PR #1531).
# Boots an isolated lobu run + exercises the CLI contract, worker APIs,
# Chrome native-messaging bridge, Keychain migration, and sign-out.
set -uo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOBU_BIN="$WT/packages/cli/bin/lobu.js"
HARNESS="$WT/scripts/sdk-e2e"
# shellcheck source=scripts/lib/process-cleanup.sh
. "$WT/scripts/lib/process-cleanup.sh"
GW_PORT="${GW_PORT:-8798}"
MOCK_PORT="${MOCK_PORT:-11438}"
MOCK_REPLY="MAC_CLI_AUTH_E2E_OK"
RUN_DIR="$WT/.mac-cli-auth-e2e"
RUN_LOG="$RUN_DIR/run.log"
MOCK_LOG="$RUN_DIR/mock.log"
OUT="$RUN_DIR/out.txt"

if [ -x /opt/homebrew/opt/node@22/bin/node ] && ! node --version 2>/dev/null | grep -qE '^v(22|23|24)\.'; then
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi

REAL_HOME="$HOME"
export HOME="$RUN_DIR/home"
MOCK_PID=""
cleanup() {
  [ -n "$MOCK_PID" ] && kill -9 "$MOCK_PID" 2>/dev/null || true
  lobu_kill_listening_port "$GW_PORT"
  lobu_kill_listening_port "$MOCK_PORT"
}
trap cleanup EXIT

PASSES=0
FAILS=0
pass() { echo "  [OK]   $*"; PASSES=$((PASSES + 1)); }
fail() { echo "  [FAIL] $*" >&2; [ -f "$OUT" ] && tail -8 "$OUT" | sed 's/^/         /' >&2; FAILS=$((FAILS + 1)); }
die() { echo "ABORT: $*" >&2; exit 1; }

RC=0
runlobu() {
  local cwd="$1"; shift
  ( cd "$cwd" && node "$LOBU_BIN" "$@" ) >"$OUT" 2>&1 </dev/null
  RC=$?
}

echo "== mac-cli-auth E2E (isolated HOME, port $GW_PORT) =="
note_xcode() {
  if [ -f "$WT/packages/owletto/apps/mac/Owletto/LobuCLISession.swift" ]; then
    echo ">> building Owletto Debug (ensures bridge uses LobuCLISession)..."
    ( cd "$WT/packages/owletto/apps/mac" && xcodebuild -scheme Owletto -configuration Debug build -quiet CODE_SIGNING_ALLOWED=NO ) \
      || die "xcodebuild Owletto failed"
  fi
}
note_xcode
rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR/home"
cleanup

node "$HARNESS/fix-embedded-pg-icu.mjs" || die "embedded PG ICU prep failed"

MOCK_PORT="$MOCK_PORT" MOCK_REPLY="$MOCK_REPLY" node "$HARNESS/mock-openai.mjs" >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 20); do
  curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" \
    -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" \
  -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 || die "mock server did not come up"

PROVIDERS="$RUN_DIR/providers.json"
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const port=process.argv[2];for(const grp of j.providers||[])for(const sub of grp.providers||[])if(sub.upstreamBaseUrl)sub.upstreamBaseUrl=sub.upstreamBaseUrl.replace(/:\d+/,":"+port);fs.writeFileSync(process.argv[3],JSON.stringify(j,null,2))' \
  "$HARNESS/providers.json" "$MOCK_PORT" "$PROVIDERS"
export LOBU_PROVIDER_REGISTRY_PATH="$PROVIDERS"

PROJ="$RUN_DIR/project"
mkdir -p "$PROJ"
runlobu "$PROJ" init . -y --here --provider gemini
[ "$RC" -eq 0 ] || die "lobu init failed"
rm -rf "$PROJ/package.json" "$PROJ/node_modules" "$PROJ/bun.lock"
cat >"$PROJ/lobu.config.ts" <<'EOF'
import { defineAgent, defineConfig, defineEntityType } from "@lobu/cli/config";
const echo = defineAgent({
  id: "echo", name: "Echo", dir: "./agents/echo",
  providers: [{ id: "mock", model: "mock-model", key: "MOCK_API_KEY" }],
});
export default defineConfig({ agents: [echo], entities: [defineEntityType({ key: "note", name: "Note" })] });
EOF
{
  printf '\n'
  echo "MOCK_API_KEY=mock-key-e2e"
  echo "WORKER_ALLOWED_DOMAINS=127.0.0.1,localhost"
  echo "LOBU_DISABLE_SYSTEMD_RUN=1"
  echo "LOBU_ALLOW_EPHEMERAL_ENCRYPTION_KEY=1"
} >>"$PROJ/.env"

( cd "$PROJ" && node "$LOBU_BIN" run --port "$GW_PORT" >"$RUN_LOG" 2>&1 ) &
for _ in $(seq 1 120); do
  grep -qiE "Apply complete|auto-apply skipped" "$RUN_LOG" 2>/dev/null && break
  sleep 1
done
grep -qi "Apply complete" "$RUN_LOG" || die "lobu run did not auto-apply"
pass "lobu run booted on :$GW_PORT"

# local-init via whoami --json
runlobu "$PROJ" whoami --json -c local
[ "$RC" -eq 0 ] || fail "whoami --json exit $RC"
JSON="$(grep -E '^\{' "$OUT" | tail -1)"
WHOAMI="$(
  node -e '
const j = JSON.parse(process.argv[1]);
const req = ["loggedIn","context","apiUrl","local","workerToken"];
for (const k of req) if (!(k in j)) { console.error("missing", k); process.exit(2); }
if (!j.loggedIn) { console.error("not logged in"); process.exit(3); }
if (!j.local) { console.error("expected local=true"); process.exit(4); }
process.stdout.write(JSON.stringify(j));
' "$JSON"
)" || fail "whoami --json contract"
pass "whoami --json contract (loggedIn, local, workerToken)"

BASE_URL="$(node -pe 'JSON.parse(process.argv[1]).apiUrl.replace(/\/lobu\/api\/v1$/,"").replace(/\/api\/v1$/,"")' "$WHOAMI")"
WORKER_TOKEN="$(node -pe 'JSON.parse(process.argv[1]).workerToken' "$WHOAMI")"
SESSION_TOKEN="$(node -pe 'JSON.parse(process.argv[1]).accessToken' "$WHOAMI")"

# Worker poll (menu bar sync path)
HTTP="$(curl -s -o "$OUT" -w "%{http_code}" \
  -H "Authorization: Bearer $WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/api/workers/poll" \
  -d '{"worker_id":"mac-cli-auth-e2e","capabilities":[]}')"
[ "$HTTP" = "200" ] && pass "POST /api/workers/poll with workerToken ($HTTP)" \
  || fail "POST /api/workers/poll ($HTTP): $(head -c 200 "$OUT")"

# mint-child-token (Chrome bridge path) — needs device_worker:run on bearer
HTTP="$(curl -s -o "$OUT" -w "%{http_code}" \
  -H "Authorization: Bearer $WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Lobu-Client: menubar" \
  -X POST "$BASE_URL/api/me/devices/mint-child-token" \
  -d '{"platform":"chrome-extension"}')"
if [ "$HTTP" = "200" ] && grep -q '"worker_id"' "$OUT" && grep -q '"access_token"' "$OUT"; then
  pass "POST /api/me/devices/mint-child-token ($HTTP)"
else
  fail "mint-child-token ($HTTP): $(head -c 200 "$OUT")"
fi

# Swift decodes the same JSON the Mac app consumes
printf '%s' "$JSON" | swift -e '
import Foundation
struct Whoami: Decodable {
  let loggedIn: Bool; let context: String; let apiUrl: String; let local: Bool
  let accessToken: String?; let workerToken: String?
}
let data = FileHandle.standardInput.readDataToEndOfFile()
let w = try JSONDecoder().decode(Whoami.self, from: data)
precondition(w.loggedIn && w.local && w.workerToken != nil)
print("swift-decode-ok")
' >"$OUT" 2>&1
grep -q swift-decode-ok "$OUT" && pass "Swift JSONDecoder matches whoami --json" \
  || fail "Swift decode: $(cat "$OUT")"

# Legacy OAuth import (credentials.json write path — same as Keychain migration)
MIG_CTX="legacy-migrate-e2e"
HOME="$HOME" BASE_URL="$BASE_URL" swift -e '
import Foundation
struct LegacyUserInfo: Codable { let sub: String; let email: String; let name: String? }
struct LegacyKeychainOAuthEntry: Codable {
  let baseURL: String; let clientID: String; let clientSecret: String?
  var accessToken: String; var refreshToken: String?; var expiresAt: Date?; var userInfo: LegacyUserInfo?
}
enum LobuCredentialsFile {
  static var url: URL { URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".config/lobu/credentials.json") }
  static func hasSession(context: String) -> Bool {
    guard let data = try? Data(contentsOf: url), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let contexts = json["contexts"] as? [String: [String: Any]], let entry = contexts[context] else { return false }
    return !((entry["accessToken"] as? String) ?? "").isEmpty
  }
  static func importLegacyOAuth(context: String, from legacy: LegacyKeychainOAuthEntry) throws {
    var entry: [String: Any] = ["accessToken": legacy.accessToken]
    if let r = legacy.refreshToken { entry["refreshToken"] = r }
    if let e = legacy.expiresAt { entry["expiresAt"] = Int(e.timeIntervalSince1970 * 1000) }
    if let info = legacy.userInfo { entry["email"] = info.email; entry["userId"] = info.sub; if let n = info.name { entry["name"] = n } }
    let origin = legacy.baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    entry["oauth"] = ["clientId": legacy.clientID, "tokenEndpoint": "\(origin)/oauth/token", "clientSecret": legacy.clientSecret as Any, "userinfoEndpoint": "\(origin)/oauth/userinfo"]
    var store: [String: Any] = ["version": 2, "contexts": [context: entry]]
    if let data = try? Data(contentsOf: url), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      store = json; var ctx = (json["contexts"] as? [String: [String: Any]]) ?? [:]; ctx[context] = entry; store["contexts"] = ctx; store["version"] = 2
    }
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONSerialization.data(withJSONObject: store, options: [.prettyPrinted]).write(to: url, options: .atomic)
  }
}
let ctx = "legacy-migrate-e2e"
let base = ProcessInfo.processInfo.environment["BASE_URL"] ?? "http://localhost:8798"
let legacy = LegacyKeychainOAuthEntry(
  baseURL: base, clientID: "e2e-client", clientSecret: "sec",
  accessToken: "legacy-access", refreshToken: "legacy-refresh",
  expiresAt: ISO8601DateFormatter().date(from: "2030-01-01T00:00:00Z"),
  userInfo: LegacyUserInfo(sub: "user-legacy", email: "legacy@example.com", name: "Legacy User")
)
try LobuCredentialsFile.importLegacyOAuth(context: ctx, from: legacy)
guard LobuCredentialsFile.hasSession(context: ctx) else { fputs("no-session\n", stderr); exit(2) }
let data = try Data(contentsOf: LobuCredentialsFile.url)
let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
let contexts = json?["contexts"] as? [String: [String: Any]]
let tok = (contexts?[ctx]?["accessToken"] as? String) ?? ""
guard tok == "legacy-access" else { fputs("bad-token:\(tok)\n", stderr); exit(3) }
print("migration-ok")
' >"$OUT" 2>&1
grep -q migration-ok "$OUT" && pass "legacy OAuth import → credentials.json (legacy-access)" \
  || fail "legacy OAuth import: $(cat "$OUT")"
runlobu "$PROJ" context add "$MIG_CTX" --url "$BASE_URL/api/v1"

# Sign out clears stored credentials (loopback whoami re-mints via local-init — that's ok)
runlobu "$PROJ" logout -c local
[ "$RC" -eq 0 ] || fail "logout exit $RC"
CREDS_CLEARED="$(
  HOME="$HOME" node -e '
const fs = require("fs");
const p = require("path").join(process.env.HOME, ".config/lobu/credentials.json");
if (!fs.existsSync(p)) { process.stdout.write("cleared"); process.exit(0); }
const j = JSON.parse(fs.readFileSync(p, "utf8"));
const entry = j.contexts?.local;
const t = entry?.accessToken ?? "";
process.stdout.write(!entry || t === "" ? "cleared" : "still-has-token");
' 2>/dev/null || echo error
)"
[ "$CREDS_CLEARED" = "cleared" ] && pass "logout cleared credentials.json for local" \
  || fail "logout did not clear credentials.json ($CREDS_CLEARED)"
runlobu "$PROJ" whoami --json -c local
RE_MINT="$(grep -E '^\{' "$OUT" | tail -1 | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).loggedIn' 2>/dev/null)"
[ "$RE_MINT" = "true" ] && pass "loopback whoami re-mints after logout (local-init)" \
  || fail "loopback whoami did not re-mint after logout ($(grep -E '^\{' "$OUT" | tail -1))"

# Chrome native-messaging bridge (Debug build + worktree CLI)
OWLETTO_BIN="$(
  find "$REAL_HOME/Library/Developer/Xcode/DerivedData" -path "*Owletto*Debug/Lobu.app/Contents/MacOS/Lobu" 2>/dev/null \
    | while read -r f; do stat -f "%m %N" "$f"; done \
    | sort -rn | head -1 | cut -d' ' -f2-
)"
[ -x "$OWLETTO_BIN" ] || OWLETTO_BIN=""
if [ -z "$OWLETTO_BIN" ]; then
  fail "Lobu Debug binary not found (run xcodebuild first)"
else
  runlobu "$PROJ" context use local
  runlobu "$PROJ" whoami --json -c local
  BRIDGE_TOKEN="$(grep -E '^\{' "$OUT" | tail -1 | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).workerToken' 2>/dev/null)"
  [ -n "$BRIDGE_TOKEN" ] || fail "bridge prep: no workerToken from whoami"
  REQ='{"op":"pair","platform":"chrome-extension"}'
  LEN=$(printf '%s' "$REQ" | wc -c | tr -d ' ')
  # 4-byte little-endian length prefix + JSON frame
  python3 -c "
import struct, subprocess, os, json, sys
req = json.dumps({'op':'pair','platform':'chrome-extension'}).encode()
frame = struct.pack('<I', len(req)) + req
env = os.environ.copy()
env['LOBU_CLI_DEV_PATH'] = '$LOBU_BIN'
env['HOME'] = '$HOME'
env['PATH'] = '/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:' + env.get('PATH','')
proc = subprocess.run(
  ['$OWLETTO_BIN', 'chrome-extension://e2e-test-extension/'],
  input=frame, capture_output=True, env=env, timeout=30)
out = proc.stdout
if len(out) < 4:
  print('short stdout', proc.stderr.decode()[:500]); sys.exit(1)
(n,) = struct.unpack('<I', out[:4])
body = out[4:4+n]
obj = json.loads(body)
if 'error' in obj:
  print('bridge error', obj); sys.exit(2)
for k in ('gateway_url','worker_id','access_token'):
  if k not in obj: print('missing', k, obj); sys.exit(3)
print('bridge-ok', obj['worker_id'][:8])
" >"$OUT" 2>&1
  grep -q bridge-ok "$OUT" && pass "Chrome bridge pair op via whoamiSync ($(grep bridge-ok "$OUT"))" \
    || fail "Chrome bridge: $(cat "$OUT")"
fi

echo ""
echo "== Summary: $PASSES passed, $FAILS failed =="
[ "$FAILS" -eq 0 ] || exit 1
