/**
 * Automation material-change digest delivery (#3663).
 *
 * The optional built-in digest fires after a successful run with material
 * entity changes, through the Automation's explicit `delivery_target` bound
 * channel — reusing the existing notification pipeline (event idempotency +
 * `deliver-notification` task) so retries and replays never duplicate the
 * durable handoff/event and a delivery failure never replays entity writes.
 *
 * The digest task only QUEUES: history records `digest_queued` with the
 * linked notification event + delivery task identity. The actual channel post
 * happens in `deliverNotificationTask`, observable via the existing delivery
 * task runs row + the event's `metadata.delivery` receipts — never a parallel
 * subsystem, and never a false `digest_delivered` here.
 *
 * Proves:
 *   1. A successful zero-material-change run enqueues/sends nothing.
 *   2. A material-change run enqueues exactly one digest task; running it
 *      queues one notification + delivery task (no post yet); running the
 *      delivery task posts exactly once with a durable receipt.
 *   3. Retry/replay (digest task re-run incl. concurrent, `complete_window`
 *      replay) creates no second handoff/event and no extra post within
 *      receipt semantics.
  *   4. A changed destination records `digest_failed` then throws for a bounded
  *      scheduler retry (`maxAttempts: 3` — not infinite) while the source run
  *      stays completed; rebinding to the exact snapshot recovers without
  *      replaying the window.
 *   5. A stale-but-matching binding (snapshot intact, channel unresolvable)
 *      throws for a visible scheduler retry and recovers when rebound.
 *   6. A cleared destination settles as skipped, never reroutes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_DIGEST_TASK,
  AUTOMATION_DIGEST_TASK_QUEUE,
  NOTIFICATION_DELIVERY_TASK,
} from "../../../scheduled/task-definitions";
import {
  automationDigestTaskKey,
} from "../../../automations/digest";
import type { AutomationDigestTaskPayload } from "../../../automations/digest-enqueue";
import { runAutomationDigestTask } from "../../../automations/digest-task";
import type { Env } from "../../../index";
import { __setChatInstanceManagerForTests } from "../../../lobu/gateway";
import {
  createNotificationForUsers,
  deliverNotificationTask,
} from "../../../notifications/service";
import { createAutomationRun } from "../../../runs/queue-service";
import { computePendingWindow } from "../../../utils/window-utils";
import { createTestAutomationSubscription } from "../../setup/automation-subscriptions";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
  createTestAgent,
  createTestEntity,
  insertChatConnectionRow,
} from "../../setup/test-fixtures";
import { TestApiClient, TestWorkspace } from "../../setup/test-mcp-client";

const OUTPUTS = {
  problems: { entity: "topic", key: ["category", "name"] },
};

const TOPIC_RECORD_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string" },
    name: { type: "string" },
    severity: { type: "string" },
  },
  additionalProperties: true,
};

const MATERIAL_EXTRACTED_DATA = {
  problems: [
    { category: "Stability", name: "App Crashes" },
    { category: "Performance", name: "Slow Loading" },
  ],
};

async function setupDigestAutomation() {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({ name: "Digest Org" });
  const ownerUserId = workspace.users.owner.id;

  const parentEntity = await createTestEntity({
    name: "Digest Parent",
    organization_id: workspace.org.id,
    created_by: ownerUserId,
  });
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, metadata_schema, created_at, updated_at)
    VALUES (${workspace.org.id}, 'topic', 'Topic', ${sql.json(TOPIC_RECORD_SCHEMA)}, current_timestamp, current_timestamp)
    ON CONFLICT DO NOTHING
  `;
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: "digest-agent",
    name: "Digest Agent",
  });

  await insertChatConnectionRow({
    id: "slackinst-digest",
    organizationId: workspace.org.id,
    agentId: null,
    platform: "slack",
    metadata: { teamId: "T_DIGEST" },
  });
  const [connection] = await sql<{ id: number }>`
    SELECT id FROM connections
    WHERE organization_id = ${workspace.org.id}
      AND slug = 'slackinst-digest'
  `;
  const connectionId = Number(connection.id);
  await createTestAutomationSubscription({
    organizationId: workspace.org.id,
    agentId: agent.agentId,
    connectionId,
    platform: "slack",
    channelId: "slack:C_DIGEST",
    teamId: "T_DIGEST",
    configuredBy: ownerUserId,
  });

  const automation = (await workspace.owner.automations.create({
    entity_id: parentEntity.id,
    slug: "digest-automation",
    name: "Digest Automation",
    prompt: "Extract problems for {{entities}}.",
    outputs: OUTPUTS,
    triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
    managed_agent_id: agent.agentId,
    delivery_target: {
      connection_id: connectionId,
      channel_id: "slack:C_DIGEST",
    },
  })) as { automation_id: string };
  const automationId = Number(automation.automation_id);
  await sql`
    UPDATE automations SET next_run_at = NOW() - INTERVAL '10 minutes'
    WHERE id = ${automationId}
  `;

  const api = await TestApiClient.for({
    organizationId: workspace.org.id,
    userId: ownerUserId,
    memberRole: "owner",
  });
  return {
    sql,
    workspace,
    api,
    agent,
    automationId,
    connectionId,
    parentEntityId: parentEntity.id,
  };
}

type DigestCtx = Awaited<ReturnType<typeof setupDigestAutomation>>;

async function queueRunningRun(ctx: DigestCtx) {
  const { windowStart, windowEnd } = await computePendingWindow(
    ctx.sql as never,
    ctx.automationId,
  );
  const queued = await createAutomationRun({
    organizationId: ctx.workspace.org.id,
    automationId: ctx.automationId,
    agentId: ctx.agent.agentId,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    dispatchSource: "scheduled",
  });
  await ctx.sql`
    UPDATE runs SET status = 'running', claimed_at = NOW(), claimed_by = 'digest-test'
    WHERE id = ${queued.runId}
  `;
  return queued.runId;
}

async function readWindowToken(ctx: DigestCtx, runId: number) {
  const content = (await ctx.api.knowledge.read({
    automation_id: ctx.automationId,
    run_id: runId,
  })) as { window_token: string };
  return content.window_token;
}

function digestTasks(sql: DigestCtx["sql"], runId: number) {
  return sql`
    SELECT id, status, action_key, action_input, idempotency_key, queue_name, organization_id,
           automation_id, parent_run_id
    FROM runs
    WHERE run_type = 'task'
      AND action_key = ${AUTOMATION_DIGEST_TASK}
      AND parent_run_id = ${runId}
    ORDER BY id DESC
  `;
}

function digestPayload(task: { action_input: unknown }) {
  return (task.action_input as { payload: AutomationDigestTaskPayload }).payload;
}

describe("automation material-change digest", () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterEach(() => {
    __setChatInstanceManagerForTests(null);
  });

  it("a successful zero-material-change run enqueues and sends nothing", async () => {
    const ctx = await setupDigestAutomation();
    const post = vi.fn(async () => ({ messageId: "m1", threadId: "t1" }));
    __setChatInstanceManagerForTests({ postMessageToChannel: post });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);
    await ctx.api.automations.completeWindow({
      automation_id: String(ctx.automationId),
      run_id: runId,
      window_token: token,
      extracted_data: { problems: [] },
    });

    expect(await digestTasks(ctx.sql, runId)).toHaveLength(0);
    const reactions = await ctx.sql`
      SELECT id FROM automation_reactions
      WHERE source_run_id = ${runId} AND tool_name = 'automation_digest'
    `;
    expect(reactions).toHaveLength(0);
    const notifications = await ctx.sql`
      SELECT id FROM events
      WHERE organization_id = ${ctx.workspace.org.id}
        AND metadata->>'notification_type' = 'generic'
        AND automation_id = ${ctx.automationId}
    `;
    expect(notifications).toHaveLength(0);
    expect(post).not.toHaveBeenCalled();
  });

  it("a material-change run enqueues one digest, queues one notification, and posts once via delivery", async () => {
    const ctx = await setupDigestAutomation();
    const post = vi.fn(async () => ({ messageId: "m1", threadId: "t1" }));
    __setChatInstanceManagerForTests({ postMessageToChannel: post });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);
    await ctx.api.automations.completeWindow({
      automation_id: String(ctx.automationId),
      run_id: runId,
      window_token: token,
      extracted_data: MATERIAL_EXTRACTED_DATA,
    });

    // One durable handoff on its own rollout-safe lane, keyed by source run +
    // destination + fingerprint — the window committed it, nothing ran yet.
    const tasks = await digestTasks(ctx.sql, runId);
    expect(tasks).toHaveLength(1);
    expect(String(tasks[0].status)).toBe("pending");
    expect(String(tasks[0].queue_name)).toBe(AUTOMATION_DIGEST_TASK_QUEUE);
    const payload = digestPayload(tasks[0]);
    expect(payload).toMatchObject({
      organizationId: ctx.workspace.org.id,
      automationId: ctx.automationId,
      sourceRunId: runId,
      connectionId: ctx.connectionId,
      channelId: "slack:C_DIGEST",
    });
    expect(payload.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(tasks[0].idempotency_key).toBe(
      automationDigestTaskKey({
        sourceRunId: runId,
        connectionId: ctx.connectionId,
        channelId: "slack:C_DIGEST",
        fingerprint: payload.fingerprint,
      }),
    );
    expect(post).not.toHaveBeenCalled();

    const outcome = await runAutomationDigestTask(
      payload,
      {} as Env,
      Number(tasks[0].id),
    );
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("expected success");

    // The digest task only QUEUES the notification + its delivery task; the
    // post itself happens on the separate delivery task, so no post and no
    // delivery receipt exist yet.
    expect(post).not.toHaveBeenCalled();
    const [notification] = await ctx.sql<{
      id: number;
      title: string;
      payload_text: string | null;
      metadata: Record<string, unknown>;
    }>`
      SELECT id, title, payload_text, metadata FROM events
      WHERE organization_id = ${ctx.workspace.org.id}
        AND automation_id = ${ctx.automationId}
        AND metadata->>'notification_type' = 'generic'
    `;
    expect(notification.title).toContain("2 new + 0 updated");
    expect(String(notification.payload_text)).toContain("App Crashes");
    expect(String(notification.metadata._lobu_idempotency_key)).toContain(
      `automation:${ctx.automationId}:run:${runId}:digest`,
    );
    expect(outcome.eventId).toBe(Number(notification.id));
    // A queued destination is not evidence of provider acceptance.
    expect(notification.metadata.delivery).toMatchObject([
      { attempts: [{ status: "queued", provider_message_id: null }] },
    ]);

    // The queued delivery task is the existing notification path, linked from
    // the digest outcome and history.
    const deliveryTasks = await ctx.sql<{ id: number; status: string }>`
      SELECT id, status FROM runs
      WHERE run_type = 'task'
        AND action_key = ${NOTIFICATION_DELIVERY_TASK}
        AND idempotency_key = ${`${NOTIFICATION_DELIVERY_TASK}:${notification.id}`}
    `;
    expect(deliveryTasks).toHaveLength(1);
    expect(outcome.deliveryTaskId).toBe(Number(deliveryTasks[0].id));

    // Run history records QUEUED (not delivered) with valid digest-task-run
    // lineage and the linked notification event/task identity.
    const [logged] = await ctx.sql<{
      reaction_type: string;
      run_id: number | null;
      tool_args: Record<string, unknown>;
    }>`
      SELECT reaction_type, run_id, tool_args FROM automation_reactions
      WHERE source_run_id = ${runId} AND tool_name = 'automation_digest'
      ORDER BY id DESC LIMIT 1
    `;
    expect(logged.reaction_type).toBe("digest_queued");
    expect(Number(logged.run_id)).toBe(Number(tasks[0].id));
    expect(Number((logged.tool_args as Record<string, unknown>).notification_event_id)).toBe(
      Number(notification.id),
    );
    expect(Number((logged.tool_args as Record<string, unknown>).delivery_task_id)).toBe(
      Number(deliveryTasks[0].id),
    );

    // Actual delivery posts exactly once and stamps a durable receipt.
    await deliverNotificationTask({
      organizationId: ctx.workspace.org.id,
      eventId: Number(notification.id),
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[1]).toBe("slack:C_DIGEST");
    const posted = post.mock.calls[0]?.[2] as { markdown?: string };
    expect(String(posted?.markdown ?? "")).toContain("App Crashes");
    const [afterDelivery] = await ctx.sql<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM events WHERE id = ${Number(notification.id)}
    `;
    const deliveries = (afterDelivery.metadata as Record<string, unknown>).delivery;
    expect(Array.isArray(deliveries)).toBe(true);
    expect((deliveries as unknown[])).toHaveLength(1);
  });

  it("retry and replay do not duplicate the digest handoff, event, or post", async () => {
    const ctx = await setupDigestAutomation();
    const post = vi.fn(async () => ({ messageId: "m1", threadId: "t1" }));
    __setChatInstanceManagerForTests({ postMessageToChannel: post });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);
    await ctx.api.automations.completeWindow({
      automation_id: String(ctx.automationId),
      run_id: runId,
      window_token: token,
      extracted_data: MATERIAL_EXTRACTED_DATA,
    });
    const [task] = await digestTasks(ctx.sql, runId);
    const payload = digestPayload(task);

    // Concurrent digest-task retries serialize on the runId lineage edge:
    // one notification event, one queued history row.
    const [first, concurrent] = await Promise.all([
      runAutomationDigestTask(payload, {} as Env, Number(task.id)),
      runAutomationDigestTask(payload, {} as Env, Number(task.id)),
    ]);
    expect(first.status).toBe("success");
    expect(concurrent.status).toBe("success");
    const queuedReactions = await ctx.sql<{ id: number }>`
      SELECT id FROM automation_reactions
      WHERE source_run_id = ${runId}
        AND tool_name = 'automation_digest'
        AND reaction_type = 'digest_queued'
    `;
    expect(queuedReactions).toHaveLength(1);

    // An idempotent `complete_window` replay queues no second handoff.
    const replay = (await ctx.api.automations.completeWindow({
      automation_id: String(ctx.automationId),
      run_id: runId,
      window_token: token,
      extracted_data: MATERIAL_EXTRACTED_DATA,
    })) as { completed_now: boolean };
    expect(replay.completed_now).toBe(false);
    expect(await digestTasks(ctx.sql, runId)).toHaveLength(1);

    // A serial digest-task retry resolves to the same notification event, and
    // the delivery task's receipts keep the channel post at exactly one.
    const second = await runAutomationDigestTask(
      payload,
      {} as Env,
      Number(task.id),
    );
    expect(second.status).toBe("success");
    const notifications = await ctx.sql<{ id: number }>`
      SELECT id FROM events
      WHERE organization_id = ${ctx.workspace.org.id}
        AND automation_id = ${ctx.automationId}
        AND metadata->>'notification_type' = 'generic'
    `;
    expect(notifications).toHaveLength(1);
    const input = {
      organizationId: ctx.workspace.org.id,
      eventId: Number(notifications[0].id),
    };
    await deliverNotificationTask(input);
    await deliverNotificationTask(input);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a changed destination throws for retry, then recovers on rebind without replaying writes", async () => {
    const ctx = await setupDigestAutomation();
    const post = vi.fn(async () => ({ messageId: "m1", threadId: "t1" }));
    __setChatInstanceManagerForTests({ postMessageToChannel: post });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);
    await ctx.api.automations.completeWindow({
      automation_id: String(ctx.automationId),
      run_id: runId,
      window_token: token,
      extracted_data: MATERIAL_EXTRACTED_DATA,
    });
    const [task] = await digestTasks(ctx.sql, runId);
    const payload = digestPayload(task);

    // Break the binding AFTER commit by pointing the stored target elsewhere.
    // Fail closed: record `digest_failed` then THROW for a bounded scheduler
    // retry (`maxAttempts: 3`), never deliver to the superseded channel. A
    // bare return would settle the task successful with no production retry
    // path, so the throw is load-bearing.
    await ctx.sql`
      UPDATE automations
      SET delivery_target = ${ctx.sql.json({ connection_id: ctx.connectionId, channel_id: "slack:C_GONE" })}
      WHERE id = ${ctx.automationId}
    `;
    await expect(
      runAutomationDigestTask(payload, {} as Env, Number(task.id)),
    ).rejects.toThrow(/destination changed/i);

    // The window stays completed, the entities stay committed, and nothing
    // was posted or queued as delivered.
    const [run] = await ctx.sql<{ status: string }>`
      SELECT status FROM runs WHERE id = ${runId}
    `;
    expect(String(run.status)).toBe("completed");
    const children = await ctx.sql`
      SELECT id FROM entities
      WHERE organization_id = ${ctx.workspace.org.id}
        AND parent_id = ${ctx.parentEntityId}
        AND deleted_at IS NULL
    `;
    expect(children).toHaveLength(2);
    expect(post).not.toHaveBeenCalled();
    const queued = await ctx.sql`
      SELECT id FROM automation_reactions
      WHERE source_run_id = ${runId} AND reaction_type = 'digest_queued'
    `;
    expect(queued).toHaveLength(0);
    const [failed] = await ctx.sql<{
      reaction_type: string;
      run_id: number | null;
    }>`
      SELECT reaction_type, run_id FROM automation_reactions
      WHERE source_run_id = ${runId} AND reaction_type = 'digest_failed'
      ORDER BY id DESC LIMIT 1
    `;
    expect(failed.reaction_type).toBe("digest_failed");
    expect(Number(failed.run_id)).toBe(Number(task.id));

    // Rebind to the EXACT snapshot and retry the SAME task — representing a
    // scheduler retry within its bounded budget: one queued
    // digest, no window replay, no duplicate entities — then one post.
    await ctx.sql`
      UPDATE automations
      SET delivery_target = ${ctx.sql.json({ connection_id: ctx.connectionId, channel_id: "slack:C_DIGEST" })}
      WHERE id = ${ctx.automationId}
    `;
    const recovered = await runAutomationDigestTask(
      payload,
      {} as Env,
      Number(task.id),
    );
    expect(recovered.status).toBe("success");
    const stillTwo = await ctx.sql`
      SELECT id FROM entities
      WHERE organization_id = ${ctx.workspace.org.id}
        AND parent_id = ${ctx.parentEntityId}
        AND deleted_at IS NULL
    `;
    expect(stillTwo).toHaveLength(2);
    const notifications = await ctx.sql<{ id: number }>`
      SELECT id FROM events
      WHERE organization_id = ${ctx.workspace.org.id}
        AND automation_id = ${ctx.automationId}
        AND metadata->>'notification_type' = 'generic'
    `;
    expect(notifications).toHaveLength(1);
    await deliverNotificationTask({
      organizationId: ctx.workspace.org.id,
      eventId: Number(notifications[0].id),
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a stale-but-matching binding throws for retry, then recovers without replaying writes", async () => {
    const ctx = await setupDigestAutomation();
    const post = vi.fn(async () => ({ messageId: "m1", threadId: "t1" }));
    __setChatInstanceManagerForTests({ postMessageToChannel: post });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);
    await ctx.api.automations.completeWindow({
      automation_id: String(ctx.automationId),
      run_id: runId,
      window_token: token,
      extracted_data: MATERIAL_EXTRACTED_DATA,
    });
    const [task] = await digestTasks(ctx.sql, runId);
    const payload = digestPayload(task);

    // Break the binding AFTER commit WITHOUT touching the snapshot: archive
    // the chat-link automation so the stored target no longer resolves. The
    // snapshot is intact, so this is transient — throw for a visible retry.
    // (The digest automation itself uses a schedule trigger, so the
    // message.created filter only touches the chat-link binding.)
    const linksBefore = await ctx.sql<{ id: number }>`
      SELECT id FROM automations
      WHERE organization_id = ${ctx.workspace.org.id}
        AND status = 'active'
        AND triggers::text LIKE '%message.created%'
    `;
    expect(linksBefore.length).toBeGreaterThan(0);
    await ctx.sql`
      UPDATE automations SET status = 'archived'
      WHERE organization_id = ${ctx.workspace.org.id}
        AND status = 'active'
        AND triggers::text LIKE '%message.created%'
    `;
    await expect(
      runAutomationDigestTask(payload, {} as Env, Number(task.id)),
    ).rejects.toThrow(/no longer available|unavailable/);

    // The window stays completed, the entities stay committed, and nothing
    // was posted or logged as queued.
    const [run] = await ctx.sql<{ status: string }>`
      SELECT status FROM runs WHERE id = ${runId}
    `;
    expect(String(run.status)).toBe("completed");
    const children = await ctx.sql`
      SELECT id FROM entities
      WHERE organization_id = ${ctx.workspace.org.id}
        AND parent_id = ${ctx.parentEntityId}
        AND deleted_at IS NULL
    `;
    expect(children).toHaveLength(2);
    expect(post).not.toHaveBeenCalled();
    const queued = await ctx.sql`
      SELECT id FROM automation_reactions
      WHERE source_run_id = ${runId} AND reaction_type = 'digest_queued'
    `;
    expect(queued).toHaveLength(0);

    // Restore the binding and retry the SAME task: one queued digest, no
    // window replay, no duplicate entities — then one post.
    await ctx.sql`
      UPDATE automations SET status = 'active'
      WHERE organization_id = ${ctx.workspace.org.id}
        AND status = 'archived'
        AND triggers::text LIKE '%message.created%'
    `;
    const recovered = await runAutomationDigestTask(
      payload,
      {} as Env,
      Number(task.id),
    );
    expect(recovered.status).toBe("success");
    const notifications = await ctx.sql<{ id: number }>`
      SELECT id FROM events
      WHERE organization_id = ${ctx.workspace.org.id}
        AND automation_id = ${ctx.automationId}
        AND metadata->>'notification_type' = 'generic'
    `;
    expect(notifications).toHaveLength(1);
    await deliverNotificationTask({
      organizationId: ctx.workspace.org.id,
      eventId: Number(notifications[0].id),
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a cleared destination settles as skipped and never reroutes", async () => {
    const ctx = await setupDigestAutomation();
    const post = vi.fn(async () => ({ messageId: "m1", threadId: "t1" }));
    __setChatInstanceManagerForTests({ postMessageToChannel: post });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);
    await ctx.api.automations.completeWindow({
      automation_id: String(ctx.automationId),
      run_id: runId,
      window_token: token,
      extracted_data: MATERIAL_EXTRACTED_DATA,
    });
    const [task] = await digestTasks(ctx.sql, runId);
    const payload = digestPayload(task);

    await ctx.sql`
      UPDATE automations SET delivery_target = NULL
      WHERE id = ${ctx.automationId}
    `;
    const outcome = await runAutomationDigestTask(
      payload,
      {} as Env,
      Number(task.id),
    );
    expect(outcome.status).toBe("skipped");
    expect(post).not.toHaveBeenCalled();
    const [logged] = await ctx.sql<{
      reaction_type: string;
      run_id: number | null;
    }>`
      SELECT reaction_type, run_id FROM automation_reactions
      WHERE source_run_id = ${runId} AND tool_name = 'automation_digest'
      ORDER BY id DESC LIMIT 1
    `;
    expect(logged.reaction_type).toBe("digest_skipped");
    expect(Number(logged.run_id)).toBe(Number(task.id));
    const [run] = await ctx.sql<{ status: string }>`
      SELECT status FROM runs WHERE id = ${runId}
    `;
    expect(String(run.status)).toBe("completed");
  });

  it("denied-only runs stay silent", async () => {
    const ctx = await setupDigestAutomation();
    const {
      registerMutationInterceptor,
      __resetMutationGateForTests,
    } = await import("../../../authz/entity-mutation-gate");
    // A REAL policy refusal (same interceptor fixture as the fail-closed
    // suite): material extraction validates, promotion denies every create,
    // so the run's change set is denied-only — not merely empty.
    registerMutationInterceptor({
      name: "test-deny-digest-creates",
      evaluate: async (req) =>
        req.action === "create"
          ? { outcome: "deny", reason: "quota exceeded" }
          : null,
    });
    try {
      __setChatInstanceManagerForTests({
        postMessageToChannel: vi.fn(async () => ({
          messageId: "m1",
          threadId: "t1",
        })),
      });
      const runId = await queueRunningRun(ctx);
      const token = await readWindowToken(ctx, runId);
      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        run_id: runId,
        window_token: token,
        extracted_data: MATERIAL_EXTRACTED_DATA,
      });
      // Proof the run really carried refusals: the persisted change set
      // records the denied writes.
      const changeSets = await ctx.sql<{ title: string }>`
        SELECT title FROM events
        WHERE organization_id = ${ctx.workspace.org.id}
          AND metadata->>'_lobu_idempotency_key' =
            ${`automation:${ctx.automationId}:run:${runId}:change_set`}
      `;
      expect(changeSets).toHaveLength(1);
      expect(changeSets[0].title).toContain("denied");
      // And a denied-only change set still enqueues/sends no digest.
      expect(await digestTasks(ctx.sql, runId)).toHaveLength(0);
    } finally {
      __resetMutationGateForTests();
    }
  });

  it("digest helpers are deterministic", async () => {
    const {
      buildAutomationDigestContent,
      fingerprintMaterialDigestChanges,
    } = await import("../../../automations/digest");
    const changes = [
      { entityId: 2, name: "Beta", kind: "updated" as const },
      { entityId: 1, name: "Alpha", kind: "created" as const },
    ];
    expect(fingerprintMaterialDigestChanges(changes)).toBe(
      fingerprintMaterialDigestChanges([...changes].reverse()),
    );
    const content = buildAutomationDigestContent({
      automationName: "Digest Automation",
      changes,
    });
    expect(content.title).toBe("Digest Automation applied 1 new + 1 updated");
    expect(content.body).toContain("Alpha");
  });

  it("notification creation is idempotent for the digest key, serially and concurrently, with one event for all admins", async () => {
    const ctx = await setupDigestAutomation();
    const post = vi.fn(async () => ({ messageId: "m1", threadId: "t1" }));
    __setChatInstanceManagerForTests({ postMessageToChannel: post });
    const runId = await queueRunningRun(ctx);
    const key = `automation:${ctx.automationId}:run:${runId}:digest:fp:${ctx.connectionId}:slack:C_DIGEST`;
    // Admin/owner fan-out is ONE event + N targets, not one event per user.
    const userIds = [ctx.workspace.users.owner.id, ctx.workspace.users.owner.id];
    const first = await createNotificationForUsers(userIds, {
      organizationId: ctx.workspace.org.id,
      type: "generic",
      title: "Digest",
      body: "changes",
      idempotencyKey: key,
      automationId: ctx.automationId,
      runId,
    });
    const second = await createNotificationForUsers(
      [ctx.workspace.users.owner.id],
      {
        organizationId: ctx.workspace.org.id,
        type: "generic",
        title: "Digest",
        body: "changes",
        idempotencyKey: key,
        automationId: ctx.automationId,
        runId,
      },
    );
    expect(first.eventId).not.toBeNull();
    expect(second.eventId).toBe(first.eventId);
    expect(second.created).toBe(false);

    // Concurrent retries of the same producer key resolve to the same event.
    const [a, b] = await Promise.all([
      createNotificationForUsers([ctx.workspace.users.owner.id], {
        organizationId: ctx.workspace.org.id,
        type: "generic",
        title: "Digest",
        body: "changes",
        idempotencyKey: key,
        automationId: ctx.automationId,
        runId,
      }),
      createNotificationForUsers([ctx.workspace.users.owner.id], {
        organizationId: ctx.workspace.org.id,
        type: "generic",
        title: "Digest",
        body: "changes",
        idempotencyKey: key,
        automationId: ctx.automationId,
        runId,
      }),
    ]);
    expect(a.eventId).toBe(first.eventId);
    expect(b.eventId).toBe(first.eventId);

    const events = await ctx.sql<{ id: number }>`
      SELECT id FROM events
      WHERE organization_id = ${ctx.workspace.org.id}
        AND metadata->>'_lobu_idempotency_key' = ${key}
    `;
    expect(events).toHaveLength(1);

    // One chat send for the one event, regardless of target count.
    await deliverNotificationTask({
      organizationId: ctx.workspace.org.id,
      eventId: Number(first.eventId),
    });
    await deliverNotificationTask({
      organizationId: ctx.workspace.org.id,
      eventId: Number(first.eventId),
    });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
