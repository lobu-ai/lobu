import { readFileSync } from "node:fs";
import { beforeEach, expect, test } from "vitest";
import { createTestAutomationSubscription } from "../../../packages/server/src/__tests__/setup/automation-subscriptions";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestAgent,
  createTestConnection,
  createTestEvent,
  insertChatConnectionRow,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import { TestWorkspace } from "../../../packages/server/src/__tests__/setup/test-mcp-client";
import {
  productActivityPrompt,
  productActivitySources,
} from "../product-activity-digest.prompt";
import { configureProductActivityDigest } from "../scripts/configure-product-activity";

beforeEach(cleanupTestDatabase);

test("external cutover preserves bound Slack delivery and the checkpoint", async () => {
  const workspace = await TestWorkspace.create({
    name: "Synthetic digest cutover",
  });
  const sql = getTestDb();
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: "synthetic-digest-delivery",
  });
  await insertChatConnectionRow({
    id: "slackinst-synthetic-digest",
    organizationId: workspace.org.id,
    agentId: null,
    platform: "slack",
    metadata: { teamId: "T_SYNTHETIC_DIGEST" },
  });
  const [connection] = await sql`
    SELECT id FROM connections WHERE organization_id = ${workspace.org.id}
      AND slug = 'slackinst-synthetic-digest'
  `;
  const delivery = {
    connection_id: Number(connection.id),
    channel_id: "slack:C_SYNTHETIC_DIGEST",
  };
  await createTestAutomationSubscription({
    organizationId: workspace.org.id,
    agentId: agent.agentId,
    connectionId: delivery.connection_id,
    platform: "slack",
    channelId: delivery.channel_id,
    teamId: "T_SYNTHETIC_DIGEST",
    configuredBy: workspace.users.owner.id,
  });
  const created = await workspace.owner.automations.create({
    slug: "product-activity-digest",
    name: "Synthetic scheduled digest",
    managed_agent_id: agent.agentId,
    delivery_target: delivery,
    triggers: [{ kind: "schedule", cron: "*/20 * * * *" }],
    execution_config: {
      executor: { kind: "script", source: "export default async () => {};" },
    },
    sources: [
      { name: "reaction_window", query: "SELECT * FROM events WHERE FALSE" },
    ],
  });
  const id = String(created.automation_id);
  const checkpoint = new Date(Date.now() - 60_000).toISOString();
  await sql`UPDATE automations SET next_window_start = ${checkpoint} WHERE id = ${id}`;
  const reaction = readFileSync(
    new URL("../product-activity-digest.reaction.ts", import.meta.url),
    "utf8"
  );

  await configureProductActivityDigest(workspace.owner, id, reaction);

  const [stored] = await sql`
    SELECT managed_agent_id, delivery_target, triggers, execution_config,
      next_window_start, next_run_at, schedule
    FROM automations WHERE id = ${id}
  `;
  expect(stored).toMatchObject({
    managed_agent_id: agent.agentId,
    delivery_target: delivery,
    triggers: [
      {
        kind: "schedule",
        cron: "*/20 * * * *",
        timezone: "UTC",
        skip_if_unchanged: false,
      },
    ],
    execution_config: { executor: { kind: "external" } },
    schedule: "*/20 * * * *",
  });
  expect(new Date(stored.next_window_start).toISOString()).toBe(checkpoint);

  expect(new Date(stored.next_run_at).getTime()).toBeGreaterThan(Date.now());
  await sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '1 second' WHERE id = ${id}`;
  const activity = (await workspace.owner.operations.listActivity({
    kinds: ["automation_due"],
  })) as { items: Array<{ automation_id: number }> };
  expect(activity.items.map((item) => item.automation_id)).toContain(
    Number(id)
  );

  // Keeping the delivery principal must still permit the external MCP lifecycle.
  const claimed = await workspace.owner.automations.claimNextWindow({
    automation_id: id,
  });
  expect(claimed.context.window_start).toBe(checkpoint);
  expect(claimed.context.content).toEqual([]);
  await workspace.owner.automations.completeWindow({
    automation_id: id,
    run_id: claimed.run_id,
    window_token: claimed.context.window_token,
    extracted_data: { digests: [] },
    client_id: "synthetic-external-client",
  });
  const [advanced] =
    await sql`SELECT next_window_start, next_run_at FROM automations WHERE id = ${id}`;
  expect(new Date(advanced.next_window_start).toISOString()).toBe(
    claimed.context.window_end
  );
  expect(new Date(advanced.next_run_at).getTime()).toBeGreaterThan(Date.now());
  const after = (await workspace.owner.operations.listActivity({
    kinds: ["automation_due"],
  })) as { items: unknown[] };
  expect(after.items).toEqual([]);
});

test("hands off log counts without samples while preserving activity and pageable checkpoints", async () => {
  const workspace = await TestWorkspace.create({
    name: "Synthetic query digest",
  });
  const sql = getTestDb();
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: "synthetic-query-digest",
  });
  const created = await workspace.owner.automations.create({
    slug: "synthetic-query-digest",
    name: "Synthetic query digest",
    managed_agent_id: agent.agentId,
    prompt: productActivityPrompt,
    sources: productActivitySources,
    outputs: { digests: { event: "summary" } },
  });
  const id = String(created.automation_id);
  const start = new Date(Date.now() - 60_000);
  await sql`UPDATE automations SET next_window_start = ${start} WHERE id = ${id}`;
  const summary = {
    errors: 2,
    warnings: 30,
    http_client_errors: 1,
    http_server_errors: 0,
    namespace: "synthetic-production",
    window_start: start.toISOString(),
    window_end: new Date(start.getTime() + 20_000).toISOString(),
  };
  for (const [slug, metadata] of [
    [
      "lobu-production-logs",
      {
        ...summary,
        error_samples: ["synthetic-raw-error"],
        warning_samples: ["synthetic-raw-warning"],
        http_samples: ["synthetic-raw-http"],
        future_diagnostic: "synthetic-raw-future-field",
      },
    ],
    ["lobu-product-activity-db", { user_name: "Synthetic New User" }],
  ] as const) {
    const connection = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: "synthetic.digest-source",
      createDefaultFeed: false,
      slug,
      created_by: workspace.users.owner.id,
    });
    await createTestEvent({
      organization_id: workspace.org.id,
      connection_id: connection.id,
      content:
        slug === "lobu-production-logs"
          ? "2 errors, 30 warnings"
          : "Synthetic signup",
      metadata,
      created_at: new Date(start.getTime() + 30_000),
    });
  }
  const first = await workspace.owner.automations.claimNextWindow({
    automation_id: id,
    limit: 1,
  });
  expect(first.context.page.has_more).toBe(true);
  const cursor = first.context.page.next_cursor;
  if (!cursor) throw new Error("Expected a second content page");
  const second = await workspace.owner.automations.claimNextWindow({
    automation_id: id,
    run_id: first.run_id,
    limit: 1,
    before_occurred_at: cursor.occurred_at,
    before_id: cursor.id,
  });
  expect(second.context.page.has_more).toBe(false);
  const rows = [...first.context.content, ...second.context.content];
  expect(rows).toHaveLength(2);
  expect(
    rows.find((row) => row.payload_text === "2 errors, 30 warnings")?.metadata
  ).toEqual(summary);
  expect(
    rows.find((row) => row.payload_text === "Synthetic signup")?.metadata
  ).toEqual({ user_name: "Synthetic New User" });
  expect(JSON.stringify([first.context, second.context])).not.toContain(
    "synthetic-raw-"
  );
  await workspace.owner.automations.completeWindow({
    automation_id: id,
    run_id: first.run_id,
    window_tokens: [first.context.window_token, second.context.window_token],
    extracted_data: { digests: [] },
  });
  const [advanced] =
    await sql`SELECT next_window_start FROM automations WHERE id = ${id}`;
  expect(new Date(advanced.next_window_start).toISOString()).toBe(
    first.context.window_end
  );
});
