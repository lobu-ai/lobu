import { beforeEach, expect, it } from "vitest";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestUser,
  createTestOAuthClient,
  seedOwnerContext,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import { recordMcpConversationActivity } from "../../../packages/server/src/lobu/stores/mcp-client-conversations";
import {
  recordToolInvocationAudit,
  recordWorkspaceActivityAudit,
} from "../../../packages/server/src/tools/audit";
import config from "../lobu.config";

const query = config.connections?.find(
  (connection) => connection.slug === "lobu-product-activity-db"
)?.feeds?.[0]?.config?.query;

async function activity(prefix: string) {
  if (typeof query !== "string") throw new Error("Missing activity query");
  return getTestDb().unsafe(
    `SELECT * FROM (${query}) activity WHERE activity_id LIKE $1 ORDER BY activity_id`,
    [`${prefix}%`]
  );
}

beforeEach(cleanupTestDatabase);

it("includes account activity and keeps actor identity across workspace changes", async () => {
  const { ctx, user, org } = await seedOwnerContext();
  const second = await createTestUser();
  const account = {
    ...ctx,
    tokenType: "pat" as const,
    clientId: "synthetic-client",
    mcpConversationId: "synthetic-conversation",
    organizationId: null,
  };
  await recordMcpConversationActivity({
    ctx: account,
    toolName: "query_sdk",
    failed: false,
  });
  await recordMcpConversationActivity({
    ctx: { ...account, userId: second.id, organizationId: org.id },
    toolName: "run_sdk",
    failed: false,
  });
  const before = await activity("mcp:");
  expect(before).toHaveLength(2);
  expect(new Set(before.map((row) => row.activity_id)).size).toBe(2);
  expect(
    before.find((row) => row.payload_text.includes(user.email))?.payload_text
  ).toContain("Account activity");

  // Later calls must not turn the first-seen fact into a new activity event.
  await recordMcpConversationActivity({
    ctx: { ...account, userId: second.id },
    toolName: "query_sdk",
    failed: false,
  });
  await getTestDb()`UPDATE mcp_client_conversations
    SET last_activity_at = first_activity_at + interval '1 day' WHERE user_id = ${second.id}`;
  const after = await activity("mcp:");
  expect(after.map((row) => row.activity_id)).toEqual(
    before.map((row) => row.activity_id)
  );
  expect(after.map((row) => row.occurred_at)).toEqual(
    before.map((row) => row.occurred_at)
  );
  expect(after.every((row) => !row.payload_text.includes("total calls"))).toBe(
    true
  );
  expect(after.every((row) => !row.payload_text.includes("last action:"))).toBe(
    true
  );
});

it("lets the durable cursor catch up after more than a day offline", async () => {
  const { ctx, user } = await seedOwnerContext();
  await recordMcpConversationActivity({
    ctx: { ...ctx, mcpConversationId: "synthetic-old-conversation" },
    toolName: "query_sdk",
    failed: false,
  });
  await getTestDb()`UPDATE mcp_client_conversations
    SET first_activity_at = now() - interval '2 days', last_activity_at = now() - interval '2 days' WHERE user_id = ${user.id}`;
  const rows = await activity("mcp:");
  expect(rows).toHaveLength(1);
  expect(new Date(rows[0].occurred_at).getTime()).toBeLessThan(
    Date.now() - 24 * 60 * 60 * 1000
  );
});

it("includes one failed SDK outcome across workspace mirrors, without successful calls", async () => {
  const { ctx, user, org } = await seedOwnerContext();
  const account = { ...ctx, organizationId: null };
  await recordToolInvocationAudit({
    ctx: account,
    toolName: "run_sdk",
    args: {},
    durationMs: 60000,
    result: {
      success: false,
      error: { name: "TimeoutError", message: "Synthetic timeout" },
    },
  });
  await recordWorkspaceActivityAudit({
    ctx: {
      ...account,
      workspaceActivity: new Map([[org.id, new Set(["entities.list"])]]),
    },
    toolName: "run_sdk",
    failed: true,
  });
  await recordToolInvocationAudit({
    ctx: account,
    toolName: "run_sdk",
    args: {},
    durationMs: 10,
    result: { success: true },
  });
  const rows = await activity("tool-failure:");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.payload_text).toContain(user.email);
  expect(rows[0]?.payload_text).toContain("run_sdk");
  expect(rows[0]?.payload_text).toContain("TimeoutError");
});

it("resolves missing and empty MCP software names from the OAuth client without losing account activity", async () => {
  const { ctx, user } = await seedOwnerContext();
  const { client_id } = await createTestOAuthClient({
    client_name: "Synthetic MCP client",
  });
  await recordMcpConversationActivity({
    ctx: {
      ...ctx,
      clientId: client_id,
      mcpConversationId: "synthetic-named-client",
      organizationId: null,
    },
    toolName: "query_sdk",
    failed: false,
  });
  const sql = getTestDb();
  for (const software of [null, "", "Synthetic software"]) {
    await sql`UPDATE mcp_client_conversations SET client_software_id = ${software} WHERE user_id = ${user.id}`;
    const rows = await activity("mcp:");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload_text).toContain(software || "Synthetic MCP client");
    expect(rows[0]?.payload_text).toContain("Account activity");
    expect(rows[0]?.payload_text).not.toContain("Unknown client");
  }
});
