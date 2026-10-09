import { readFileSync } from "node:fs";
import { beforeEach, expect, test } from "vitest";
import { createTestAutomationSubscription } from "../../../packages/server/src/__tests__/setup/automation-subscriptions";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestAgent,
  insertChatConnectionRow,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import { TestWorkspace } from "../../../packages/server/src/__tests__/setup/test-mcp-client";
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
    triggers: [],
    execution_config: null,
    next_run_at: null,
    schedule: null,
  });
  expect(new Date(stored.next_window_start).toISOString()).toBe(checkpoint);

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
    await sql`SELECT next_window_start FROM automations WHERE id = ${id}`;
  expect(new Date(advanced.next_window_start).toISOString()).toBe(
    claimed.context.window_end
  );
});
