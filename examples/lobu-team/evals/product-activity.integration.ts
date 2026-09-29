import { beforeEach, expect, it } from "vitest";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestUser,
  seedOwnerContext,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import { recordMcpConversationActivity } from "../../../packages/server/src/lobu/stores/mcp-client-conversations";
import { recordToolInvocationAudit } from "../../../packages/server/src/tools/audit";
import config from "../lobu.config";

const query = config.connections?.find(
  (connection) => connection.slug === "lobu-product-activity-db"
)?.feeds?.[0]?.config?.query;

async function activity(title: string) {
  if (typeof query !== "string") throw new Error("Missing activity query");
  return getTestDb().unsafe(
    `SELECT * FROM (${query}) activity WHERE title = $1 ORDER BY activity_id`,
    [title]
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
  const before = await activity("MCP activity");
  expect(before).toHaveLength(2);
  expect(new Set(before.map((row) => row.activity_id)).size).toBe(2);
  expect(
    before.find((row) => row.payload_text.includes(user.email))?.payload_text
  ).toContain("Account activity");

  // The production writer clears organization_id after crossing workspaces.
  await recordMcpConversationActivity({
    ctx: { ...account, userId: second.id },
    toolName: "query_sdk",
    failed: false,
  });
  const after = await activity("MCP activity");
  expect(after.map((row) => row.activity_id)).toEqual(
    before.map((row) => row.activity_id)
  );
  expect(
    after.find((row) => row.payload_text.includes(second.email))?.payload_text
  ).toContain("2 total calls");
  expect(after.every((row) => !row.payload_text.includes("0 failed"))).toBe(
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
    SET last_activity_at = now() - interval '2 days' WHERE user_id = ${user.id}`;
  expect(await activity("MCP activity")).toHaveLength(1);
});

it("includes failed SDK outcomes even when transport succeeded, without successful calls", async () => {
  const { ctx, user } = await seedOwnerContext();
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
  await recordToolInvocationAudit({
    ctx: account,
    toolName: "run_sdk",
    args: {},
    durationMs: 10,
    result: { success: true },
  });
  const rows = await activity("Failed tool call");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.payload_text).toContain(user.email);
  expect(rows[0]?.payload_text).toContain("run_sdk");
  expect(rows[0]?.payload_text).toContain("TimeoutError");
});
