/** Authenticated wire smoke for the disposable app-image database only.
 * Credentials/fixtures never touch production; no provider calls are needed.
 */
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const base = new URL(process.argv[2]);
const db = new URL(process.env.DATABASE_URL);
assert(
  ["127.0.0.1", "localhost"].includes(base.hostname),
  "candidate must be local"
);
assert(
  ["127.0.0.1", "localhost"].includes(db.hostname) &&
    db.pathname === "/lobu_app_smoke",
  "requires disposable lobu_app_smoke database"
);
const suffix = randomBytes(8).toString("hex");
const user = `smoke_user_${suffix}`;
const org = `smoke_org_${suffix}`;
const denied = `smoke_denied_${suffix}`;
const token = randomBytes(32).toString("hex");
const hash = createHash("sha256").update(token).digest("hex");
const sql = (query) =>
  execFileSync("psql", [db.href, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], {
    input: query,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10000,
    env: { ...process.env, PGOPTIONS: "-c statement_timeout=5000" },
  }).trim();
// Every value interpolated into a query in this file is either generated hex
// with a fixed prefix or a literal from the loops below — never caller input.
sql(`BEGIN;
INSERT INTO organization (id, name, slug, visibility, "createdAt") VALUES
('${org}', 'MCP smoke workspace', '${org}', 'private', now()),
('${denied}', 'MCP smoke denied workspace', '${denied}', 'private', now());
INSERT INTO "user" (id, name, email, username, "emailVerified", "createdAt", "updatedAt")
VALUES ('${user}', 'MCP smoke', '${user}@example.test', '${user}', true, now(), now());
INSERT INTO member (id, "userId", "organizationId", role, "createdAt") VALUES ('${suffix}', '${user}', '${org}', 'owner', now());
INSERT INTO oauth_clients (id, redirect_uris, grant_types, response_types, token_endpoint_auth_method, client_name, created_at, updated_at)
VALUES ('${suffix}', ARRAY['http://localhost/callback'], ARRAY['authorization_code'], ARRAY['code'], 'none', 'MCP image smoke', now(), now());
INSERT INTO oauth_tokens (id, token_type, token_hash, client_id, user_id, organization_id, granted_organization_ids, scope, expires_at, created_at)
VALUES ('${suffix}', 'access', '${hash}', '${suffix}', '${user}', NULL, ARRAY['${org}'], 'mcp:read mcp:write', now() + interval '10 minutes', now());
COMMIT;`);
// Matches @lobu/core's MCP_PROTOCOL_VERSION; this image job has no workspace
// install. Subsequent requests use the version negotiated by the gateway.
const PROTOCOL_VERSION = "2025-11-25";
let session;
let protocol;
let id = 0;
async function rpc(method, params, notification = false) {
  const response = await fetch(new URL("/mcp", base), {
    method: "POST",
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(protocol ? { "MCP-Protocol-Version": protocol } : {}),
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(notification ? {} : { id: ++id }),
      method,
      params,
    }),
  });
  assert(response.ok, `${method}: HTTP ${response.status}`);
  session = response.headers.get("mcp-session-id") || session;
  if (notification) return;
  const text = await response.text();
  const body = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)))
        .find((message) => message.id === id)
    : JSON.parse(text);
  assert(body && !body.error, `${method}: JSON-RPC error`);
  return body.result;
}
const initialized = await rpc("initialize", {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    extensions: {
      "io.modelcontextprotocol/ui": {
        mimeTypes: ["text/html;profile=mcp-app"],
      },
    },
  },
  clientInfo: { name: "mcp-image-smoke", version: "1.0.0" },
});
assert(session, "initialize must create a session");
assert(
  typeof initialized.protocolVersion === "string" &&
    initialized.protocolVersion,
  "initialize must negotiate a protocol version"
);
protocol = initialized.protocolVersion;
await rpc("notifications/initialized", {}, true);
const { tools } = await rpc("tools/list", {});
for (const [name, target] of [
  ["save_memory", "org_slug"],
  ["query_sql", "org_slug"],
  ["get_approval", "organization"],
]) {
  assert(
    tools
      .find((tool) => tool.name === name)
      ?.inputSchema.required?.includes(target),
    `${name} must advertise explicit ${target}`
  );
}
console.log("ok — bare-account discovery requires explicit workspace targets");
let saveError;
for (const [title, name, args, code] of [
  ["missing", "query_sql", { sql: "SELECT 1 AS ok" }, "VALIDATION"],
  [
    "missing-save",
    "save_memory",
    { content: "Synthetic smoke note" },
    "VALIDATION",
  ],
  [
    "denied",
    "query_sql",
    { sql: "SELECT 1 AS ok", org_slug: denied },
    "PERMISSION",
  ],
]) {
  const result = await rpc("tools/call", {
    name,
    arguments: { ...args, title },
  });
  if (name === "save_memory") saveError = result;
  assert.equal(result.isError, true, `${title}: must return an MCP tool error`);
  assert(
    result.content?.some(
      (item) => item.type === "text" && item.text.length > 10
    ),
    `${title}: actionable text`
  );
  assert.equal(result.structuredContent?.error?.code, code, `${title}: code`);
  assert(result.structuredContent?.error?.call_id, `${title}: correlation ID`);
  const count =
    sql(`SELECT count(*) FROM events WHERE created_by = '${user}' AND organization_id IS NULL
    AND origin_type = 'tool_invocation' AND payload_data->>'tool_name' = '${name}'
    AND payload_data->>'success' = 'false'
    ${name === "query_sql" ? `AND payload_data->'request'->>'title' = '${title}'` : ""};`);
  assert.equal(
    count,
    "1",
    `${title}: failure must be audited privately against caller`
  );
  console.log(
    `ok — ${title} target returns ${code} and a private audit record`
  );
}
const result = await rpc("tools/call", {
  name: "query_sql",
  arguments: { sql: "SELECT 1 AS ok", org_slug: org, title: "explicit" },
});
assert.notEqual(result.isError, true, "explicit target must dispatch");
assert.deepEqual(
  result.structuredContent?.rows,
  [{ ok: 1 }],
  "explicit target must return structured rows"
);
const uri = tools.find((tool) => tool.name === "save_memory")?._meta?.[
  "openai/outputTemplate"
];
assert(uri, "tool must advertise its MCP App resource");
const resource = await rpc("resources/read", { uri });
const [shell] = resource.contents ?? [];
assert(
  shell?.mimeType?.startsWith("text/html") &&
    /assets\/app\.js\?v=/.test(shell.text),
  "resource must contain the versioned app bundle"
);
const staleResource = await rpc("resources/read", {
  uri: "ui://lobu/interaction/v1.html",
});
assert.equal(
  staleResource.contents?.[0]?.text,
  shell.text,
  "cached resource URIs must resolve the current shell"
);
console.log(
  "ok — explicit target query succeeds; current and cached MCP App resources resolve"
);
if (process.argv[3])
  writeFileSync(
    process.argv[3],
    JSON.stringify({ toolResult: saveError, html: shell.text })
  );
console.log("MCP image smoke PASSED");
