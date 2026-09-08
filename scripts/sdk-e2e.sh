#!/usr/bin/env bash
#
# SDK lifecycle end-to-end gate.
#
# Proves the WHOLE TypeScript-SDK path actually runs — not just that config maps
# correctly (unit/integration cover that), but that `lobu run` boots, auto-applies
# a project, exercises prune, and an agent completes a real turn through a spawned
# worker. Runs against a DETERMINISTIC mock OpenAI-compatible provider (see
# scripts/sdk-e2e/), so it needs no provider key and is reproducible in CI.
#
# It asserts, failing (non-zero exit → red CI) on any miss:
#   1. lobu run auto-applies the fixture → "Apply complete" (NOT halted). With a
#      prune:true fixture this also guards the system-type ($member) exemption —
#      an un-exempted prune halts every apply.
#   2. every declared definition is created (agent, entity/relationship types,
#      Automations), including an Automation with entity + event outputs.
#   3. `lobu chat` drives a real turn through the worker → the mock's reply.
#   4. a stable re-apply is idempotent (0 deletes).
#
# Usage: scripts/sdk-e2e.sh         (embedded Postgres, the default)
#        DATABASE_URL=... scripts/sdk-e2e.sh   (use an external Postgres)
set -euo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$WT/scripts/sdk-e2e"
LOBU="node $WT/packages/cli/bin/lobu.js"
# shellcheck source=scripts/lib/process-cleanup.sh
. "$WT/scripts/lib/process-cleanup.sh"
GW_PORT="${GW_PORT:-8793}"
MOCK_PORT="${MOCK_PORT:-11434}"
MOCK_REPLY="SDK_E2E_OK"
RUN_DIR="$WT/.sdk-e2e-run"
RUN_LOG="$RUN_DIR/run.log"
MOCK_LOG="$RUN_DIR/mock.log"
CHAT_OUT="$RUN_DIR/chat.out"

# Isolate CLI contexts, credentials, and embedded-runtime discovery from the
# developer's real HOME. Without this, `lobu run` changes the active local
# context and a running Owletto menubar follows the E2E gateway, contaminating
# its fresh database with real device registrations and default Automations.
export HOME="$RUN_DIR/home"

# The sandbox supports Node 22-24 via isolated-vm@6 and Node 26+ via the
# isolated-vm-next alias. Node 25 is the only supported-age gap. Prefer a
# Homebrew node@22 locally only when the current Node is actually unsupported;
# otherwise keep the installed runtime and its matching native optional dep.
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ -x /opt/homebrew/opt/node@22/bin/node ] && { [ "$NODE_MAJOR" -lt 22 ] || [ "$NODE_MAJOR" -eq 25 ]; }; then
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi

MOCK_PID=""
RUN_PID=""
cleanup() {
  [ -z "$RUN_PID" ] || lobu_terminate_child "$RUN_PID"
  [ -n "$MOCK_PID" ] && kill -9 "$MOCK_PID" 2>/dev/null || true
  lobu_kill_listening_port "$GW_PORT"
  lobu_kill_listening_port "$MOCK_PORT"
}
trap cleanup EXIT

fail() { echo "❌ SDK e2e FAILED: $*" >&2; [ -f "$RUN_LOG" ] && { echo "--- last 40 lines of run.log ---" >&2; tail -40 "$RUN_LOG" >&2; }; exit 1; }

echo "▶ node $(node --version), gateway :$GW_PORT, mock :$MOCK_PORT"
rm -rf "$RUN_DIR"; mkdir -p "$RUN_DIR" "$HOME"
cleanup  # free ports from any prior run

# 0) Make embedded Postgres self-contained on Linux. The @embedded-postgres PG18
# binaries are NEEDED-linked against ICU 60 with an rpath of `$ORIGIN/../lib`,
# and that lib dir already SHIPS libicu{uc,i18n,data}.so.60.2 — it's only missing
# the `.so.60` SONAME symlinks the loader looks for. We create them (idempotent),
# so initdb loads its bundled ICU with NO system install, NO LD_LIBRARY_PATH and
# NO archive .deb download — identical in CI and on a local Linux dev box. No-op
# on macOS (its bundled .dylibs resolve already). Embedded PG only matters when
# DATABASE_URL is unset (the `lobu run` path); prod uses external Postgres.
if [ -z "${DATABASE_URL:-}" ]; then
  node "$HARNESS/fix-embedded-pg-icu.mjs" || fail "could not prepare embedded-postgres ICU symlinks"
fi

# 1) Mock OpenAI-compatible provider. MOCK_REQLOG captures every
#    /chat/completions request body (JSONL) so gates can assert on what
#    actually reached the model (step 5d.4's `!!` context-exclusion proof).
MOCK_REQLOG="$RUN_DIR/model-requests.jsonl"
MOCK_PORT="$MOCK_PORT" MOCK_REPLY="$MOCK_REPLY" MOCK_REQLOG="$MOCK_REQLOG" node "$HARNESS/mock-openai.mjs" > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
disown "$MOCK_PID" 2>/dev/null || true  # silence job-control "Killed" on cleanup
for _ in $(seq 1 20); do
  curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 || fail "mock server did not come up"
echo "✓ mock provider up"

# 2) Scaffold a project (inside the repo so jiti resolves the workspace @lobu/cli/config).
# Drop node_modules/bun.lock too: `lobu init` installs the *published*
# @lobu/connector-sdk there, and connector bundles staged under cwd ($PROJ)
# would resolve that stale copy instead of the workspace dist under test
# whenever a connector uses an SDK export newer than the last npm release
# (#1222 — this is what turned cli-smoke red).
PROJ="$RUN_DIR/proj"; mkdir -p "$PROJ"
( cd "$PROJ" && $LOBU init . -y --here --provider gemini >/dev/null 2>&1 )
rm -rf "$PROJ/package.json" "$PROJ/node_modules" "$PROJ/bun.lock"
cat > "$PROJ/lobu.config.ts" <<'TS'
import { connectorFromFile, defineAgent, defineAutomation, defineConfig, defineConnection, defineEntityType, defineRelationshipType, defineSkill, reactionFromFile, secret } from "@lobu/cli/config";
import type PulseConnector from "./connectors/pulse.connector.ts";
import type digestReaction from "./reactions/digest.reaction.ts";

// The Automation's instructions live in the agent's skill library; `lobu apply`
// compiles the referenced bodies into the Automation version's frozen prompt.
const digestSkill = defineSkill({ name: "digest", content: "summarize" });

const agent = defineAgent({
  id: "echo", name: "Echo", dir: "./agents/echo",
  skills: [digestSkill],
  providers: [{ id: "mock", model: "mock-model", key: secret("MOCK_API_KEY") }],
});
// The skill body carries a token the turn has to READ off the seeded file to
// report, so a pass proves the file reached the isolate's filesystem rather
// than that the prompt merely mentioned a skill.
const isolateSkill = defineSkill({
  name: "isolate-smoke-skill",
  content: "# Isolate smoke skill\n\nThe skill token is SKILL-SEED-OK.\n",
});
const isolateAgent = defineAgent({
  id: "isolate-smoke", name: "Isolate smoke", dir: "./agents/isolate-smoke",
  skills: [isolateSkill],
  providers: [{ id: "mock", model: "mock-model", key: secret("MOCK_API_KEY") }],
});
// `company` exercises the declarative rendering config: event_kinds (with a
// metadataSchema) and a default viewTemplate, both applied + diffed by lobu apply.
const company = defineEntityType({
  key: "company", name: "Company",
  eventKinds: {
    valuation: {
      description: "A valuation snapshot",
      metadataSchema: { type: "object", properties: { amount: {} } },
    },
  },
  viewTemplate: {
    type: "card",
    children: [{ type: "card-content", children: [{ type: "data", path: "name" }] }],
  },
});
const contact = defineEntityType({ key: "contact", name: "Contact" });
const worksAt = defineRelationshipType({ key: "works-at", name: "Works at", rules: [{ source: contact, target: company }] });

// A local connector (./connectors/pulse.connector.ts) declared explicitly via
// connectorFromFile (the ./connectors auto-scan was dropped in #1043) + a
// connection that wires its single feed. The gate triggers a sync via the API
// and asserts the connector's compiled code actually RAN and emitted ≥1 event —
// proving the whole compile→install→spawn→sync→persist path, not just that
// apply mapped it.
const pulseConn = defineConnection({
  slug: "pulse", connector: "sdke2e-pulse", name: "SDK e2e pulse",
  feeds: [{ feed: "pulse", name: "Pulse" }],
});

// The automation runs an LLM extraction then a reaction script
// (./reactions/digest.reaction.ts) that writes an assertable knowledge event.
// `sources` selects the connector-emitted events by connector_key so the
// automation's window has linked content — the reaction only fires on a non-empty
// window. The gate drives read_knowledge → complete_window deterministically
// (the agentic LLM turn never produces the complete_window tool-call against a
// fixed-reply mock) and asserts the reaction's side effect.
const digest = defineAutomation({
  slug: "digest", agent, name: "Digest", skills: ["digest"],
  // No inline extraction schema — the reaction OWNS the contract via its exported
  // `input`, which set_reaction_script extracts and surfaces to the worker.
  reaction: reactionFromFile<typeof digestReaction>("./reactions/digest.reaction.ts"),
  sources: {
    content:
      "SELECT id, title, payload_text, author_name, occurred_at, origin_type FROM events WHERE connector_key = 'sdke2e-pulse' ORDER BY occurred_at DESC LIMIT 100",
  },
});

// A second Automation exercises durable outputs without a reaction. One completed
// window must upsert a typed entity and append a registered event, proving the
// declarative config, API contract, extraction schema, and persistence path as
// one installed-project flow.
const publisher = defineAutomation({
  slug: "publisher", agent, name: "Publisher", prompt: "Publish companies and observation events.",
  outputs: {
    companies: { entity: company, key: ["name"], name: ["name"] },
    observations: { event: "observation" },
  },
  sources: {
    content:
      "SELECT id, title, payload_text, author_name, occurred_at, origin_type FROM events WHERE connector_key = 'sdke2e-pulse' ORDER BY occurred_at DESC LIMIT 100",
  },
});

// prune:true so the gate exercises the destructive path on every run (this is
// what catches the system-type $member halt class of bug).
export default defineConfig({ prune: true, agents: [agent, isolateAgent], entities: [company, contact], relationships: [worksAt], connectors: [connectorFromFile<typeof PulseConnector>("./connectors/pulse.connector.ts")], connections: [pulseConn], automations: [digest, publisher] });
TS

# Local connector: deterministic, zero-dep, no network. `sync()` returns one
# fresh event per run (a monotonic origin_id off the checkpoint so re-syncs add
# rows rather than dedup to nothing). Proves the compiled ConnectorRuntime runs.
mkdir -p "$PROJ/connectors"
cat > "$PROJ/connectors/pulse.connector.ts" <<'TS'
import { ConnectorRuntime, type SyncContext, type SyncResult } from "@lobu/connector-sdk";

interface Checkpoint {
  seq: number;
}

/**
 * SDK e2e pulse connector — emits one deterministic event per sync. No fetch,
 * no auth, no deps: the gate is testing that a compiled local connector RUNS
 * and persists events, not any external integration.
 */
export default class PulseConnector extends ConnectorRuntime<Checkpoint> {
  readonly definition = {
    key: "sdke2e-pulse",
    name: "SDK e2e pulse",
    version: "1.0.0",
    authSchema: { methods: [{ type: "none" as const }] },
    feeds: {
      pulse: { key: "pulse", name: "Pulse", sync: this.syncPulse },
    },
  };

  private async syncPulse(
    ctx: SyncContext<Checkpoint>,
  ): Promise<SyncResult<Checkpoint>> {
    const seq = (ctx.checkpoint?.seq ?? 0) + 1;
    return {
      events: [
        {
          origin_id: `sdke2e-pulse-${seq}`,
          origin_type: "pulse",
          title: "SDK e2e pulse",
          payload_text: `SDKE2E_PULSE_EVENT seq=${seq}`,
          occurred_at: new Date(),
          metadata: { seq },
        },
      ],
      checkpoint: { seq },
    };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
TS

# Automation reaction: writes a deterministic, assertable knowledge event when the
# window completes. Kept in its own file so the SDK type-checks it.
mkdir -p "$PROJ/reactions"
cat > "$PROJ/reactions/digest.reaction.ts" <<'TS'
// Reaction-owned input contract as a PLAIN JSON Schema (NOT TypeBox — importing
// @sinclair/typebox into the reaction bundle breaks the isolate's SDK client
// proxy). `export const input` is extracted at set_reaction_script and surfaced
// to the worker; the HOST validates complete_window.extracted_data against it
// before the reaction runs, so the handler can trust ctx.extracted_data.
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

export const input = {
  type: "object",
  properties: { s: { type: "string" } },
  required: ["s"],
};

interface Input { s: string; }

export default async (ctx: ReactionContext, client: ReactionClient): Promise<void> => {
  const data = ctx.extracted_data as Input;
  await client.knowledge.save({
    content: data.s,
    semantic_type: "summary",
    metadata: {
      automation_slug: ctx.automation.slug,
      run_id: ctx.window.run_id,
      content_analyzed: ctx.window.content_analyzed,
    },
  });
};
TS

# Project env: mock key, allow loopback egress (mock provider), embedded PG unless
# DATABASE_URL was provided. Lead with a newline so the first line can't glue
# onto a scaffolded .env that lacks a trailing newline.
{
  printf '\n'
  echo "MOCK_API_KEY=mock-key-e2e"
  echo "WORKER_ALLOWED_DOMAINS=127.0.0.1,localhost"
  # The orchestrator wraps Linux workers in `systemd-run --user --scope` for
  # cgroup/network limits; CI runners have no user systemd session, so that
  # spawn fails. Disable it here — the worker only talks to the loopback mock,
  # and this gate isn't testing the prod network sandbox. No-op on macOS.
  echo "LOBU_DISABLE_SYSTEMD_RUN=1"
  # Automation windows select `events.created_at` and stop one settle window
  # short of the database clock, so in production a row is claimable 60s after
  # it lands. This gate syncs a connector and triggers the Automation over it in
  # the same breath, which that budget would hide entirely — the trigger would
  # fail with an empty arrival window. Collapse it here; the settle window has
  # its own coverage in `arrival-axis-window.test.ts`, which runs it at the
  # production value.
  echo "AUTOMATION_ARRIVAL_SETTLE_MS=0"
  [ -n "${DATABASE_URL:-}" ] && echo "DATABASE_URL=$DATABASE_URL"
} >> "$PROJ/.env"

export LOBU_PROVIDER_REGISTRY_PATH="$RUN_DIR/providers.json"
node - "$HARNESS/providers.json" "$LOBU_PROVIDER_REGISTRY_PATH" "$MOCK_PORT" <<'JS'
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
config.providers[0].providers[0].upstreamBaseUrl = `http://127.0.0.1:${process.argv[4]}/v1`;
fs.writeFileSync(process.argv[3], JSON.stringify(config));
JS

# 2c) Static CLI checks (no server needed): the typed-config validator and the
# doctor health check. doctor must NOT false-fail the DB check on the scaffold's
# embedded `DATABASE_URL=file://.` — it once fed that path straight to
# postgres(), which parses host "." and dies with `getaddrinfo ENOTFOUND .`.
# We assert the embedded backend is recognized and that no connect error is
# printed. doctor's own exit code is ignored: the gateway isn't up yet, so its
# "server unreachable" check is expected to trip independently of the DB line.
VALIDATE_OUT="$RUN_DIR/validate.out"
( cd "$PROJ" && $LOBU validate > "$VALIDATE_OUT" 2>&1 ) || { cat "$VALIDATE_OUT" >&2; fail "lobu validate failed on the fixture config"; }
grep -qi "is valid" "$VALIDATE_OUT" || { cat "$VALIDATE_OUT" >&2; fail "lobu validate did not report the config valid"; }
echo "✓ lobu validate accepts the fixture config"

DOCTOR_OUT="$RUN_DIR/doctor.out"
( cd "$PROJ" && $LOBU doctor > "$DOCTOR_OUT" 2>&1 ) || true  # non-zero ok (gateway not up yet)
if grep -qiE "connect failed|ENOTFOUND" "$DOCTOR_OUT"; then cat "$DOCTOR_OUT" >&2; fail "lobu doctor false-failed the DB check (embedded file:// fed to postgres())"; fi
# The embedded-recognition message only applies when running against embedded PG
# (the default). With an external DATABASE_URL, doctor connects for real instead.
if [ -z "${DATABASE_URL:-}" ]; then
  grep -qi "embedded Postgres" "$DOCTOR_OUT" || { cat "$DOCTOR_OUT" >&2; fail "lobu doctor did not recognize the embedded Postgres backend"; }
fi
echo "✓ lobu doctor reports a healthy DB (no false connect failure on embedded file://)"

# 3) Boot lobu run — it auto-applies the project (the apply + prune E2E).
( cd "$PROJ" && exec $LOBU run --port "$GW_PORT" > "$RUN_LOG" 2>&1 ) &
RUN_PID=$!
for _ in $(seq 1 80); do
  grep -qiE "Apply complete|auto-apply skipped|Apply halted" "$RUN_LOG" 2>/dev/null && break
  sleep 1
done

grep -qi "Apply complete" "$RUN_LOG" || fail "auto-apply did not complete (skipped/halted?)"
grep -qiE "Apply halted" "$RUN_LOG" && fail "apply halted on a failure"
echo "✓ lobu run auto-applied the project (Apply complete)"

# 2b) Every declared definition created.
for marker in "+ entity-type company" "+ entity-type contact" "+ relationship-type works-at" "+ automation digest" "+ automation publisher"; do
  grep -qF "$marker" "$RUN_LOG" || fail "expected created definition not in plan: '$marker'"
done
# System $member must be ignorable drift, never a delete row (the prune-halt bug).
grep -qiE "entity-type .member \(removed from config — will be deleted\)|delete.*\\\$member" "$RUN_LOG" && fail "prune tried to delete the system \$member type"
echo "✓ all definitions created; \$member not pruned"

# 4) A real agent turn through the worker.
( cd "$PROJ" && timeout 90 $LOBU chat "say the safe word" -c local > "$CHAT_OUT" 2>&1 ) || fail "lobu chat exited non-zero"
grep -qF "$MOCK_REPLY" "$CHAT_OUT" || fail "agent turn did not return the mock reply '$MOCK_REPLY' (got: $(tr -d '\n' < "$CHAT_OUT" | tail -c 200))"
grep -qiE "Forwarding to upstream: POST http://127.0.0.1:$MOCK_PORT" "$RUN_LOG" || fail "worker never called the mock provider upstream"
echo "✓ agent completed a real turn through the worker (reply: $MOCK_REPLY)"

# ── API setup for the connector/automation assertions ────────────────────────────
# Mint a personal access token bound to the loopback `local` context, and
# resolve the org slug the bootstrap auto-provisioned (don't hardcode it).
# trigger_feed / automation trigger / complete_window / query_sql are owner-admin
# tools (tool-access.ts), so mint with mcp:admin — the local-install user is the
# org owner.
GW="http://localhost:$GW_PORT"
TOKEN="$( ( cd "$PROJ" && $LOBU token create -c local --scope "mcp:read mcp:write mcp:admin" --json 2>/dev/null ) | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{}})' )"
[ -n "$TOKEN" ] || fail "could not mint a local API token (lobu token create -c local --json)"
ORG="$( ( cd "$PROJ" && $LOBU org current -c local 2>/dev/null ) | grep -oE '[a-z0-9][a-z0-9-]*' | grep -v '^local$' | tail -1 )"
[ -n "$ORG" ] || fail "could not resolve the local org slug (lobu org current -c local)"
echo "▶ API: org=$ORG token=…${TOKEN: -6}"

# POST a tool call through the generic /api/:org/:tool proxy. Args = $2 (JSON).
api() {
  curl -fsS -X POST "$GW/api/$ORG/$1" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "$2"
}
# Extract a JSON field from stdin with node (no jq dependency).
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s)}catch{process.exit(2)};for(const k of process.argv[1].split("."))v=v?.[k];process.stdout.write(v==null?"":String(v))})' "$1"; }

# 4b) Client SDK consumption — drive @lobu/client (the CONSUMPTION SDK) against
#     the live gateway: create a session, send a message, stream the reply back.
#     This is the path an external JS app takes; the rest of the gate chats via
#     the `lobu chat` CLI, so without this the consumption SDK has no live-server
#     coverage (only unit tests vs mocked fetch). The consumer installs the
#     PACKED tarball into a throwaway project, proving the published artifact is
#     self-contained (zero deps). The Agent API requires a `device_worker:run`
#     token — an mcp PAT is rejected — so fetch the device_token from
#     /api/local-init (the same worker PAT `lobu chat` uses via getAgentApiToken).
CLIENT_DIR="$RUN_DIR/client-consumer"; mkdir -p "$CLIENT_DIR"
( cd "$WT/packages/client" && bun pm pack --destination "$CLIENT_DIR" >/dev/null 2>&1 ) \
  || fail "could not pack @lobu/client (was dist built by make build-packages?)"
CLIENT_TGZ="$(ls "$CLIENT_DIR"/lobu-client-*.tgz 2>/dev/null | head -1)"
[ -n "$CLIENT_TGZ" ] || fail "no @lobu/client tarball produced"
cat > "$CLIENT_DIR/package.json" <<JSON
{ "name": "sdk-e2e-consumer", "private": true, "type": "module", "dependencies": { "@lobu/client": "file:$CLIENT_TGZ" } }
JSON
cp "$HARNESS/client-consumer.mjs" "$CLIENT_DIR/consumer.mjs"
cp "$HARNESS/isolate-conversation.mjs" "$CLIENT_DIR/isolate-conversation.mjs"
( cd "$CLIENT_DIR" && bun install >/dev/null 2>&1 ) \
  || fail "could not install the @lobu/client tarball into the consumer project"

DEVTOKEN="$(curl -fsS -X POST "$GW/api/local-init" -H 'X-Lobu-Client: cli' | jget device_token)"
[ -n "$DEVTOKEN" ] || fail "could not obtain an Agent-API token (device_token) from /api/local-init"

( cd "$CLIENT_DIR" && node isolate-conversation.mjs "$GW" "$MOCK_REQLOG" "$RUN_LOG" ) \
  || fail "public API conversation did not complete through the isolate"

CLIENT_OUT="$RUN_DIR/client-consumer.out"
( cd "$CLIENT_DIR" && LOBU_BASE_URL="$GW/lobu" LOBU_TOKEN="$DEVTOKEN" LOBU_AGENT_ID="echo" \
    timeout 90 node consumer.mjs > "$CLIENT_OUT" 2>&1 ) \
  || { cat "$CLIENT_OUT" >&2; fail "@lobu/client consumer exited non-zero"; }
grep -qF "$MOCK_REPLY" "$CLIENT_OUT" \
  || { cat "$CLIENT_OUT" >&2; fail "@lobu/client stream did not return the agent reply '$MOCK_REPLY'"; }
echo "✓ @lobu/client created a session, sent a message, and streamed the agent reply ($MOCK_REPLY)"

# 5c) conversations.send (run_sdk) — prove the DURABLE reply-poll path end-to-end:
#     client.conversations.send enqueues a platform:api turn (source=internal,
#     headless), the worker runs it against the mock LLM, writes the terminal
#     thread_response `runs` row, and readConversationReply reads finalText back —
#     WITHOUT SSE. This is the ONLY live coverage of that path (unit tests mock
#     the poll + queue). Assert status="complete" and reply === the mock reply.
CSEND="$RUN_DIR/conversations-send.json"
api run_sdk "$(node -e 'process.stdout.write(JSON.stringify({script:`export default async (ctx, client) => { const r = await client.conversations.send({ agent_id: "echo", text: "ping", timeout_ms: 90000 }); return { status: r.status, reply: r.reply, error: r.error }; }`, timeout_ms: 120000}))')" > "$CSEND" \
  || { cat "$CSEND" >&2; fail "run_sdk conversations.send call failed at the tool layer"; }
CSEND_STATUS="$(jget return_value.status < "$CSEND")"
CSEND_REPLY="$(jget return_value.reply < "$CSEND")"
[ "$CSEND_STATUS" = "complete" ] \
  || { cat "$CSEND" >&2; fail "conversations.send did not complete (status='$CSEND_STATUS', reply='$CSEND_REPLY') — the reply-poll path (enqueue→worker→runs row→readConversationReply) did not close"; }
[ "$CSEND_REPLY" = "$MOCK_REPLY" ] \
  || { cat "$CSEND" >&2; fail "conversations.send returned reply='$CSEND_REPLY', expected '$MOCK_REPLY' (worker turn / finalText read mismatch)"; }
echo "✓ conversations.send round-tripped the agent reply via the durable runs poll ($MOCK_REPLY)"

# 6) Connector sync — prove the COMPILED connector actually RUNS and emits events.
#    Find the feed manage_feeds created from the `pulse` connection, trigger an
#    immediate sync, wait for the run to complete, then assert ≥1 event landed.
FEEDS="$RUN_DIR/feeds.json"
api manage_feeds '{"action":"list_feeds"}' > "$FEEDS" || fail "manage_feeds list_feeds failed"
FEED_ID="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const f=(j.feeds||[]).find(x=>x.feed_key==="pulse");process.stdout.write(f?String(f.id):"")})' < "$FEEDS")"
[ -n "$FEED_ID" ] || { cat "$FEEDS" >&2; fail "no 'pulse' feed found after apply (connection/feed not created?)"; }
echo "✓ apply created the pulse feed (id=$FEED_ID)"

api manage_feeds "{\"action\":\"trigger_feed\",\"feed_id\":$FEED_ID}" > "$RUN_DIR/trigger-feed.json" || { cat "$RUN_DIR/trigger-feed.json" >&2; fail "trigger_feed failed"; }

# Poll read_feed until the most recent sync run reaches a terminal state. Parse
# status/items with separate guarded node calls (process substitution + `read`
# trips `set -e` on a newline-less EOF), so the loop survives transient misses.
SYNC_OK=""; RUN_ITEMS=0
for _ in $(seq 1 90); do
  api manage_feeds "{\"action\":\"read_feed\",\"feed_id\":$FEED_ID}" > "$RUN_DIR/get-feed.json" 2>/dev/null || { sleep 1; continue; }
  RUN_STATUS="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.stdout.write("none");return}const r=(j.recent_runs||[])[0]||{};process.stdout.write(String(r.status||"none"))})' < "$RUN_DIR/get-feed.json" || echo none)"
  RUN_ITEMS="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.stdout.write("0");return}const r=(j.recent_runs||[])[0]||{};process.stdout.write(String(r.items_collected??0))})' < "$RUN_DIR/get-feed.json" || echo 0)"
  case "$RUN_STATUS" in
    completed) SYNC_OK=1; break ;;
    failed|error) cat "$RUN_DIR/get-feed.json" >&2; fail "connector sync run ended in status '$RUN_STATUS'" ;;
  esac
  sleep 1
done
[ -n "$SYNC_OK" ] || { cat "$RUN_DIR/get-feed.json" >&2; fail "connector sync run did not complete within timeout"; }

# Assert the connector emitted ≥1 event (items_collected on the run AND the
# feed-level event_count from list_feeds).
[ "${RUN_ITEMS:-0}" -ge 1 ] 2>/dev/null || fail "sync run completed but collected 0 items"
api manage_feeds '{"action":"list_feeds"}' > "$FEEDS" || fail "manage_feeds list_feeds (post-sync) failed"
EVENT_COUNT="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const f=(j.feeds||[]).find(x=>x.feed_key==="pulse");process.stdout.write(f?String(f.event_count??0):"0")})' < "$FEEDS")"
[ "${EVENT_COUNT:-0}" -ge 1 ] 2>/dev/null || fail "connector sync persisted 0 events (event_count=$EVENT_COUNT)"
echo "✓ connector sync ran the compiled connector and emitted events (items=$RUN_ITEMS, event_count=$EVENT_COUNT)"

# 7) Automation reaction — prove the reaction script RUNS and produces a side
#    effect. Trigger the automation (proves the dispatch path doesn't error), then
#    deterministically drive read_knowledge → complete_window so the reaction
#    fires regardless of the fixed-reply mock (the agentic turn would never
#    produce a complete_window tool-call). The reaction saves SDKE2E_REACTION_OK.
AUTOMATIONS="$RUN_DIR/automations.json"
api manage_automations '{"action":"list"}' > "$AUTOMATIONS" 2>/dev/null || fail "could not list Automations"
AUTOMATION_ID="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const arr=j.automations||j.items||(Array.isArray(j)?j:[]);const w=arr.find(x=>x.slug==="digest")||arr[0];const id=w?.automation_id;process.stdout.write(id!=null?String(id):"")})' < "$AUTOMATIONS")"
[ -n "$AUTOMATION_ID" ] || { cat "$AUTOMATIONS" >&2; fail "no 'digest' Automation found after apply"; }
echo "✓ apply created the digest Automation (id=$AUTOMATION_ID)"

# Declarative rendering config: the `company` type's event_kinds + view template
# must have applied. event_kinds rides manage_entity_schema; the view template is
# a separate manage_view_templates set (apply fetches it per-type, NOT in the
# entity list). Capture the template version so the re-apply can prove no churn.
ETJSON="$RUN_DIR/company-et.json"
api manage_entity_schema '{"schema_type":"entity_type","action":"get","slug":"company"}' > "$ETJSON" 2>/dev/null \
  || { cat "$ETJSON" >&2; fail "manage_entity_schema get company failed"; }
grep -q '"valuation"' "$ETJSON" || { cat "$ETJSON" >&2; fail "company event_kinds.valuation was not applied (declarative event_kinds broken)"; }
echo "✓ apply set entity-type event_kinds (company.valuation)"

vt_version() {
  api manage_view_templates '{"action":"get","resource_type":"entity_type","resource_id":"company"}' 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.default_tab?.current?.version??""))}catch{}})'
}
VT_V1="$(vt_version)"
[ -n "$VT_V1" ] || fail "company view template was not applied (no default version — declarative viewTemplate broken)"
echo "✓ apply set entity-type view template (company default v$VT_V1)"

# Trigger the automation — exercise the FULL dispatch path. This mints an internal
# service token (needs the `lobu-internal` oauth_client, ensured by
# getLobuServiceToken) and dispatches an automation run to a spawned worker.
TW="$RUN_DIR/trigger-automation.json"
api manage_automations "{\"action\":\"trigger\",\"automation_id\":\"$AUTOMATION_ID\"}" > "$TW" 2>/dev/null \
  || { cat "$TW" >&2; fail "automation trigger failed"; }
TRIG_RUN_ID="$(jget run_id < "$TW" 2>/dev/null || echo)"
[ -n "$TRIG_RUN_ID" ] || { cat "$TW" >&2; fail "automation trigger did not dispatch a run (no run_id)"; }

# Read the period AFTER dispatch, bound to the run that will complete it — the
# way a real Automation run reads. This used to read before the trigger so the
# instant fixed mock reply could not requeue the run underneath it, which worked
# while windows were calendar periods: the same period came back either way.
# Arrival windows are `[mark, now - settle)`, so an UNBOUND read resolves against
# the clock and lands a few milliseconds off the bounds the trigger just queued,
# and the completion is rejected for a period the run does not own. Binding to
# `run_id` reproduces the run's own bounds exactly, and is immune to a requeue
# for a better reason than reading early was: it names the run.
RK="$RUN_DIR/read-knowledge.json"
api read_knowledge "{\"automation_id\":$AUTOMATION_ID,\"run_id\":$TRIG_RUN_ID}" > "$RK" 2>/dev/null \
  || { cat "$RK" >&2; fail "read_knowledge (automation mode) failed"; }
WINDOW_TOKEN="$(jget window_token < "$RK")"
[ -n "$WINDOW_TOKEN" ] || { cat "$RK" >&2; fail "read_knowledge returned no window_token (no content in window — connector events missing?)"; }

CW="$RUN_DIR/complete-window.json"
api manage_automations "$(node -e 'const t=process.argv[1],w=process.argv[2],r=Number(process.argv[3]);process.stdout.write(JSON.stringify({action:"complete_window",automation_id:w,run_id:r,window_token:t,extracted_data:{s:"SDKE2E_REACTION_OK"},run_metadata:{executor:"sdk-e2e"}}))' "$WINDOW_TOKEN" "$AUTOMATION_ID" "$TRIG_RUN_ID")" > "$CW" 2>/dev/null \
  || { cat "$CW" >&2; fail "complete_window failed"; }
grep -q '"action":"complete_window"\|"action": "complete_window"' "$CW" || { cat "$CW" >&2; fail "complete_window did not return the expected action"; }
grep -qi "Failed to generate an embedded Lobu service token" "$RUN_LOG" \
  && fail "automation dispatch failed on the service token (lobu-internal oauth_client missing)"
# Assert the dispatch landed a DURABLE agent_turn run. The old probe grepped
# the run log for "Lobu worker for session: …automation_<id>_run", which only
# the managed subprocess ever printed. The runs row carries the same identity in
# `input.turn.conversation_id` (`<agent>_automation_<id>_run_<runId>`) and is the
# stronger claim: it is the record the worker claims and reports against.
# `automation_id` is NOT usable here — it stays null on the child agent_turn row.
AUTO_DISPATCH="$RUN_DIR/automation-dispatch.json"
AUTO_OK=""
for _ in $(seq 1 30); do
  api manage_operations '{"action":"list_runs","run_types":["agent_turn"],"limit":50}' \
    > "$AUTO_DISPATCH" 2>/dev/null || { sleep 1; continue; }
  if node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.exit(1)}const want=`automation_${process.argv[1]}_run_${process.argv[2]}`;const hit=(j.runs||[]).some(r=>String(r.input?.turn?.conversation_id??"").includes(want));process.exit(hit?0:1)})' "$AUTOMATION_ID" "$TRIG_RUN_ID" < "$AUTO_DISPATCH"; then
    AUTO_OK=1; break
  fi
  sleep 1
done
[ -n "$AUTO_OK" ] || { tail -c 600 "$AUTO_DISPATCH" >&2; fail "automation run ${TRIG_RUN_ID} did not dispatch an agent_turn run (no run whose conversation is automation_${AUTOMATION_ID}_run_${TRIG_RUN_ID})"; }
echo "✓ automation trigger dispatched and completed one run (run_id=$TRIG_RUN_ID)"

# Assert the reaction's side effect: a SDKE2E_REACTION_OK knowledge event exists.
# query_sql auto-scopes to the org and auto-adds ORDER BY/LIMIT, so we pass a
# bare SELECT (no ORDER BY/LIMIT) plus the required sort_by, and count rows
# script-side.
# query_sql validates against the data-source table allowlist where `events`
# maps to current_event_records (the superseded-masking view); use `events`.
REACT="$RUN_DIR/reaction-check.json"
REACT_QUERY="$(node -e 'process.stdout.write(JSON.stringify({sql:"SELECT id FROM events WHERE payload_text = '"'"'SDKE2E_REACTION_OK'"'"'",sort_by:"id"}))')"
REACT_OK=""
for _ in $(seq 1 30); do
  api query_sql "$REACT_QUERY" > "$REACT" 2>/dev/null || { sleep 1; continue; }
  N="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.stdout.write("0");return}const rows=j.rows||j.result||j.data||(Array.isArray(j)?j:[]);process.stdout.write(String(Array.isArray(rows)?rows.length:0))})' < "$REACT")"
  if [ "${N:-0}" -ge 1 ] 2>/dev/null; then REACT_OK=1; break; fi
  sleep 1
done
[ -n "$REACT_OK" ] || { cat "$CW" >&2; cat "$REACT" >&2; fail "automation reaction did not produce its SDKE2E_REACTION_OK knowledge event"; }
echo "✓ automation reaction ran and saved its assertable side effect (SDKE2E_REACTION_OK)"

# 7b) Durable Automation outputs — exercise the installed config and public API,
# not an internal helper. Complete one real connector-backed window containing
# both output arrays, then read the typed entity and event through query_sql.
PUBLISHER_ID="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const arr=j.automations||j.items||(Array.isArray(j)?j:[]);const w=arr.find(x=>x.slug==="publisher");const id=w?.automation_id;process.stdout.write(id!=null?String(id):"")})' < "$AUTOMATIONS")"
[ -n "$PUBLISHER_ID" ] || { cat "$AUTOMATIONS" >&2; fail "no 'publisher' Automation found after apply"; }

PUB="$RUN_DIR/publisher.json"
api manage_automations "{\"action\":\"list\",\"automation_id\":\"$PUBLISHER_ID\",\"include_details\":true}" > "$PUB" 2>/dev/null \
  || { cat "$PUB" >&2; fail "could not read the publisher Automation"; }
grep -q '"companies"' "$PUB" && grep -q '"observations"' "$PUB" \
  || { cat "$PUB" >&2; fail "publisher API response omitted its named outputs"; }
grep -q 'keying_config' "$PUB" && { cat "$PUB" >&2; fail "retired keying_config leaked through the public Automation API"; }

PUB_TRIGGER="$RUN_DIR/publisher-trigger.json"
api manage_automations "{\"action\":\"trigger\",\"automation_id\":\"$PUBLISHER_ID\"}" > "$PUB_TRIGGER" 2>/dev/null \
  || { cat "$PUB_TRIGGER" >&2; fail "publisher trigger failed"; }
PUB_RUN_ID="$(jget run_id < "$PUB_TRIGGER" 2>/dev/null || echo)"
[ -n "$PUB_RUN_ID" ] || { cat "$PUB_TRIGGER" >&2; fail "publisher trigger did not dispatch a run (no run_id)"; }

# Bound to the run, for the same reason as the digest Automation above: an
# unbound read resolves the arrival window against the clock and cannot
# reproduce the bounds the trigger just queued.
PUB_RK="$RUN_DIR/publisher-read-knowledge.json"
api read_knowledge "{\"automation_id\":$PUBLISHER_ID,\"run_id\":$PUB_RUN_ID}" > "$PUB_RK" 2>/dev/null \
  || { cat "$PUB_RK" >&2; fail "publisher read_knowledge failed"; }
PUB_WINDOW_TOKEN="$(jget window_token < "$PUB_RK")"
[ -n "$PUB_WINDOW_TOKEN" ] || { cat "$PUB_RK" >&2; fail "publisher read_knowledge returned no window_token"; }

PUB_CW="$RUN_DIR/publisher-complete-window.json"
api manage_automations "$(node -e 'const t=process.argv[1],w=process.argv[2],r=Number(process.argv[3]);process.stdout.write(JSON.stringify({action:"complete_window",automation_id:w,run_id:r,window_token:t,extracted_data:{companies:[{name:"SDK E2E Output Co",domain:"sdk-output.example"}],observations:[{title:"SDK E2E observation",content:"SDKE2E_OUTPUT_EVENT",metadata:{amount:42},idempotency_key:"sdk-e2e-output-observation"}]},run_metadata:{executor:"sdk-e2e"}}))' "$PUB_WINDOW_TOKEN" "$PUBLISHER_ID" "$PUB_RUN_ID")" > "$PUB_CW" 2>/dev/null \
  || { cat "$PUB_CW" >&2; fail "publisher complete_window failed"; }

OUTPUT_ENTITY="$RUN_DIR/output-entity.json"
api manage_entity '{"action":"list","entity_type":"company","search":"SDK E2E Output Co"}' > "$OUTPUT_ENTITY" 2>/dev/null \
  || { cat "$OUTPUT_ENTITY" >&2; fail "querying the publisher entity output failed"; }
grep -q 'SDK E2E Output Co' "$OUTPUT_ENTITY" \
  || { cat "$OUTPUT_ENTITY" >&2; fail "publisher entity output was not persisted"; }

OUTPUT_EVENT="$RUN_DIR/output-event.json"
OUTPUT_EVENT_QUERY="$(node -e 'process.stdout.write(JSON.stringify({sql:"SELECT id, semantic_type, payload_text FROM events WHERE semantic_type = '\''observation'\'' AND payload_text = '\''SDKE2E_OUTPUT_EVENT'\''",sort_by:"id"}))')"
api query_sql "$OUTPUT_EVENT_QUERY" > "$OUTPUT_EVENT" 2>/dev/null \
  || { cat "$OUTPUT_EVENT" >&2; fail "querying the publisher event output failed"; }
grep -q 'SDKE2E_OUTPUT_EVENT' "$OUTPUT_EVENT" \
  || { cat "$OUTPUT_EVENT" >&2; fail "publisher event output was not persisted"; }
echo "✓ Automation outputs persisted a typed entity and a registered event through the public API"

# 5) Idempotent re-apply (stable config → 0 deletes). Unlike `lobu run`, `lobu
# apply` does not auto-load the project .env, so pass the secret it resolves for
# the provider-key push explicitly.
REAPPLY="$RUN_DIR/reapply.out"
( cd "$PROJ" && MOCK_API_KEY=mock-key-e2e $LOBU apply --url "http://localhost:$GW_PORT" --yes > "$REAPPLY" 2>&1 ) || { cat "$REAPPLY" >&2; fail "re-apply exited non-zero"; }
# A fully-idempotent re-apply prints "Nothing to apply." (everything noop/drift);
# a partial one prints "Apply complete.". Either is fine — a delete row is not.
grep -qiE "Nothing to apply|Apply complete" "$REAPPLY" || { cat "$REAPPLY" >&2; fail "re-apply neither completed nor was a noop"; }
if grep -qE "Summary:.*[1-9][0-9]* delete" "$REAPPLY"; then fail "re-apply was not idempotent (deleted something on a stable config)"; fi
echo "✓ re-apply is idempotent (no deletes on a stable config)"

# The view template must NOT churn: apply sets it only on create/change, so a
# stable re-apply leaves the same version (no new view_template_versions row).
# A growing version here means the set-on-change / bounded-fetch logic regressed.
VT_V2="$(vt_version)"
[ "$VT_V1" = "$VT_V2" ] || { cat "$REAPPLY" >&2; fail "re-apply churned the company view template (v$VT_V1 -> v$VT_V2) — set-on-change broken"; }
grep -qE "entity-type company" "$REAPPLY" && grep -qiE "viewTemplate|eventKinds" "$REAPPLY" \
  && fail "re-apply reported a company render-config change on a stable config (diff churn)"
echo "✓ re-apply did not churn entity-type event_kinds / view template (still v$VT_V2)"

echo "✅ SDK lifecycle e2e PASSED"
