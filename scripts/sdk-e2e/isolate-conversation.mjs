import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Lobu } from "@lobu/client";

// The caller owns the booted SDK/CLI fixture. Use only its public APIs;
// completion must come from the normal worker claim/execute/report path.
const origin = process.argv[2];
const requestLog = process.argv[3];
const runtimeLog = process.argv[4];
assert.ok(
  origin && requestLog && runtimeLog,
  "usage: node isolate-conversation.mjs <gateway-origin> <request-log> <runtime-log>"
);
const marker = `ISOLATE_SMOKE_${randomBytes(16).toString("hex")}`;

async function post(path, body, token) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Lobu-Client": "cli",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json();
  assert.ok(response.ok && !result.error, `${path}: ${JSON.stringify(result)}`);
  return result;
}

const init = await post("/api/local-init", {});
const lobu = new Lobu({ baseUrl: `${origin}/lobu`, token: init.device_token });
const session = await lobu.sessions.create({
  agentId: "isolate-smoke",
  forceNew: true,
});
const message = await session.ask(
  `Write ${marker} to smoke.txt, read the file, then report its contents.`,
  { timeoutMs: 90_000 }
);
// The current API reply still comes from the old worker. It cannot substitute
// for the independently persisted isolate result asserted below.
assert.equal(message.text, marker);
assert.ok(message.messageId);

const deadline = Date.now() + 90_000;
let run;
while (Date.now() < deadline) {
  const listed = await post(
    `/api/${init.organization.slug}/manage_operations`,
    {
      action: "list_runs",
      run_types: ["agent_turn"],
      limit: 20,
    },
    init.device_token
  );
  const matching = listed.runs.filter(
    (item) => item.input?.turn?.message_id === message.messageId
  );
  assert.ok(
    matching.length <= 1,
    "one API message created duplicate isolate runs"
  );
  [run] = matching;
  if (run && ["completed", "failed", "cancelled"].includes(run.status)) break;
  await delay(500);
}
assert.equal(
  run?.status,
  "completed",
  run?.error_message ?? "isolate run did not complete"
);
assert.equal(run.run_type, "agent_turn");
assert.equal(run.input.turn.agent_id, "isolate-smoke");
assert.equal(run.input.result.text, marker);
assert.equal(typeof run.input.result.session_jsonl, "string");
const [header, ...entries] = run.input.result.session_jsonl
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));
assert.equal(header.type, "session");
assert.equal(header.version, 3);
assert.ok(header.id);
assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
const messages = entries
  .filter((entry) => entry.type === "message")
  .map((entry) => entry.message);
assert.equal(
  messages.filter((entry) => entry.role === "user").length,
  1,
  "the turn replayed history that already contained this message, prompting it twice"
);
const results = messages.filter((entry) => entry.role === "toolResult");
const calls = messages.flatMap((entry) =>
  entry.role === "assistant"
    ? entry.content.filter((block) => block.type === "toolCall")
    : []
);
assert.deepEqual(
  results.map((result) => result.toolCallId),
  calls.map((call) => call.id)
);
assert.deepEqual(
  results.map((entry) => [entry.toolName, entry.isError]),
  [
    ["read", false],
    ["write", false],
    ["read", false],
    ["suggest_actions", false],
  ]
);
// The FIRST read is the skill the gateway seeded before the turn ran. Its token
// exists only inside that file, so this is end-to-end proof through the
// packaged CLI/server/worker that a seeded file reaches the isolate's
// filesystem — not a fixture asserting its own input back.
assert.ok(
  JSON.stringify(results[0].content).includes("SKILL-SEED-OK"),
  "the seeded skill file did not reach the isolate workspace"
);
assert.ok(JSON.stringify(results[2].content).includes(marker));
console.log(
  `PASS: public API message ${message.messageId} completed isolate run ${run.id}; seeded skill file read, real write/read, gateway suggestion call and persisted native Pi session verified`
);

const cancelMarker = `ISOLATE_CANCEL_${randomBytes(16).toString("hex")}`;
const cancelSession = await lobu.sessions.create({
  agentId: "isolate-smoke",
  forceNew: true,
});
const activeMessageId = `cancel-active-${randomBytes(16).toString("hex")}`;
const cancelMessageId = `cancel-command-${randomBytes(16).toString("hex")}`;
await cancelSession.send(cancelMarker, { messageId: activeMessageId });

async function nativeRuns() {
  return (
    await post(
      `/api/${init.organization.slug}/manage_operations`,
      {
        action: "list_runs",
        run_types: ["agent_turn"],
        limit: 20,
      },
      init.device_token
    )
  ).runs;
}
async function streamEvents() {
  const content = await readFile(`${requestLog}.streams`, "utf8").catch(
    (error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  );
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((event) => event.marker === cancelMarker);
}
async function until(description, predicate) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(250);
  }
  assert.fail(`Timed out: ${description}`);
}
let activeRun;
await until("native and managed runtimes are both streaming", async () => {
  activeRun = (await nativeRuns()).find(
    (item) => item.input?.turn?.message_id === activeMessageId
  );
  return (
    activeRun?.status === "running" &&
    (await streamEvents()).filter((event) => event.event === "opened")
      .length === 2
  );
});
await cancelSession.send("/cancel", { messageId: cancelMessageId });
await until(
  "public cancellation reaches the native run and worker heartbeat",
  async () => {
    const runs = await nativeRuns();
    assert.ok(
      !runs.some((item) => item.input?.turn?.message_id === cancelMessageId),
      "cancel was admitted as another native model turn"
    );
    const cancelled = runs.find((item) => item.id === activeRun.id);
    const log = await readFile(runtimeLog, "utf8");
    return (
      cancelled?.status === "cancelled" &&
      log.includes(`[agent-turn] run ${activeRun.id} stopping: cancelled`)
    );
  }
);
await until(
  "cancellation closes both provider streams",
  async () =>
    (await streamEvents()).filter((event) => event.event === "closed")
      .length === 2
);
const events = await streamEvents();
assert.equal(
  events.filter((event) => event.event === "opened").length,
  2,
  "cancellation started another inference call"
);
assert.ok(
  !events.some((event) => event.event === "timeout"),
  "fixture timeout ended inference instead of cancellation"
);
console.log(
  `PASS: public API /cancel cancelled isolate run ${activeRun.id}; heartbeat stopped the real isolate and both provider streams closed without another inference call`
);
