import type { AutomationReadback } from "../scripts/configure-product-activity";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createAutomationRun } from "../../../packages/server/src/runs/queue-service";
import { readFileSync } from "node:fs";
import { executeAutomationScript } from "../../../packages/server/src/automations/reaction-executor";
import {
  configureTeamAlerts,
  teamAlertsModule,
} from "../scripts/configure-team-alerts";
import { beforeEach, expect, it } from "vitest";

import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestAgent,
  createTestConnection,
  createTestEvent,
  createTestUser,
  seedOwnerContext,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import {
  recordMcpConversationActivity,
  setCurrentMcpConversationTitle,
} from "../../../packages/server/src/lobu/stores/mcp-client-conversations";
import {
  recordToolInvocationAudit,
  recordWorkspaceActivityAudit,
} from "../../../packages/server/src/tools/audit";
import { productActivitySql, productActivityQuery } from "../product-activity";
import { buildClientSDK } from "../../../packages/server/src/sandbox/client-sdk";
import { createAuthProfile } from "../../../packages/server/src/utils/auth-profiles";

const execFileAsync = promisify(execFile);

async function activity(prefix: string) {
  return getTestDb().unsafe(
    `SELECT * FROM (${productActivitySql}) activity WHERE activity_id LIKE $1 ORDER BY activity_id`,
    [`${prefix}%`]
  );
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

it("reads bounded account facts live through the SDK without stored copies or vectors", async () => {
  const { ctx, user, org } = await seedOwnerContext();
  const db = getTestDb();
  const profile = await createAuthProfile({
    organizationId: org.id,
    connectorKey: "postgres",
    displayName: "Synthetic live source",
    profileKind: "env",
    authData: { DATABASE_URL: process.env.DATABASE_URL! },
  });
  await db`INSERT INTO connections (organization_id, connector_key, slug, display_name, status,
    auth_profile_id, visibility, created_by) VALUES (${org.id}, 'postgres',
    'synthetic-live-source', 'Synthetic live source', 'active', ${profile.id}, 'org', ${user.id})`;
  await db`UPDATE "user" SET "createdAt" = '2026-01-01T00:00:00Z' WHERE id = ${user.id}`;
  const client = buildClientSDK(ctx, { ENVIRONMENT: "test" });
  const [before] = await db`SELECT count(*)::int AS n FROM events`;
  const read = async (start: string, end: string) =>
    client.query(productActivityQuery(start, end), {
      connection: "synthetic-live-source",
    }) as Promise<Array<Record<string, unknown>>>;
  const first = await read(
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:01.000Z"
  );
  expect(
    first.filter((row) => row.activity_id === `signup:${user.id}`)
  ).toHaveLength(1);
  expect(
    await read("2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z")
  ).toHaveLength(0);
  await db`UPDATE "user" SET name = 'Current source name' WHERE id = ${user.id}`;
  const reread = await read(
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:01.000Z"
  );
  expect(
    reread.find((row) => row.activity_id === `signup:${user.id}`)?.payload_text
  ).toContain("Current source name");
  const [after] = await db`SELECT count(*)::int AS n FROM events`;
  expect(after.n).toBe(before.n);
  expect(await db`SELECT event_id FROM event_embeddings`).toHaveLength(0);
}, 60_000);

it("reads current MCP state, including a seeded conversation after its first completed call", async () => {
  const { ctx, user } = await seedOwnerContext();
  const account = { ...ctx, mcpConversationId: "synthetic-live-conversation" };
  await setCurrentMcpConversationTitle(account, "Seeded title");
  expect(await activity("mcp:")).toHaveLength(0);
  await recordMcpConversationActivity({
    ctx: account,
    toolName: "query_sdk",
    failed: false,
  });
  expect((await activity("mcp:"))[0].activity_data.call_count).toBe("1");
  await recordMcpConversationActivity({
    ctx: account,
    toolName: "query_sdk",
    failed: false,
  });
  const rows = await activity("mcp:");
  expect(rows).toHaveLength(1);
  expect(rows[0].activity_data).toMatchObject({
    user_id: user.id,
    call_count: "2",
  });
  expect(
    await getTestDb()`SELECT id FROM events WHERE origin_type = 'row'`
  ).toHaveLength(0);
});

it("includes one failed SDK outcome across workspace mirrors without duplicating successful calls", async () => {
  const { ctx, user, org } = await seedOwnerContext();
  const account = {
    ...ctx,
    organizationId: null,
    tokenType: "pat" as const,
    tokenName: "synthetic private token label",
  };
  await recordToolInvocationAudit({
    ctx: account,
    toolName: "run_sdk",
    args: {},
    durationMs: 60000,
    result: {
      success: false,
      error: {
        name: "TimeoutError",
        message: "synthetic private failure detail",
      },
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
  expect(rows[0].activity_data.error).not.toHaveProperty("message");
  expect(rows[0].activity_data.actor).not.toHaveProperty("token_name");
  expect(JSON.stringify(rows[0])).not.toContain("synthetic private");
});

it("runs the migrated alert module against live accounts and preserves legacy notification keys", async () => {
  const { ctx, user, org } = await seedOwnerContext();
  const db = getTestDb();
  const second = await createTestUser();
  await db`UPDATE "user" SET "createdAt" = '2026-01-01T00:00:30Z' WHERE id IN (${user.id}, ${second.id})`;
  const profile = await createAuthProfile({
    organizationId: org.id,
    connectorKey: "postgres",
    displayName: "Synthetic alert source",
    profileKind: "env",
    authData: { DATABASE_URL: process.env.DATABASE_URL! },
  });
  await db`INSERT INTO connections (organization_id, connector_key, slug, display_name, status,
    auth_profile_id, visibility, created_by) VALUES (${org.id}, 'postgres',
    'synthetic-alert-source', 'Synthetic alert source', 'active', ${profile.id}, 'org', ${user.id})`;
  const client = buildClientSDK(ctx, { ENVIRONMENT: "test" });
  const agent = await createTestAgent({
    organizationId: org.id,
    ownerUserId: user.id,
    agentId: "synthetic-alert-owner",
  });
  const digest = await client.automations.create({
    slug: "synthetic-digest",
    name: "Synthetic digest",
    prompt: "Synthetic",
  });
  if (!("automation_id" in digest)) throw new Error("Expected digest");
  const github = await createTestConnection({
    organization_id: org.id,
    connector_key: "synthetic.github",
    slug: "github-app-install",
  });
  await createTestEvent({
    organization_id: org.id,
    connection_id: github.id,
    origin_id: "synthetic-issue",
    semantic_type: "issue",
    content: "Synthetic outside issue",
    created_at: new Date("2026-01-01T00:40:00Z"),
    occurred_at: new Date("2026-01-01T00:40:00Z"),
    metadata: { author_login: "synthetic-outsider" },
  });
  await createTestEvent({
    organization_id: org.id,
    automation_id: Number(digest.automation_id),
    semantic_type: "summary",
    content: "Synthetic log progress",
    created_at: new Date("2026-01-01T00:40:00Z"),
    metadata: {
      automation_output: "log_progress",
      namespace: "synthetic-production",
      checkpoint_key: `product-activity-digest:${digest.automation_id}:synthetic-production`,
      recent_windows: [
        {
          window_start: "2026-01-01T00:20:00.000Z",
          window_end: "2026-01-01T00:40:00.000Z",
          http_server_errors: "5",
        },
      ],
    },
  });
  const rawSource = readFileSync(
    new URL("../team-alerts.reaction.ts", import.meta.url),
    "utf8"
  );
  const settings = {
    teamGithub: ["synthetic-team"],
    digestAutomationId: String(digest.automation_id),
    namespace: "synthetic-production",
    sourceConnection: "synthetic-alert-source",
    legacyFeedId: 701,
    signupCatchupStart: "2026-01-01T00:00:00.000Z",
    cutoverEnd: "2026-01-01T01:00:00.000Z",
  };
  const module = teamAlertsModule(rawSource, settings);
  const created = await client.automations.create({
    slug: "github-external-activity-alert",
    name: "Synthetic alerts",
    managed_agent_id: agent.agentId,
    prompt: "Legacy fixture",
    triggers: [{ kind: "schedule", cron: "*/30 * * * *" }],
  });
  if (!("automation_id" in created))
    throw new Error("Expected legacy Automation");
  const id = Number(created.automation_id);
  const execution = {
    executor: { kind: "script", source: "export default async () => ({});" },
  };
  await db`UPDATE automations SET execution_config = ${db.json(execution)},
    next_window_start = '2026-01-01T00:30:00Z' WHERE id = ${id}`;
  const old = (
    (await client.automations.get({
      automation_id: String(id),
    })) as AutomationReadback
  ).automation;
  const baseline = {
    version: old.version,
    owner: agent.agentId,
    execution_config: execution,
    delivery_target: old.delivery_target ?? null,
    triggers: old.triggers,
  };
  await expect(
    configureTeamAlerts(
      client,
      String(id),
      rawSource,
      { ...settings, cutoverEnd: "2026-01-01T00:15:00.000Z" },
      baseline
    )
  ).rejects.toThrow("cutover must include");
  await client.automations.update({
    automation_id: String(id),
    triggers: old.triggers,
  });
  await configureTeamAlerts(client, String(id), rawSource, settings, baseline);
  const [migrated] =
    await db`SELECT managed_agent_id, execution_config, next_window_start, triggers, reaction_script_compiled
    FROM automations WHERE id = ${id}`;
  expect(migrated.managed_agent_id).toBe(agent.agentId);
  expect(migrated.execution_config).toBeNull();
  expect(migrated.triggers).toEqual(old.triggers);
  expect(new Date(migrated.next_window_start).toISOString()).toBe(
    "2026-01-01T00:30:00.000Z"
  );
  // An existing signup delivery has the same organization-wide idempotency key.
  await client.notifications.send({
    title: "Existing signup",
    body: "Previously notified",
    idempotency_key: `signup:701:signup:${user.id}`,
  });
  const run = await createAutomationRun({
    organizationId: org.id,
    agentId: agent.agentId,
    automationId: id,
    windowStart: "2026-01-01T00:30:00.000Z",
    windowEnd: "2026-01-01T01:00:00.000Z",
    dispatchSource: "manual",
  });
  const [queued] =
    await db`SELECT approved_input FROM runs WHERE id = ${run.runId}`;
  expect(queued.approved_input.automation_script.has_analysis).toBe(false);
  expect(queued.approved_input.executor.kind).toBe("script");
  expect(queued.approved_input.executor.source).toBe(
    migrated.reaction_script_compiled
  );
  const context = {
    window: {
      automation_id: id,
      run_id: run.runId,
      window_start: "2026-01-01T00:30:00.000Z",
      window_end: "2026-01-01T01:00:00.000Z",
    },
    automation: {
      id,
      slug: "synthetic-team-alerts",
      name: "Synthetic alerts",
      version: 1,
    },
    organization_id: org.id,
    organization_slug: org.slug,
    trigger_signals: [],
    entities: [],
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await executeAutomationScript({
      compiledScript: queued.approved_input.executor.source,
      context,
      env: { ENVIRONMENT: "test" },
    });
    expect(result, result.error).toMatchObject({ success: true });
  }
  const notifications =
    await db`SELECT metadata->>'_lobu_idempotency_key' AS key FROM events
    WHERE organization_id = ${org.id} AND semantic_type = 'notification' ORDER BY id`;
  expect(notifications.map((row) => row.key).sort()).toEqual(
    [
      `signup:701:signup:${user.id}`,
      `signup:701:signup:${second.id}`,
      "gh-external:synthetic-issue",
      "prod-5xx:2026-01-01T00:40:00.000Z",
    ].sort()
  );
  expect(
    await db`SELECT id FROM events WHERE origin_type = 'row'`
  ).toHaveLength(0);
}, 60_000);

it("purges only an explicitly retired feed after inventory and preserves sources and reports", async () => {
  const { user, org } = await seedOwnerContext();
  const db = getTestDb();
  const connection = await createTestConnection({
    organization_id: org.id,
    connector_key: "postgres",
    slug: "synthetic-retired-source",
    createDefaultFeed: false,
    created_by: user.id,
  });
  const [feed] =
    await db`INSERT INTO feeds (organization_id, connection_id, feed_key, status, config)
    VALUES (${org.id}, ${connection.id}, 'query', 'active', '{}') RETURNING id`;
  const copied = await createTestEvent({
    organization_id: org.id,
    connection_id: connection.id,
    feed_id: Number(feed.id),
    origin_type: "row",
    semantic_type: "row",
    content: "Copied source fact",
    embedding: Array(768).fill(0),
  });
  const original = await createTestEvent({
    organization_id: org.id,
    content: "Original audit evidence",
    origin_type: "tool_invocation",
    semantic_type: "audit",
  });
  const report = await createTestEvent({
    organization_id: org.id,
    content: "Retained report",
    semantic_type: "summary",
  });
  const url = new URL(process.env.DATABASE_URL!);
  const execute = (extra: string[] = []) =>
    execFileAsync(
      "psql",
      [
        "-X",
        "-At",
        "-v",
        `workspace_slug=${org.slug}`,
        "-v",
        "connection_slug=synthetic-retired-source",
        "-v",
        `feed_id=${feed.id}`,
        ...extra,
        "-f",
        fileURLToPath(
          new URL("../scripts/purge-retired-activity.sql", import.meta.url)
        ),
      ],
      {
        env: {
          ...process.env,
          PGHOST: url.hostname,
          PGPORT: url.port,
          PGUSER: url.username,
          PGPASSWORD: url.password,
          PGDATABASE: url.pathname.slice(1),
          PGSSLMODE: "disable",
        },
      }
    );
  expect((await execute()).stdout).toContain("copied_events|1|");
  await expect(
    execute(["-v", "apply=true", "-v", "expected_rows=1"])
  ).rejects.toThrow("Retire the feed");
  await db`UPDATE feeds SET deleted_at = NOW(), status = 'paused' WHERE id = ${feed.id}`;
  await expect(
    execute(["-v", "apply=true", "-v", "expected_rows=2"])
  ).rejects.toThrow("Count changed");
  expect(await db`SELECT id FROM events WHERE id = ${copied.id}`).toHaveLength(
    1
  );
  const result = await execute(["-v", "apply=true", "-v", "expected_rows=1"]);
  expect(result.stdout).toContain("remaining_copies|0");
  expect(result.stdout).toContain("remaining_vectors|0");
  expect(
    await db`SELECT id FROM events WHERE id IN (${original.id}, ${report.id})`
  ).toHaveLength(2);
  expect(await db`SELECT id FROM "user" WHERE id = ${user.id}`).toHaveLength(1);
  expect(
    await db`SELECT event_id FROM event_embeddings WHERE event_id = ${copied.id}`
  ).toHaveLength(0);
}, 60_000);
