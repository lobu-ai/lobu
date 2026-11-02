// Standalone @lobu/client consumer used by scripts/sdk-e2e.sh.
//
// Proves the CONSUMPTION SDK round-trip against a live `lobu run`: open a
// session, `ask()` the agent and await the streamed reply, then `refresh()` the
// session token and `ask()` again to prove the re-minted token still works —
// the path an external JS app takes, distinct from the `lobu chat` CLI the rest
// of the gate exercises. Runs from a throwaway project that installed the
// PACKED @lobu/client tarball, so it also proves the published artifact is
// self-contained (zero deps). It also drives the generated management API:
// agents.get revision, a conditional update, and a stale-revision 409.
//
// Env: LOBU_BASE_URL (origin + /lobu), LOBU_TOKEN (Agent-API token), LOBU_AGENT_ID,
// LOBU_ADMIN_TOKEN (management API token), LOBU_ORG (org slug).
// Prints the agent's answer to stdout; exits non-zero on an empty answer so the
// caller can grep for the expected reply and fail the gate on a miss.

import assert from "node:assert/strict";
import { Lobu, client, generated } from "@lobu/client";

const baseUrl = process.env.LOBU_BASE_URL;
const token = process.env.LOBU_TOKEN;
const agentId = process.env.LOBU_AGENT_ID;
const adminToken = process.env.LOBU_ADMIN_TOKEN;
const orgSlug = process.env.LOBU_ORG;
const question = process.env.LOBU_QUESTION || "say the safe word";

if (!baseUrl || !token || !agentId || !adminToken || !orgSlug) {
  console.error(
    "missing env: LOBU_BASE_URL / LOBU_TOKEN / LOBU_AGENT_ID / LOBU_ADMIN_TOKEN / LOBU_ORG"
  );
  process.exit(2);
}

// Exercise the generated management API from the installed tarball too.
client.setConfig({
  baseUrl: new URL(baseUrl).origin,
  headers: { authorization: `Bearer ${adminToken}` },
});
const path = { orgSlug };
const { data: before } = await generated.manageAgents({
  path,
  body: { action: "get", agent_id: agentId },
  throwOnError: true,
});
assert.equal(before.action, "get");
assert.match(before.revision, /^[a-f0-9]{64}$/);
assert.equal(before.settings.showToolCalls, false);
const { data: changed } = await generated.manageAgents({
  path,
  body: {
    action: "update",
    agent_id: agentId,
    expected_revision: before.revision,
    settings: { showToolCalls: true },
  },
  throwOnError: true,
});
assert.equal(changed.action, "update");
const stale = await generated.manageAgents({
  path,
  body: {
    action: "update",
    agent_id: agentId,
    expected_revision: before.revision,
    settings: { showToolCalls: false },
  },
});
assert.equal(stale.response.status, 409);
const { data: after } = await generated.manageAgents({
  path,
  body: { action: "get", agent_id: agentId },
  throwOnError: true,
});
assert.equal(after.settings.showToolCalls, true);
await generated.manageAgents({
  path,
  body: {
    action: "update",
    agent_id: agentId,
    expected_revision: after.revision,
    settings: { showToolCalls: false },
  },
  throwOnError: true,
});
console.log(
  "[client] packed management API reads settings, applies conditional writes, rejects stale revisions"
);

const lobu = new Lobu({ baseUrl, token });

const session = await lobu.sessions.create({
  agentId,
  userId: "sdk-e2e-consumer",
});
console.log(
  `[client] conversation=${session.conversationId} sse=${session.sseUrl}`
);

// ask(): send + await the streamed reply (connected handshake, messageId
// correlation, output accumulation, resolve-on-complete) in one call.
const first = await session.ask(question, { timeoutMs: 90_000 });
console.log(`[client] ask#1 messageId=${first.messageId}`);
process.stdout.write(first.text);

// refresh(): re-mint the session token via the resume path, then prove the new
// token still drives a working turn on the same conversation.
const tokenBefore = session.token;
await session.refresh();
console.log(
  `[client] refreshed token changed=${session.token !== tokenBefore} expiresAt=${session.expiresAt}`
);
const second = await session.ask(question, { timeoutMs: 90_000 });
console.log(`[client] ask#2 (post-refresh) messageId=${second.messageId}`);

console.log(
  `\n[client] ANSWER: ${first.text.trim()} | post-refresh: ${second.text.trim()}`
);
if (!first.text.trim()) {
  console.error("[client] FAIL: empty answer from ask()");
  process.exit(1);
}
if (!second.text.trim()) {
  console.error(
    "[client] FAIL: empty answer after refresh() — re-minted token rejected?"
  );
  process.exit(1);
}
