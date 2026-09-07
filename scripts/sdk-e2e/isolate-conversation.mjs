import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Lobu } from "@lobu/client";

// The caller owns the booted SDK/CLI fixture. Use only its public APIs;
// completion must come from the normal worker claim/execute/report path.
const origin = process.argv[2];
assert.ok(origin, "usage: node isolate-conversation.mjs <gateway-origin>");
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
assert.equal(run.input.turn.shadow, true);
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
    ["write", false],
    ["read", false],
    ["suggest_actions", false],
  ]
);
assert.ok(JSON.stringify(results[1].content).includes(marker));
console.log(
  `PASS: public API message ${message.messageId} completed isolate run ${run.id}; real write/read, gateway suggestion call and persisted native Pi session verified (shadow=true)`
);
