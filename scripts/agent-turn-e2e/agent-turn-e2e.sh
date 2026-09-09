#!/usr/bin/env bash
# Live e2e for the isolate-lane agent turn: boots `lobu run` from THIS checkout
# (embedded Postgres, real isolate lane, real MCP route) against a scripted mock
# model and drives turns over the Direct API. Asserts on the DURABLE record
# (runs rows, thread_response rows, agent_transcript_snapshot) and on what the
# model was actually sent (the mock's request log). See README.md for the
# scenarios, the prerequisites (built packages/cli dist) and what each one
# proved when it was written.
#
#   bash scripts/agent-turn-e2e/agent-turn-e2e.sh            # run everything
#   HOLD=1 bash scripts/agent-turn-e2e/agent-turn-e2e.sh     # keep the gateway up afterwards
set -uo pipefail

E2E="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="${WT:-$(cd "$E2E/../.." && pwd)}"
RUN_DIR="${RUN_DIR:-$E2E/run}"
GW_PORT="${GW_PORT:-8795}"
MOCK_PORT="${MOCK_PORT:-11634}"
PG_PORT="${PG_PORT:-59201}"
DB="postgresql://postgres:postgres@127.0.0.1:$PG_PORT/postgres?sslmode=disable"
LOBU="node $WT/packages/cli/bin/lobu.js"
GW="http://127.0.0.1:$GW_PORT"
TODAY="$(date -u +%F)"

rm -rf "$RUN_DIR"; mkdir -p "$RUN_DIR/home"
export HOME="$RUN_DIR/home"
RUN_LOG="$RUN_DIR/run.log"; MOCK_LOG="$RUN_DIR/mock.log"; REQLOG="$RUN_DIR/model-requests.jsonl"
FAILS=0
ok()   { echo "✓ $*"; }
bad()  { echo "❌ $*"; FAILS=$((FAILS+1)); }
note() { echo "· $*"; }
q()    { psql "$DB" -Atq -c "$1"; }

cleanup() {
  pkill -f "lobu.js run --port $GW_PORT" 2>/dev/null || true
  pkill -f "agent-turn-e2e/mock-openai.mjs" 2>/dev/null || true
  for _ in $(seq 1 20); do lsof -nP -iTCP:"$GW_PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done
}
trap cleanup EXIT
cleanup

# 1) mock model
MOCK_PORT="$MOCK_PORT" MOCK_REQLOG="$REQLOG" node "$E2E/mock-openai.mjs" > "$MOCK_LOG" 2>&1 &
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$MOCK_PORT/v1/models" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "http://127.0.0.1:$MOCK_PORT/v1/models" >/dev/null 2>&1 || { echo "mock did not start"; exit 1; }
sed "s#127.0.0.1:11434#127.0.0.1:$MOCK_PORT#" "$WT/scripts/sdk-e2e/providers.json" > "$RUN_DIR/providers.json"
export LOBU_PROVIDER_REGISTRY_PATH="$RUN_DIR/providers.json"
ok "mock model on :$MOCK_PORT"

# 2) project
PROJ="$RUN_DIR/proj"; mkdir -p "$PROJ"
( cd "$PROJ" && $LOBU init . -y --here --provider gemini >/dev/null 2>&1 )
rm -rf "$PROJ/package.json" "$PROJ/node_modules" "$PROJ/bun.lock"
cat > "$PROJ/lobu.config.ts" <<'TS'
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
  echo "WORKER_ALLOWED_DOMAINS=127.0.0.1,localhost"
  echo "LOBU_DISABLE_SYSTEMD_RUN=1"
  echo "AUTOMATION_ARRIVAL_SETTLE_MS=0"
} >> "$PROJ/.env"

# 3) lobu run
( cd "$PROJ" && LOBU_PG_PORT="$PG_PORT" $LOBU run --port "$GW_PORT" > "$RUN_LOG" 2>&1 ) &
for _ in $(seq 1 120); do grep -qiE "Apply complete|auto-apply skipped|Apply halted" "$RUN_LOG" 2>/dev/null && break; sleep 1; done
grep -qi "Apply complete" "$RUN_LOG" || { echo "lobu run did not come up"; tail -40 "$RUN_LOG"; exit 1; }
ok "lobu run up on :$GW_PORT (pg :$PG_PORT)"
q "select 1" >/dev/null || { echo "cannot reach embedded postgres on :$PG_PORT"; exit 1; }

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s)}catch{process.exit(2)};for(const k of process.argv[1].split("."))v=v?.[k];process.stdout.write(v==null?"":typeof v==="string"?v:JSON.stringify(v))})' "$1"; }
DEVTOKEN="$(curl -fsS -X POST "$GW/api/local-init" -H 'X-Lobu-Client: cli' | jget device_token)"
[ -n "$DEVTOKEN" ] || { echo "no device token"; exit 1; }
auth=(-H "authorization: Bearer $DEVTOKEN" -H 'content-type: application/json')
printf 'export GW=%q DB=%q DEVTOKEN=%q REQLOG=%q RUN_LOG=%q\n' "$GW" "$DB" "$DEVTOKEN" "$REQLOG" "$RUN_LOG" > "$RUN_DIR/env.sh"

session() { curl -fsS -X POST "$GW/lobu/api/v1/agents" "${auth[@]}" -d "{\"agentId\":\"echo\",\"thread\":\"$1\"}" | jget agentId; }
send()    { curl -fsS -X POST "$GW/lobu/api/v1/agents/$1/messages" "${auth[@]}" -d "$(node -e 'process.stdout.write(JSON.stringify({content: process.argv[1]}))' "$2")" >/dev/null; }
turncount() { q "select count(*) from runs where run_type='agent_turn' and action_input->'turn'->>'conversation_id'='$1'"; }
# settle <conv> <expected total turns> [timeout s]: wait until that many agent_turn
# runs exist for the conversation AND none of them is still pending/claimed/running.
settle() {
  for _ in $(seq 1 "${3:-90}"); do
    total="$(turncount "$1")"
    active="$(q "select count(*) from runs where run_type='agent_turn' and status in ('pending','claimed','running') and action_input->'turn'->>'conversation_id'='$1'")"
    if [ "$total" -ge "$2" ] && [ "$active" = "0" ]; then sleep 1; return 0; fi
    sleep 1
  done
  echo "  (settle timeout: total=$total active=$active)"; return 1
}
finals() { q "select action_input->>'finalText' from runs where queue_name='thread_response' and action_input->>'conversationId'='$1' and action_input ? 'finalText' order by id"; }
nfinals() { q "select count(*) from runs where queue_name='thread_response' and action_input->>'conversationId'='$1' and action_input ? 'finalText'"; }
turns()  { q "select id||' '||status||' '||coalesce(run_metadata->>'consumed_by_run_id','-')||' '||coalesce(left(error_message,80),'-') from runs where run_type='agent_turn' and action_input->'turn'->>'conversation_id'='$1' order by id"; }

echo; echo "━━ A. system prompt carries the date (and what else the api platform gets)"
CONV_A="$(session date-e2e)"
send "$CONV_A" "hello there"
settle "$CONV_A" 1 || bad "A: turn did not settle"
node -e '
const fs=require("fs");const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>JSON.parse(l));
const mine=lines.filter(r=>r.body.includes("hello there")).at(-1);if(!mine){console.log("❌ A: the model never received the message");process.exit(0)}
const last=JSON.parse(mine.body);const sys=(last.messages||[]).filter(m=>m.role==="system").map(m=>typeof m.content==="string"?m.content:JSON.stringify(m.content)).join("\n");
const today=process.argv[2];
console.log(sys.includes(`Current date: ${today}`)?`✓ A: system prompt ends with "Current date: ${today}"`:"❌ A: no Current date line in the system prompt");
console.log(sys.trimEnd().endsWith(`Current date: ${today}`)?"✓ A: the date is the LAST line":"· A: date present but not last");
console.log(sys.includes("identity:")?"· A: an identity block is present (unexpected for api)":"· A: no chat identity block (api platform registers no provider — expected)");
console.log("· A: system prompt sections: "+[...sys.matchAll(/^## .+$/gm)].map(m=>m[0]).join(" | "));
' "$REQLOG" "$TODAY" | tee "$RUN_DIR/a.txt"; grep -q "❌" "$RUN_DIR/a.txt" && FAILS=$((FAILS+1))
note "A: finalText = $(finals "$CONV_A" | tr '\n' ' ')"

echo; echo "━━ B. steering: a follow-up mid-turn is answered AND both answers are delivered once"
CONV_B="$(session steer-e2e)"
send "$CONV_B" "first question [SLOW:25000]"
# wait for the first turn to be claimed (the model request is in flight) before the follow-up
for _ in $(seq 1 60); do [ "$(q "select count(*) from runs where run_type='agent_turn' and status='running' and action_input->'turn'->>'conversation_id'='$CONV_B'")" = "1" ] && break; sleep 0.5; done
sleep 2
send "$CONV_B" "second question"
settle "$CONV_B" 2 150 || bad "B: turns did not settle"
q "select to_char(created_at,'HH24:MI:SS.MS')||' created  '||coalesce(to_char(claimed_at,'HH24:MI:SS.MS'),'-')||' claimed  '||coalesce(to_char(completed_at,'HH24:MI:SS.MS'),'-')||' completed  #'||id||' '||status from runs where run_type='agent_turn' and action_input->'turn'->>'conversation_id'='$CONV_B' order by id" | sed 's/^/    /'
# What executionPolicy() compares: turn minus the per-message fields, plus reply minus message_id.
# Keys whose values differ between the two turns are exactly what blocks the steer offer.
q "with t as (select id, (action_input->'turn') - 'message_id' - 'message_text' - 'message_images' - 'message_files' - 'session_jsonl' as turn, (action_input->'reply') - 'message_id' as reply from runs where run_type='agent_turn' and action_input->'turn'->>'conversation_id'='$CONV_B' order by id), a as (select * from t limit 1), b as (select * from t offset 1 limit 1) select string_agg(k, ', ') from (select k from a, b, jsonb_object_keys(a.turn || b.turn) k where a.turn->k is distinct from b.turn->k union all select 'reply.'||k from a, b, jsonb_object_keys(a.reply || b.reply) k where a.reply->k is distinct from b.reply->k) d" > "$RUN_DIR/b-policy-diff.txt"
note "B: envelope keys that differ between the two turns (executionPolicy scope): $(cat "$RUN_DIR/b-policy-diff.txt")"
q "select '#'||id||' ephemeral_context: '||coalesce(replace(action_input->'turn'->>'ephemeral_context', E'\n', ' | '),'<none>') from runs where run_type='agent_turn' and action_input->'turn'->>'conversation_id'='$CONV_B' order by id" | cut -c1-300 | sed 's/^/    /' 
B_FINALS="$(finals "$CONV_B")"
B_TURNS="$(turns "$CONV_B")"
note "B: agent_turn runs (id status consumed_by error):"; echo "$B_TURNS" | sed 's/^/    /'
note "B: finalText rows:"; echo "$B_FINALS" | sed 's/^/    /'
if echo "$B_TURNS" | grep -qE "completed [0-9]+"; then
  ok "B: the follow-up was consumed by the running turn (steered), not run separately"
  if [ "$(nfinals "$CONV_B")" = "1" ] && echo "$B_FINALS" | grep -q "ECHO\[first question" && echo "$B_FINALS" | grep -q "ECHO\[second question"; then
    ok "B: ONE finalText carrying BOTH answers"
  else bad "B: finalText does not carry both answers exactly once"; fi
else
  bad "B: no steer happened (the follow-up ran as its own turn) — timing; see runs above"
fi

echo; echo "━━ B2. steering in a warmed conversation (second and third messages; no first-turn attention block)"
CONV_B2="$(session steer2-e2e)"
send "$CONV_B2" "warm up"
settle "$CONV_B2" 1 || bad "B2: warm-up did not settle"
send "$CONV_B2" "third question [SLOW:25000]"
for _ in $(seq 1 60); do [ "$(q "select count(*) from runs where run_type='agent_turn' and status='running' and action_input->'turn'->>'conversation_id'='$CONV_B2'")" = "1" ] && break; sleep 0.5; done
sleep 2
send "$CONV_B2" "fourth question"
settle "$CONV_B2" 3 150 || bad "B2: turns did not settle"
B2_TURNS="$(turns "$CONV_B2")"; B2_FINALS="$(finals "$CONV_B2")"
note "B2: agent_turn runs (id status consumed_by error):"; echo "$B2_TURNS" | sed 's/^/    /'
note "B2: finalText rows:"; echo "$B2_FINALS" | sed 's/^/    /'
q "with t as (select id, (action_input->'turn') - 'message_id' - 'message_text' - 'message_images' - 'message_files' - 'session_jsonl' - 'ephemeral_context' as turn from runs where run_type='agent_turn' and action_input->'turn'->>'conversation_id'='$CONV_B2' order by id offset 1), a as (select * from t limit 1), b as (select * from t offset 1 limit 1) select coalesce(string_agg(k, ', '),'<none>') from (select k from a, b, jsonb_object_keys(a.turn || b.turn) k where a.turn->k is distinct from b.turn->k) d" | sed 's/^/    policy-scope keys differing (after the fix): /'
if echo "$B2_TURNS" | grep -qE "completed [0-9]+"; then
  ok "B2: the follow-up was consumed by the running turn (steered)"
  B2_LAST="$(q "select action_input->>'finalText' from runs where queue_name='thread_response' and action_input->>'conversationId'='$CONV_B2' and action_input ? 'finalText' order by id desc limit 1")"
  if [ "$(nfinals "$CONV_B2")" = "2" ] && echo "$B2_LAST" | grep -q "ECHO\[third question" && echo "$B2_LAST" | grep -q "ECHO\[fourth question"; then
    ok "B2: ONE finalText for the steered turn carrying BOTH answers"
  else bad "B2: the steered turn's finalText does not carry both answers exactly once"; fi
else bad "B2: no steer happened in a warmed conversation"; fi
q "select to_char(created_at,'HH24:MI:SS.MS')||' created  '||coalesce(to_char(claimed_at,'HH24:MI:SS.MS'),'-')||' claimed  '||coalesce(to_char(completed_at,'HH24:MI:SS.MS'),'-')||' completed  #'||id||' '||status||' consumed_by='||coalesce(run_metadata->>'consumed_by_run_id','-') from runs where run_type='agent_turn' and action_input->'turn'->>'conversation_id'='$CONV_B2' order by id" | sed 's/^/    /'

echo; echo "━━ C. retrieval tool: guest asks the MCP route for JSON and the trace carries a summary"
TOKEN="$( ( cd "$PROJ" && $LOBU token create -c local --scope "mcp:read mcp:write mcp:admin" --json 2>/dev/null ) | jget token )"
ORG="$( ( cd "$PROJ" && $LOBU org current -c local 2>/dev/null ) | grep -oE '[a-z0-9][a-z0-9-]*' | grep -v '^local$' | tail -1 )"
if [ -n "$TOKEN" ] && [ -n "$ORG" ]; then
  curl -fsS -X POST "$GW/api/$ORG/save_memory" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"content":"The deploy freeze is frozen until Friday; ask the platform team before shipping.","title":"deploy freeze","semantic_type":"summary"}' > "$RUN_DIR/save-memory.json" \
    && ok "C: seeded one memory via save_memory" || note "C: save_memory failed: $(head -c 300 "$RUN_DIR/save-memory.json")"
else note "C: no PAT/org — searching an empty memory"; fi
# The saved row is indexing_status=pending until the embed backfill runs (cron */5).
# Enqueue the same embed_backfill run the scheduler would, then wait for the row to become searchable.
ORG_ID_C="$(q "select organization_id from events where title='deploy freeze' order by id desc limit 1")"
EVENT_ID_C="$(q "select id from events where title='deploy freeze' order by id desc limit 1")"
if [ -n "$ORG_ID_C" ] && [ -n "$EVENT_ID_C" ]; then
  q "insert into runs (organization_id, run_type, status, approval_status, action_input, created_at) values ('$ORG_ID_C','embed_backfill','pending','auto','{\"event_ids\":[$EVENT_ID_C]}'::jsonb, now())" >/dev/null
  for _ in $(seq 1 120); do
    st="$(q "select status from runs where run_type='embed_backfill' and organization_id='$ORG_ID_C' order by id desc limit 1")"
    [ "$st" = "completed" ] && break; [ "$st" = "failed" ] && break; sleep 1
  done
  note "C: embed_backfill run status: $st; embeddings for event $EVENT_ID_C: $(q "select count(*) from event_embeddings where event_id=$EVENT_ID_C")"
  hit=""
  for _ in $(seq 1 30); do
    curl -sS -X POST "$GW/api/$ORG/search_memory" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"query":"deploy freeze"}' > "$RUN_DIR/direct-search.json"
    hit="$(grep -c '"text_content"' "$RUN_DIR/direct-search.json")"
    [ "$hit" != "0" ] && break; sleep 1
  done
  note "C: direct search_memory via PAT: $(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const b=r.structuredContent??r;console.log("keys="+Object.keys(b).join(",")+" content="+(b.content?.length??"n/a")+" matches="+(b.matches?.length??"n/a")+" status="+b.discovery_status)' "$RUN_DIR/direct-search.json" 2>&1)"
fi
CONV_C="$(session tool-e2e)"
send "$CONV_C" "[SAVE:release freeze|The release freeze holds until Friday; ask the platform team before shipping.] please remember this"
settle "$CONV_C" 1 || bad "C: save turn did not settle"
SAVED_ID="$(q "select id from events where title='release freeze' order by id desc limit 1")"
note "C: agent-saved event id=$SAVED_ID metadata.agent_id=$(q "select metadata->>'agent_id' from events where id=${SAVED_ID:-0}") ; PAT-saved event metadata.agent_id=$(q "select coalesce(metadata->>'agent_id','<null>') from events where id=${EVENT_ID_C:-0}")"
# The save path stamps the memory scope from the bound agent context, so the
# row the agent saved is recallable BY that agent with no arrangement here.
# Asserted rather than noted: the retrieval scenario below is only meaningful
# if the row it retrieves actually carries the scope.
if [ -n "$SAVED_ID" ]; then
  SAVED_SCOPE="$(q "select coalesce(metadata->>'agent_id','<null>') from events where id=$SAVED_ID")"
  if [ "$SAVED_SCOPE" = "echo" ]; then
    echo "✓ C: the agent-saved row carries metadata.agent_id=echo (stamped by save_content)"
  else
    echo "❌ C: the agent-saved row has metadata.agent_id=$SAVED_SCOPE, expected echo"
    FAILS=$((FAILS+1))
  fi
  # The PAT save is the control: an unbound caller must stamp NOTHING, or the
  # fix would have put every workspace write inside some agent's private scope.
  PAT_SCOPE="$(q "select coalesce(metadata->>'agent_id','<null>') from events where id=${EVENT_ID_C:-0}")"
  if [ "$PAT_SCOPE" = "<null>" ]; then
    echo "✓ C: the PAT-saved row carries no agent scope (unbound caller stamps nothing)"
  else
    echo "❌ C: the PAT-saved row leaked an agent scope: $PAT_SCOPE"
    FAILS=$((FAILS+1))
  fi
fi
if [ -n "$SAVED_ID" ]; then
  # No stamp needed here: `save_content.ts` sets `metadata.agent_id` from the
  # bound tool context, so the row the agent just saved is already inside its
  # own recall fence. The harness asserts that above rather than arranging it.
  q "insert into runs (organization_id, run_type, status, approval_status, action_input, created_at) values ('$ORG_ID_C','embed_backfill','pending','auto','{\"event_ids\":[$SAVED_ID]}'::jsonb, now())" >/dev/null
  for _ in $(seq 1 120); do st="$(q "select status from runs where run_type='embed_backfill' and organization_id='$ORG_ID_C' order by id desc limit 1")"; [ "$st" = "completed" ] && break; [ "$st" = "failed" ] && break; sleep 1; done
  note "C: embed_backfill for the agent-saved event: $st; embeddings: $(q "select count(*) from event_embeddings where event_id=$SAVED_ID")"
fi
send "$CONV_C" "[TOOL:search_memory q=release freeze] what do we know?"
settle "$CONV_C" 2 || bad "C: search turn did not settle"
q "select action_input->'customEvent'->'data' from runs where queue_name='thread_response' and action_input->>'conversationId'='$CONV_C' and action_input->'customEvent'->>'name'='tool_use' order by id" > "$RUN_DIR/tool-events.jsonl"
node -e '
const fs=require("fs");const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));
const ev=rows.filter(r=>r.name==="search_memory").at(-1);const saved=rows.find(r=>r.name==="save_memory");console.log(saved?"✓ C: the agent-side save_memory call was delivered as a tool_use event (markdown path, no summary expected)":"❌ C: no save_memory tool_use event");
if(!ev){console.log("❌ C: no tool_use event for search_memory reached the conversation");process.exit(0)}
console.log("· C: tool_use event: "+JSON.stringify(ev).slice(0,400));
const s=ev.result_summary;
console.log(s&&(s.event_ids||s.snippets)?`✓ C: result_summary present (ids=${JSON.stringify(s.event_ids)}, snippets=${(s.snippets||[]).length})`:"❌ C: result_summary absent — the MCP route did not return JSON");
' "$RUN_DIR/tool-events.jsonl" | tee "$RUN_DIR/c.txt"; grep -q "❌" "$RUN_DIR/c.txt" && FAILS=$((FAILS+1))
note "C: finalText = $(finals "$CONV_C" | tr '\n' ' ')"
node -e '
const fs=require("fs");const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>JSON.parse(l));
const hit=lines.filter(r=>r.body.includes("q=release freeze")&&r.body.includes("\"tool\"")).at(-1);if(!hit){console.log("· C: no second model round");process.exit(0)}
const tool=JSON.parse(hit.body).messages.find(m=>m.role==="tool");let raw=tool.content;if(Array.isArray(raw))raw=raw.map(p=>p.text??"").join("");
try{const b=JSON.parse(raw);console.log("· C: agent-side search_memory JSON: content="+(b.content?.length??"n/a")+" matches="+(b.matches?.length??"n/a")+" status="+b.discovery_status+" coverage="+JSON.stringify(b.coverage).slice(0,160))}catch{console.log("· C: agent-side tool result is NOT JSON: "+raw.slice(0,200))}
' "$REQLOG"
grep -c "x-mcp-format" "$RUN_LOG" >/dev/null 2>&1 && note "C: run.log mentions x-mcp-format $(grep -c 'x-mcp-format' "$RUN_LOG") times"

echo; echo "━━ D. tool budget: the guard stops the turn and the settled text is delivered, not \"\""
CONV_D="$(session budget-e2e)"
send "$CONV_D" "[LOOP] keep going"
settle "$CONV_D" 1 240 || bad "D: turn did not settle"
D_FINAL="$(finals "$CONV_D")"
note "D: turns: $(turns "$CONV_D" | tr '\n' ' ')"
note "D: finalText = ${D_FINAL:0:200}"
D_CALLS="$(q "select count(*) from runs where queue_name='thread_response' and action_input->>'conversationId'='$CONV_D' and action_input->'customEvent'->>'name'='tool_use'")"
note "D: tool_use events delivered: $D_CALLS"
if echo "$D_FINAL" | grep -qE "Still looking \([0-9]+\)"; then ok "D: finalText is the settled narration, not empty"; else bad "D: finalText is not the narration (got '${D_FINAL:0:80}')"; fi

echo; echo "━━ E. oversize snapshot: trimmed to the compaction, turn completes, next turn resumes"
CONV_E="$(session trim-e2e)"
send "$CONV_E" "warm up"
settle "$CONV_E" 1 || bad "E: warm-up turn did not settle"
ORG_ID="$(q "select organization_id from runs where run_type='agent_turn' and action_input->'turn'->>'conversation_id'='$CONV_E' limit 1")"
SEED="$(cd "$WT" && node "$E2E/seed-oversize-session.mjs" "$DB" "$ORG_ID" echo "$CONV_E")"
note "E: seeded $SEED"
send "$CONV_E" "after the big history"
settle "$CONV_E" 2 120 || bad "E: post-seed turn did not settle"
note "E: turns: $(turns "$CONV_E" | tr '\n' ' ')"
note "E: finalText rows: $(finals "$CONV_E" | tr '\n' ' | ')"
q "select run_id, byte_size, terminal_status, left(snapshot_jsonl, 300) from agent_transcript_snapshot where conversation_id='$CONV_E' order by run_id desc" > "$RUN_DIR/snapshots.txt"
note "E: snapshot rows (newest first):"; sed 's/^/    /' "$RUN_DIR/snapshots.txt" | cut -c1-260
q "select snapshot_jsonl from agent_transcript_snapshot where conversation_id='$CONV_E' order by run_id desc limit 1" > "$RUN_DIR/latest-snapshot.jsonl"
node -e '
const fs=require("fs");const raw=fs.readFileSync(process.argv[1],"utf8");const bytes=Buffer.byteLength(raw);
const lines=raw.trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const [header,first]=lines;const types=lines.map(e=>e.type);
console.log(`· E: latest snapshot ${bytes} bytes, ${lines.length-1} entries, header.id=${header?.id}`);
console.log(bytes<4*1024*1024?"✓ E: latest snapshot is under the cap":"❌ E: latest snapshot still over the cap");
console.log(first?.id==="u8"&&first?.parentId===null?"✓ E: first entry is u8, re-rooted (parentId null)":`❌ E: first entry is ${first?.id} parent ${first?.parentId}`);
console.log(types.includes("compaction")?"✓ E: the compaction summary survived":"❌ E: compaction entry missing");
console.log(raw.includes("after the big history")?"✓ E: this turn was appended after the trimmed history":"❌ E: this turn is not in the snapshot");
const req=fs.readFileSync(process.argv[2],"utf8").trim().split("\n").map(l=>JSON.parse(l));
const mine=req.filter(r=>r.body.includes("after the big history")).at(-1);
console.log(mine&&mine.body.includes("TRIM_E2E_SUMMARY_MARKER")?"✓ E: the model was sent the compaction summary":"❌ E: the model request lacks the compaction summary");
console.log(mine&&mine.body.includes("question 8")&&!mine.body.includes("question 7")?"✓ E: the model saw the kept exchanges (u8+) and not the summarised ones":"· E: kept/dropped exchange check inconclusive");
' "$RUN_DIR/latest-snapshot.jsonl" "$REQLOG" | tee "$RUN_DIR/e.txt"; grep -q "❌" "$RUN_DIR/e.txt" && FAILS=$((FAILS+1))
grep -E "trimmed to its latest compaction|resetting the conversation" "$RUN_LOG" | tail -2 | sed 's/^/    /'

echo; echo "━━ warnings/errors in run.log mentioning agent-turn"
grep -iE "\[(warn|error)\].*(agent.turn|snapshot|steer|isolate)" "$RUN_LOG" | tail -8 | cut -c1-220 | sed 's/^/    /'
echo; [ "$FAILS" = "0" ] && echo "ALL SCENARIOS PASSED" || echo "$FAILS SCENARIO CHECK(S) FAILED"
if [ -n "${HOLD:-}" ]; then
  echo "HOLD: gateway stays up; touch $RUN_DIR/stop to finish. env: source $RUN_DIR/env.sh"
  while [ ! -f "$RUN_DIR/stop" ]; do sleep 2; done
fi
exit "$FAILS"
