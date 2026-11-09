import { readFileSync } from "node:fs";
import type { AutomationClaimNextWindowResult } from "@lobu/core/contracts/tools/manage-automations";
import { beforeEach, expect, test } from "vitest";
import { materializeDueAutomationRuns } from "../../../packages/server/src/automations/automation";
import type { DbClient } from "../../../packages/server/src/db/client";
import { claimPendingAutomationRun } from "../../../packages/server/src/runs/queue-service";
import { buildClientSDK } from "../../../packages/server/src/sandbox/client-sdk";
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
  ownerToolContext,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import { TestWorkspace } from "../../../packages/server/src/__tests__/setup/test-mcp-client";
import { configureProductActivityDigest } from "../scripts/configure-product-activity";

beforeEach(cleanupTestDatabase);

async function migrationBaseline(client: TestWorkspace["owner"], id: string) {
  const { automation } = await client.automations.get({ automation_id: id });
  return {
    version: automation.version,
    execution_config: automation.execution_config ?? null,
    reaction_script: automation.reaction_script ?? null,
    triggers: automation.triggers,
    delivery_target: automation.delivery_target ?? null,
    device_worker_id: automation.device_worker_id ?? null,
    agent_kind: automation.agent_kind ?? null,
  };
}

async function startNativeWindow(
  workspace: TestWorkspace,
  id: string,
  agentId: string,
  limit?: number
) {
  const sql = getTestDb();
  await materializeDueAutomationRuns(
    { ENVIRONMENT: "test" },
    sql as unknown as DbClient,
    Number(id)
  );
  const [run] = await sql`
    SELECT id FROM runs WHERE automation_id = ${id}
      AND run_type = 'automation' AND status = 'pending'
    ORDER BY id LIMIT 1
  `;
  if (!run) throw new Error("Expected the native schedule to enqueue a run");
  const runId = Number(run.id);
  const claimed = await sql.begin((tx) =>
    claimPendingAutomationRun(tx as unknown as DbClient, {
      runId,
      automationId: Number(id),
      claimedBy: `lobu:${agentId}`,
      status: "running",
    })
  );
  expect(claimed).toBe(true);
  const context = (await workspace.owner.knowledge.read({
    automation_id: Number(id),
    run_id: runId,
    limit,
  })) as AutomationClaimNextWindowResult["context"];
  return { run_id: runId, context };
}

test("native cutover preserves bound Slack delivery and the checkpoint", async () => {
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
    prompt: "Synthetic legacy job.",
    sources: [
      { name: "reaction_window", query: "SELECT * FROM events WHERE FALSE" },
    ],
  });
  if (!("automation_id" in created))
    throw new Error("Expected the synthetic Automation to be created");
  const id = String(created.automation_id);
  const checkpoint = new Date(Date.now() - 60_000).toISOString();
  await sql`UPDATE automations SET next_window_start = ${checkpoint}, execution_config = ${sql.json({ executor: { kind: "external" } })} WHERE id = ${id}`;
  const reaction = readFileSync(
    new URL("../product-activity-digest.reaction.ts", import.meta.url),
    "utf8"
  );

  const reviewed = await migrationBaseline(workspace.owner, id);
  await expect(
    configureProductActivityDigest(
      workspace.owner,
      id,
      reaction,
      {
        namespace: "synthetic-production",
        logStart: "2026-10-01T00:00:00.000Z",
      },
      {
        managedAgentId: agent.agentId,
        baseline: { ...reviewed, version: reviewed.version + 1 },
      }
    )
  ).rejects.toThrow("configuration changed");
  await expect(
    configureProductActivityDigest(
      workspace.owner,
      id,
      reaction,
      {
        namespace: "synthetic-production",
        logStart: "2026-10-01T00:00:00.000Z",
      },
      { managedAgentId: "synthetic-other-owner", baseline: reviewed }
    )
  ).rejects.toThrow("preserve the existing owning agent");
  expect(await migrationBaseline(workspace.owner, id)).toEqual(reviewed);

  await configureProductActivityDigest(
    workspace.owner,
    id,
    reaction,
    {
      namespace: "synthetic-production",
      logStart: "2026-10-01T00:00:00.000Z",
    },
    {
      managedAgentId: agent.agentId,
      baseline: await migrationBaseline(workspace.owner, id),
    }
  );

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
    execution_config: null,
    schedule: "*/20 * * * *",
  });
  expect(new Date(stored.next_window_start).toISOString()).toBe(checkpoint);

  expect(new Date(stored.next_run_at).getTime()).toBeGreaterThan(Date.now());
  await sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '1 second' WHERE id = ${id}`;
  const activity = (await workspace.owner.operations.listActivity({
    kinds: ["automation_due"],
  })) as { items: Array<{ automation_id: number }> };
  expect(activity.items.map((item) => item.automation_id)).not.toContain(
    Number(id)
  );

  // The native scheduler queues the window; its agent reads and completes it.
  const claimed = await startNativeWindow(workspace, id, agent.agentId);
  expect(claimed.context.window_start).toBe(checkpoint);
  expect(claimed.context.content).toEqual([]);
  await workspace.owner.automations.completeWindow({
    automation_id: id,
    run_id: claimed.run_id,
    window_token: claimed.context.window_token,
    extracted_data: {
      digests: [],
      log_progress: [
        {
          content: "Checked synthetic-production through 00:20 UTC",
          metadata: {
            checkpoint_key: `product-activity-digest:${id}:synthetic-production`,
            namespace: "synthetic-production",
            window_end: "2026-10-01T00:20:00.000Z",
            recent_windows: [],
          },
        },
      ],
    },
    client_id: "synthetic-native-client",
  });
  const progress = await sql`
    SELECT metadata FROM events WHERE automation_id = ${id}
      AND metadata->>'automation_output' = 'log_progress'
  `;
  expect(progress).toHaveLength(1);
  expect(progress[0].metadata.window_end).toBe("2026-10-01T00:20:00.000Z");
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

test("native migration pauses cadence without changing a claimed definition", async () => {
  const workspace = await TestWorkspace.create({
    name: "Synthetic active digest",
  });
  const sql = getTestDb();
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: "synthetic-active-digest",
  });
  const created = await workspace.owner.automations.create({
    slug: "product-activity-digest",
    name: "Synthetic digest",
    managed_agent_id: agent.agentId,
    prompt: "Synthetic legacy digest",
    triggers: [
      { kind: "schedule", cron: "*/20 * * * *", skip_if_unchanged: false },
    ],
  });
  if (!("automation_id" in created))
    throw new Error("Expected a created Automation");
  const id = String(created.automation_id);
  await sql`UPDATE automations SET execution_config = ${sql.json({ executor: { kind: "external" } })}, next_run_at = NOW() - INTERVAL '1 second', next_window_start = NOW() - INTERVAL '1 minute' WHERE id = ${id}`;
  const claimed = await workspace.owner.automations.claimNextWindow({
    automation_id: id,
  });
  const baseline = await migrationBaseline(workspace.owner, id);
  await expect(
    configureProductActivityDigest(
      workspace.owner,
      id,
      readFileSync(
        new URL("../product-activity-digest.reaction.ts", import.meta.url),
        "utf8"
      ),
      {
        namespace: "synthetic-production",
        logStart: "2026-10-01T00:00:00.000Z",
      },
      { managedAgentId: agent.agentId, baseline }
    )
  ).rejects.toThrow("wait for the active digest run");
  const after = await migrationBaseline(workspace.owner, id);
  expect(after).toEqual({ ...baseline, triggers: [] });
  const [run] =
    await sql`SELECT status FROM runs WHERE id = ${Number(claimed.run_id)}`;
  expect(run.status).toBe("running");
});

test("ClickHouse progress survives completion retries and product pagination without a legacy feed", async () => {
  const workspace = await TestWorkspace.create({
    name: "Synthetic primary digest",
  });
  const sql = getTestDb();
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: "synthetic-query-digest",
  });
  const created = await workspace.owner.automations.create({
    slug: "product-activity-digest",
    name: "Synthetic query digest",
    prompt: "Synthetic pre-cutover processor",
    managed_agent_id: agent.agentId,
    sources: [{ name: "content", query: "SELECT * FROM events WHERE FALSE" }],
  });
  if (!("automation_id" in created))
    throw new Error("Expected the synthetic Automation to be created");
  const id = String(created.automation_id);
  await configureProductActivityDigest(
    workspace.owner,
    id,
    readFileSync(
      new URL("../product-activity-digest.reaction.ts", import.meta.url),
      "utf8"
    ),
    { namespace: "synthetic-production", logStart: "2026-10-01T00:00:00.000Z" },
    {
      managedAgentId: agent.agentId,
      baseline: await migrationBaseline(workspace.owner, id),
    }
  );
  const start = new Date(Date.now() - 60_000);
  await sql`UPDATE automations SET next_window_start = ${start}, next_run_at = NOW() - INTERVAL '1 second' WHERE id = ${id}`;
  for (const [slug, contents] of [
    ["synthetic-unlisted-connection", ["Unlisted source must not be consumed"]],
    [
      "lobu-product-activity-db",
      ["Synthetic signup", "Synthetic source connected"],
    ],
  ] as const) {
    const connection = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: "synthetic.digest-source",
      createDefaultFeed: false,
      slug,
      created_by: workspace.users.owner.id,
    });
    for (const content of contents)
      await createTestEvent({
        organization_id: workspace.org.id,
        connection_id: connection.id,
        content,
        metadata: { source: slug },
        created_at: new Date(start.getTime() + 30_000),
      });
  }
  const first = await startNativeWindow(workspace, id, agent.agentId, 1);
  expect(first.context.page.has_more).toBe(true);
  const cursor = first.context.page.next_cursor;
  if (!cursor) throw new Error("Expected a second product page");
  const second = (await workspace.owner.knowledge.read({
    automation_id: Number(id),
    run_id: first.run_id,
    limit: 1,
    before_occurred_at: cursor.occurred_at,
    before_id: cursor.id,
  })) as AutomationClaimNextWindowResult["context"];
  expect(second.page.has_more).toBe(false);
  expect(
    [...first.context.content, ...second.content]
      .map((row) => (row as { payload_text: string }).payload_text)
      .sort()
  ).toEqual(["Synthetic signup", "Synthetic source connected"]);
  const completion = {
    automation_id: id,
    run_id: first.run_id,
    window_tokens: [first.context.window_token, second.window_token],
  };
  const snapshot = {
    window_start: "2026-10-01T00:00:00.000Z",
    window_end: "2026-10-01T00:20:00.000Z",
    parsed_records: "9007199254740993",
    errors: "1",
    warnings: "0",
    http_client_errors: "0",
    http_server_errors: "0",
  };
  const progress = {
    content: "Checked the first production log window",
    metadata: {
      checkpoint_key: `product-activity-digest:${id}:synthetic-production`,
      namespace: "synthetic-production",
      window_end: snapshot.window_end,
      recent_windows: [snapshot],
    },
  };
  await expect(
    workspace.owner.automations.completeWindow({
      ...completion,
      extracted_data: {
        digests: [],
        log_progress: [
          {
            ...progress,
            metadata: {
              ...progress.metadata,
              recent_windows: [{ ...snapshot, errors: "-1" }],
            },
          },
        ],
      },
    })
  ).rejects.toThrow("extraction contract");
  const [unchanged] =
    await sql`SELECT next_window_start FROM automations WHERE id = ${id}`;
  expect(new Date(unchanged.next_window_start).toISOString()).toBe(
    start.toISOString()
  );
  expect(
    await sql`SELECT id FROM events WHERE automation_id = ${id}`
  ).toHaveLength(0);

  await workspace.owner.automations.completeWindow({
    ...completion,
    extracted_data: { digests: [], log_progress: [progress] },
  });
  const reader = buildClientSDK(
    ownerToolContext(workspace.org.id, workspace.users.owner.id),
    { ENVIRONMENT: "test" }
  );
  const readProgress = () =>
    reader.query(`
    SELECT id, metadata FROM events WHERE automation_id = ${Number(id)}
      AND semantic_type = 'summary' AND metadata->>'automation_output' = 'log_progress'
    ORDER BY created_at DESC, id DESC LIMIT 1
  `) as Promise<Array<{ id: number; metadata: typeof progress.metadata }>>;
  expect((await readProgress())[0].metadata).toMatchObject(progress.metadata);

  // A new processor uses persisted state, not the old claim's local variables.
  // ClickHouse failure is represented by no new progress, while product arrival
  // processing can still complete. The old log cursor must survive unchanged.
  await sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '1 second' WHERE id = ${id}`;
  const resumed = await startNativeWindow(workspace, id, agent.agentId);
  expect(resumed.context.window_start).toBe(first.context.window_end);
  expect(resumed.context.content).toEqual([]);
  const old = (await readProgress())[0];
  await workspace.owner.automations.completeWindow({
    automation_id: id,
    run_id: resumed.run_id,
    window_token: resumed.context.window_token,
    extracted_data: { digests: [], log_progress: [] },
  });
  expect(await readProgress()).toEqual([old]);

  // Rechecked late arrivals replace the keyed current head without erasing
  // history, and without moving the event-time cursor forward.
  await sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '1 second' WHERE id = ${id}`;
  const recheck = await startNativeWindow(workspace, id, agent.agentId);
  await workspace.owner.automations.completeWindow({
    automation_id: id,
    run_id: recheck.run_id,
    window_token: recheck.context.window_token,
    extracted_data: {
      digests: [],
      log_progress: [
        {
          ...progress,
          metadata: {
            ...progress.metadata,
            recent_windows: [{ ...snapshot, errors: "2" }],
          },
        },
      ],
    },
  });
  const latest = (await readProgress())[0];
  expect(latest.id).not.toBe(old.id);
  expect(latest.metadata.window_end).toBe(old.metadata.window_end);
  expect(latest.metadata.recent_windows[0].errors).toBe("2");
  const history =
    await sql`SELECT superseded_by FROM events WHERE id = ${old.id}`;
  expect(Number(history[0].superseded_by)).toBe(Number(latest.id));
  const [advanced] =
    await sql`SELECT next_window_start FROM automations WHERE id = ${id}`;
  expect(new Date(advanced.next_window_start).toISOString()).toBe(
    recheck.context.window_end
  );
});
