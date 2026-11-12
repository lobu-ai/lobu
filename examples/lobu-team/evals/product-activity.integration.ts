import { beforeEach, expect, it } from "vitest";
import PostgresConnector from "@lobu/connectors/postgres";
import type { EventEnvelope } from "@lobu/connector-sdk";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestConnection,
  createTestOAuthClient,
  createTestPAT,
  createTestUser,
  seedOwnerContext,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import { postForm } from "../../../packages/server/src/__tests__/setup/test-helpers";
import {
  recordMcpConversationActivity,
  setCurrentMcpConversationTitle,
} from "../../../packages/server/src/lobu/stores/mcp-client-conversations";
import {
  recordToolInvocationAudit,
  recordWorkspaceActivityAudit,
} from "../../../packages/server/src/tools/audit";
import { insertEvent } from "../../../packages/server/src/utils/insert-event";
import config from "../lobu.config";

const feed = config.connections?.find(
  (connection) => connection.slug === "lobu-product-activity-db"
)?.feeds?.[0];
const query = feed?.config?.query;

async function activity(prefix: string) {
  if (typeof query !== "string") throw new Error("Missing activity query");
  return getTestDb().unsafe(
    `SELECT * FROM (${query}) activity WHERE activity_id LIKE $1 ORDER BY activity_id`,
    [`${prefix}%`]
  );
}

async function collector(organizationId: string) {
  const connection = await createTestConnection({
    organization_id: organizationId,
    connector_key: "postgres",
    slug: "synthetic-product-activity",
  });
  const connector = new PostgresConnector();
  let checkpoint: Record<string, unknown> | null = null;
  return {
    async sync(recollect = false) {
      if (recollect) checkpoint = null;
      const collected: EventEnvelope[] = [];
      await connector.sync({
        feedKey: "query",
        config: { ...feed?.config, DATABASE_URL: process.env.DATABASE_URL },
        checkpoint,
        credentials: null,
        entityIds: [],
        commit: async (events, next) => {
          // Production envelopes cross the worker's JSON transport before
          // insertEvent; in particular, driver Dates in payload_data are strings.
          const transported = JSON.parse(
            JSON.stringify(events)
          ) as EventEnvelope[];
          for (const event of transported) {
            await insertEvent(
              {
                organizationId,
                entityIds: [],
                connectionId: connection.id,
                connectorKey: "postgres",
                originId: event.origin_id,
                originType: event.origin_type,
                semanticType:
                  event.semantic_type ?? event.origin_type ?? "content",
                title: event.title,
                content: event.payload_text,
                payloadData: event.payload_data,
                occurredAt: event.occurred_at,
              },
              { onConflictUpdate: true }
            );
          }
          collected.push(...events);
          if (next) checkpoint = next;
        },
      });
      return collected;
    },
    stored(prefix = "") {
      return getTestDb()`SELECT id, origin_id, occurred_at, payload_data,
        supersedes_event_id FROM events
        WHERE connection_id = ${connection.id}
          AND origin_id LIKE ${`query:${prefix}%`}
        ORDER BY id`;
    },
  };
}

beforeEach(cleanupTestDatabase);

it("keeps account and activity identity across users and workspace changes", async () => {
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
  const rows = await activity("mcp:");
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.activity_id)).size).toBe(2);
  expect(new Set(rows.map((row) => row.activity_data.user_id))).toEqual(
    new Set([user.id, second.id])
  );
  expect(
    rows.every((row) => !Object.hasOwn(row.activity_data, "organization_id"))
  ).toBe(true);
});

it("delivers a seeded activity at its completed-call watermark and retains later observations", async () => {
  const { ctx, user, org } = await seedOwnerContext();
  const account = {
    ...ctx,
    tokenType: "pat" as const,
    mcpConversationId: "synthetic-seeded-conversation",
  };
  await setCurrentMcpConversationTitle(account, "Synthetic title");
  await getTestDb()`UPDATE mcp_client_conversations
    SET first_activity_at = now() - interval '2 days' WHERE user_id = ${user.id}`;
  expect(await activity("mcp:")).toHaveLength(0);
  const source = await collector(org.id);
  await source.sync();
  await recordMcpConversationActivity({
    ctx: account,
    toolName: "run_sdk",
    failed: false,
  });
  const [call] = await getTestDb()`SELECT last_activity_at
    FROM mcp_client_conversations WHERE user_id = ${user.id}`;
  await source.sync();
  const first = await source.stored("mcp:");
  expect(first).toHaveLength(1);
  expect(first[0].occurred_at).toEqual(call.last_activity_at);
  await recordMcpConversationActivity({
    ctx: account,
    toolName: "query_sdk",
    failed: false,
  });
  await source.sync();
  const observations = await source.stored("mcp:");
  expect(observations).toHaveLength(2);
  expect(new Set(observations.map((row) => row.origin_id)).size).toBe(2);
  expect(observations.every((row) => row.supersedes_event_id === null)).toBe(
    true
  );
  await source.sync();
  expect(await source.stored("mcp:")).toEqual(observations);
  await setCurrentMcpConversationTitle(account, "Renamed conversation");
  await source.sync(true);
  expect(await source.stored("mcp:")).toEqual(observations);
});

it.each([
  ["9", "10"],
  ["9007199254740992", "9007199254740993"],
])("orders same-timestamp observations from %s to %s without losing counter precision", async (start, next) => {
  const { ctx, user, org } = await seedOwnerContext();
  const account = { ...ctx, mcpConversationId: "synthetic-tied-observations" };
  await recordMcpConversationActivity({
    ctx: account,
    toolName: "query_sdk",
    failed: false,
  });
  const db = getTestDb();
  await db`UPDATE mcp_client_conversations SET call_count = ${start}::bigint,
    last_activity_at = '2030-01-01T00:00:00.000000Z' WHERE user_id = ${user.id}`;
  const source = await collector(org.id);
  await source.sync();
  await recordMcpConversationActivity({
    ctx: account,
    toolName: "query_sdk",
    failed: false,
  });
  await db`UPDATE mcp_client_conversations
    SET last_activity_at = '2030-01-01T00:00:00.000000Z' WHERE user_id = ${user.id}`;
  await source.sync();
  const observations = await source.stored("mcp:");
  expect(
    observations.map((row) => row.payload_data.activity_data.call_count)
  ).toEqual([start, next]);
  expect(observations.every((row) => row.supersedes_event_id === null)).toBe(
    true
  );
});

it("keeps recorded content stable across renames, soft deletion and recollection", async () => {
  const { ctx, user, org } = await seedOwnerContext();
  const { token } = await createTestPAT(user.id, org.id, {
    scope: "mcp:admin profile:read",
  });
  const response = await postForm("/api/extension-session", { token });
  expect(response.status).toBe(200);
  const client = await createTestOAuthClient({
    client_name: "Synthetic client",
  });
  const account = {
    ...ctx,
    clientId: client.client_id,
    mcpConversationId: "synthetic-rename",
  };
  await recordMcpConversationActivity({
    ctx: account,
    toolName: "query_sdk",
    failed: false,
  });
  await recordToolInvocationAudit({
    ctx: account,
    toolName: "run_sdk",
    args: {},
    durationMs: 1,
    result: { success: false, error: { name: "SyntheticError" } },
  });
  const connection = await createTestConnection({
    organization_id: org.id,
    connector_key: "synthetic.connector",
    created_by: user.id,
  });
  const source = await collector(org.id);
  await source.sync();
  const before = await source.stored();
  expect(
    new Set(before.map((row) => row.payload_data.activity_data.event_type))
  ).toEqual(
    new Set([
      "account.created",
      "session.created",
      "connection.created",
      "mcp.activity_observed",
      "tool_invocation.completed",
    ])
  );
  const db = getTestDb();
  await db`UPDATE "user" SET name = 'Renamed user', email = 'renamed@synthetic.example'
    WHERE id = ${user.id}`;
  await db`UPDATE organization SET name = 'Renamed workspace' WHERE id = ${org.id}`;
  await db`UPDATE oauth_clients SET client_name = 'Renamed client' WHERE id = ${client.client_id}`;
  await db`UPDATE connections SET display_name = 'Renamed connection', deleted_at = now()
    WHERE id = ${connection.id}`;
  await db`UPDATE mcp_client_conversations SET client_software_id = 'Renamed software'
    WHERE user_id = ${user.id}`;
  await setCurrentMcpConversationTitle(account, "Renamed title");
  await source.sync(true);
  expect(await source.stored()).toEqual(before);
});

it("catches up after more than a day offline and preserves observations within one millisecond", async () => {
  const { ctx, user, org } = await seedOwnerContext();
  const account = {
    ...ctx,
    mcpConversationId: "synthetic-precise-observations",
  };
  await recordMcpConversationActivity({
    ctx: account,
    toolName: "query_sdk",
    failed: false,
  });
  const db = getTestDb();
  await db`UPDATE mcp_client_conversations SET first_activity_at = '2026-01-01Z',
    last_activity_at = '2026-01-01T00:00:00.000100Z' WHERE user_id = ${user.id}`;
  const source = await collector(org.id);
  await source.sync();
  expect(await source.stored("mcp:")).toHaveLength(1);
  await recordMcpConversationActivity({
    ctx: account,
    toolName: "query_sdk",
    failed: false,
  });
  await db`UPDATE mcp_client_conversations SET last_activity_at = '2030-01-01T00:00:00.000100Z'
    WHERE user_id = ${user.id}`;
  await source.sync();
  await recordMcpConversationActivity({
    ctx: account,
    toolName: "query_sdk",
    failed: false,
  });
  await db`UPDATE mcp_client_conversations SET last_activity_at = '2030-01-01T00:00:00.000200Z'
    WHERE user_id = ${user.id}`;
  await source.sync();
  expect(await source.sync()).toHaveLength(0);
  const observations = await source.stored("mcp:");
  expect(
    observations.map((row) => row.payload_data.activity_data.call_count)
  ).toEqual(["1", "2", "3"]);
  expect(observations.every((row) => row.supersedes_event_id === null)).toBe(
    true
  );
});

it("includes one failed SDK outcome across workspace mirrors without duplicating successful calls", async () => {
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
  expect(rows[0].activity_data).toMatchObject({
    user_id: user.id,
    organization_id: null,
    tool_name: "run_sdk",
    success: false,
    error: { name: "TimeoutError" },
  });
});
