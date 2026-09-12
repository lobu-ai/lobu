import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAutomationReactionTask } from "../../../packages/server/src/automations/reaction-task";
import { compileEntityRule } from "../../../packages/server/src/authz/entity-rule-executor";
import type { Env } from "../../../packages/server/src/index";
import { __setChatInstanceManagerForTests } from "../../../packages/server/src/lobu/gateway";
import { deliverNotificationTask } from "../../../packages/server/src/notifications/service";
import { createAutomationRun } from "../../../packages/server/src/runs/queue-service";
import { computePendingWindow } from "../../../packages/server/src/utils/window-utils";
import { executeTool } from "../../../packages/server/src/tools/execute";
import { createTestAutomationSubscription } from "../../../packages/server/src/__tests__/setup/automation-subscriptions";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestAgent,
  createTestEntity,
  createTestEvent,
  insertChatConnectionRow,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import {
  TestApiClient,
  TestWorkspace,
} from "../../../packages/server/src/__tests__/setup/test-mcp-client";
import config from "../lobu.config";

// Exercise the real source-read, completion, promotion, isolated-reaction,
// notification, and delivery persistence paths. Scheduling/claiming, extracted
// model output, and the external chat transport are controlled test inputs.
const definition = config.automations?.find(
  (a) => a.slug === "hourly-task-collaborator"
);
if (!definition) {
  throw new Error("Hourly task collaborator config is missing");
}
const taskOutput = definition.outputs?.tasks;
if (!taskOutput || !("key" in taskOutput)) {
  throw new Error("Hourly task collaborator task output is missing");
}
const taskType = config.entities?.find((e) => e.key === "task");
if (!taskType) {
  throw new Error("Task entity config is missing");
}
const taskRulesPath = taskType.rules?.path;
if (!taskRulesPath) {
  throw new Error("Task entity rules are missing");
}
const taskRulesUrl = new URL(taskRulesPath, new URL("../", import.meta.url));
const automationPrompt = definition.prompt;
const taskOutputKey = taskOutput.key;
const taskProperties = taskType.properties;
const taskRequired = taskType.required ?? [];
const reaction = readFileSync(
  new URL("../task-builder.reaction.ts", import.meta.url),
  "utf8"
);
const task = {
  source_scope: "connector:synthetic-task-fixture",
  source_origin_id: "synthetic-verification-request",
  task_key: "verify-calculation",
  action: "Verify the synthetic calculation",
  status: "backlog",
  owner: "Synthetic Owner",
  priority: "medium",
  source: "https://example.invalid/request/verification",
  rationale: "The owner explicitly requested a calculation check.",
  agent_help: {
    summary: "Check the calculation independently.",
    prompt:
      "Compute 17 times 19 and independently verify it; save the evidence.",
  },
};

async function setup() {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({
    name: "Synthetic Task Lifecycle",
  });
  const parent = await createTestEntity({
    name: "Synthetic Task Board",
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  await sql`INSERT INTO entity_types (organization_id, slug, name, metadata_schema)
    VALUES (${workspace.org.id}, 'task', 'Task', ${sql.json({ type: "object", properties: taskProperties, required: taskRequired } as never)})`;
  const rules = readFileSync(taskRulesUrl, "utf8");
  const compiledRules = await compileEntityRule(rules);
  await sql`UPDATE entity_types SET rules_compiled = ${compiledRules} WHERE organization_id = ${workspace.org.id} AND slug = 'task'`;
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: "personal-agent",
  });
  await insertChatConnectionRow({
    id: "synthetic-task-chat",
    organizationId: workspace.org.id,
    agentId: agent.agentId,
    platform: "slack",
    status: "active",
    settings: {},
  });
  await createTestAutomationSubscription({
    organizationId: workspace.org.id,
    agentId: agent.agentId,
    connectionSlug: "agentconn-synthetic-task-chat",
    channelId: "slack:C_SYNTHETIC_TASK",
    teamId: "T_SYNTHETIC",
    configuredBy: workspace.users.owner.id,
  });
  const post = vi.fn(async () => ({
    messageId: "synthetic-receipt",
    threadId: "slack:C_SYNTHETIC_TASK:synthetic-receipt",
  }));
  __setChatInstanceManagerForTests({ postMessageToChannel: post });
  const created = (await workspace.owner.automations.create({
    entity_id: parent.id,
    slug: "synthetic-task-lifecycle",
    name: "Synthetic Task Lifecycle",
    prompt: automationPrompt,
    outputs: {
      tasks: {
        entity: "task",
        key: taskOutputKey,
        name: ["action"],
      },
    },
    triggers: [
      {
        kind: "schedule",
        cron: "0 * * * *",
        execution: "window",
        active_run: "coalesce",
        skip_if_unchanged: false,
      },
    ],
    managed_agent_id: agent.agentId,
  })) as { automation_id: string };
  const automationId = Number(created.automation_id);
  const api = await TestApiClient.for({
    organizationId: workspace.org.id,
    userId: workspace.users.owner.id,
    memberRole: "owner",
  });
  await api.automations.setReactionScript({
    automation_id: String(automationId),
    reaction_script: reaction,
  });
  await sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '10 minutes' WHERE id = ${automationId}`;
  await createTestEvent({
    entity_id: parent.id,
    organization_id: workspace.org.id,
    content: "Synthetic Owner asks for an independent check of 17 times 19.",
    origin_id: task.source_origin_id,
    occurred_at: new Date(Date.now() - 60_000),
  });

  async function complete(tasks: Record<string, unknown>[]) {
    const { windowStart, windowEnd } = await computePendingWindow(
      sql as never,
      automationId
    );
    const queued = await createAutomationRun({
      organizationId: workspace.org.id,
      automationId,
      agentId: agent.agentId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      dispatchSource: "scheduled",
    });
    await sql`UPDATE runs SET status = 'running', claimed_at = NOW(), claimed_by = 'synthetic-task-worker' WHERE id = ${queued.runId}`;
    const read = (await api.knowledge.read({
      automation_id: automationId,
      run_id: queued.runId,
    })) as { window_token: string };
    expect(read.window_token).toBeTruthy();
    const input = {
      automation_id: String(automationId),
      run_id: queued.runId,
      window_token: read.window_token,
      extracted_data: { tasks },
    };
    const result = (await api.automations.completeWindow(input)) as {
      reaction_task_run_id: number;
    };
    expect(result.reaction_task_run_id).toBeGreaterThan(0);
    return {
      runId: queued.runId,
      input,
      taskRunId: result.reaction_task_run_id,
    };
  }
  async function react(run: Awaited<ReturnType<typeof complete>>) {
    const result = await runAutomationReactionTask(
      {
        organizationId: workspace.org.id,
        automationId,
        sourceRunId: run.runId,
      },
      {} as Env,
      run.taskRunId
    );
    expect(result).toEqual({ status: "success" });
  }
  const entities = () =>
    sql`SELECT e.id, e.metadata, e.field_controls FROM entities e JOIN entity_types t ON t.id = e.entity_type_id WHERE e.organization_id = ${workspace.org.id} AND t.slug = 'task' AND e.deleted_at IS NULL ORDER BY e.id`;
  const notices = () =>
    sql`SELECT id, metadata FROM events WHERE organization_id = ${workspace.org.id} AND metadata->>'_lobu_idempotency_key' LIKE 'task-builder:task:%' ORDER BY id`;
  async function deliver() {
    for (const notice of await notices())
      await deliverNotificationTask({
        organizationId: workspace.org.id,
        eventId: Number(notice.id),
      });
  }
  return {
    sql,
    workspace,
    api,
    automationId,
    complete,
    react,
    entities,
    notices,
    deliver,
    post,
  };
}

describe("personal task lifecycle through persistent runtime", () => {
  beforeEach(cleanupTestDatabase);
  afterEach(() => __setChatInstanceManagerForTests(null));

  it("commits one task, one inbox notification and one receipt across completion, reaction and delivery retries", async () => {
    const h = await setup();
    const run = await h.complete([task]);
    await h.api.automations.completeWindow(run.input);
    expect(await h.entities()).toHaveLength(1);
    expect((await h.entities())[0].metadata.source).toBe(task.source);
    expect(await h.notices()).toHaveLength(0);
    await h.react(run);
    await h.react(run);
    const notices = await h.notices();
    expect(notices).toHaveLength(1);
    const [saved] = await h.entities();
    expect(saved.metadata).toMatchObject(task);
    const promoted = (await h.workspace.owner.automations.manage({
      action: "list_promoted",
      automation_id: String(h.automationId),
    })) as { entities: Array<{ id: number }> };
    expect(promoted.entities.map((e) => e.id)).toContain(Number(saved.id));
    const url = new URL(
      notices[0].metadata.resource_url,
      "https://example.invalid"
    );
    expect(url.searchParams.get("prompt")).toContain(
      `Review task #${saved.id}`
    );
    expect(url.searchParams.get("prompt")).toContain(
      "Do not act on a closed task"
    );
    await h.deliver();
    await h.deliver();
    expect(h.post).toHaveBeenCalledTimes(1);
    expect((await h.notices())[0].metadata.delivery).toHaveLength(1);
  });

  it("alerts on A to B to A, but not unchanged output or reaction replay", async () => {
    const h = await setup();
    for (const priority of ["medium", "high", "medium", "medium"]) {
      const run = await h.complete([{ ...task, priority }]);
      await h.react(run);
      await h.react(run);
    }
    expect(await h.entities()).toHaveLength(1);
    expect(await h.notices()).toHaveLength(3);
    await h.deliver();
    expect(h.post).toHaveBeenCalledTimes(3);
  });

  it("preserves a human-owned proposal and does not notify a held replacement", async () => {
    const h = await setup();
    await h.react(await h.complete([task]));
    const [saved] = await h.entities();
    const humanHelp = {
      summary: "Only check the arithmetic.",
      prompt: "Do not perform any other work.",
    };
    await h.workspace.owner.entities.update({
      entity_id: Number(saved.id),
      metadata: { agent_help: humanHelp },
      field_note: "Synthetic owner instruction",
    });
    await h.react(await h.complete([task]));
    const [current] = await h.entities();
    expect(current.metadata.agent_help).toEqual(humanHelp);
    expect(current.field_controls.agent_help.set_by).toBe(
      h.workspace.users.owner.id
    );
    expect(Object.keys(current.field_controls)).toEqual(["agent_help"]);
    expect(await h.notices()).toHaveLength(1);
  });

  it.each([
    "done",
    "dismissed",
  ])("suppresses a queued reaction after the owner marks the task %s", async (status) => {
    const h = await setup();
    const run = await h.complete([task]);
    const [saved] = await h.entities();
    await h.workspace.owner.entities.update({
      entity_id: Number(saved.id),
      metadata: { status, agent_help: null },
    });
    await h.react(run);
    expect(await h.notices()).toHaveLength(0);
    await h.react(await h.complete([task]));
    expect((await h.entities())[0].metadata.status).toBe(status);
    expect(await h.notices()).toHaveLength(0);
  });

  it("persists later resolution without reopening or sending another offer", async () => {
    const h = await setup();
    await h.react(await h.complete([task]));
    await h.react(
      await h.complete([
        {
          ...task,
          status: "done",
          agent_help: null,
          rationale:
            "Verified 17 times 19 = 323; independently 380 minus 57 = 323.",
        },
      ])
    );
    expect((await h.entities())[0].metadata.status).toBe("done");
    await h.react(await h.complete([task]));
    expect((await h.entities())[0].metadata.status).toBe("done");
    expect(await h.notices()).toHaveLength(1);
    await h.react(await h.complete([]));
    expect((await h.entities())[0].metadata.status).toBe("done");
  });

  it("recovers a provider failure without losing or duplicating the committed notice", async () => {
    const h = await setup();
    await h.react(await h.complete([task]));
    h.post.mockRejectedValueOnce(new Error("synthetic provider outage"));
    await expect(h.deliver()).rejects.toThrow("synthetic provider outage");
    expect(await h.notices()).toHaveLength(1);
    await h.deliver();
    await h.deliver();
    expect(h.post).toHaveBeenCalledTimes(2);
    expect((await h.notices())[0].metadata.delivery).toHaveLength(1);
  });

  it("lets a human explicitly approve reopening a closed task", async () => {
    const h = await setup();
    await h.react(
      await h.complete([{ ...task, status: "done", agent_help: null }])
    );
    await h.react(await h.complete([task]));
    expect((await h.entities())[0].metadata.status).toBe("done");
    const [pending] =
      await h.sql`SELECT id FROM runs WHERE organization_id = ${h.workspace.org.id} AND action_key = 'entity_field_change' AND approval_status = 'pending'`;
    expect(pending).toBeDefined();
    const approved = (await executeTool(
      "manage_operations",
      { action: "approve", run_id: Number(pending.id) },
      { ENVIRONMENT: "test", DATABASE_URL: process.env.DATABASE_URL } as Env,
      {
        organizationId: h.workspace.org.id,
        tokenOrganizationId: h.workspace.org.id,
        userId: h.workspace.users.owner.id,
        memberRole: "owner",
        agentId: null,
        requestedAgentId: null,
        isAuthenticated: true,
        clientId: null,
        scopes: ["mcp:read", "mcp:write", "mcp:admin"],
        tokenType: "oauth",
        requestUrl: "http://localhost/api/synthetic",
        baseUrl: "",
        scopedToOrg: true,
        allowCrossOrg: false,
        grantedOrganizationIds: [h.workspace.org.id],
        directSearchFederation: false,
      }
    )) as { approved: boolean };
    expect(approved.approved).toBe(true);
    expect((await h.entities())[0].metadata.status).toBe("backlog");
  });

  it("keeps a queued snapshot pointing at the task for a fresh-state check after closure", async () => {
    const h = await setup();
    await h.react(await h.complete([task]));
    const [saved] = await h.entities();
    await h.workspace.owner.entities.update({
      entity_id: Number(saved.id),
      metadata: { status: "done", agent_help: null },
    });
    await h.deliver();
    // Notifications are durable snapshots, not permission to execute. A late
    // delivery remains possible, so the handoff tells the agent to reread state.
    expect(h.post).toHaveBeenCalledTimes(1);
    const [notice] = await h.notices();
    const prompt = new URL(
      notice.metadata.resource_url,
      "https://example.invalid"
    ).searchParams.get("prompt");
    expect(prompt).toContain(`Review task #${saved.id}`);
    expect(prompt).toContain("Read its current status");
    expect(prompt).toContain("Do not act on a closed task");
    expect((await h.entities())[0].metadata.status).toBe("done");
  });
});
