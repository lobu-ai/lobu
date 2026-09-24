import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { activateWorkspaceEventTask } from "../../../packages/server/src/automations/workspace-event";
import { runAutomationScriptTask } from "../../../packages/server/src/automations/script-task";
import { dispatchPendingAutomationRuns } from "../../../packages/server/src/automations/automation";
import type { WorkspaceEventActivationTaskPayload } from "../../../packages/server/src/automations/workspace-event-contract";
import { invokeTemplateEventAction } from "../../../packages/server/src/interactions/template-event-actions";
import type { Env } from "../../../packages/server/src/index";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import { createTestAgent } from "../../../packages/server/src/__tests__/setup/test-fixtures";
import { TestWorkspace } from "../../../packages/server/src/__tests__/setup/test-mcp-client";
import config from "../lobu.config";

const definition = config.automations?.find(
  (item) => item.slug === "poll-vote-reducer"
);
if (!definition) throw new Error("Poll reducer definition is missing");
const reducer = readFileSync(
  new URL("../poll-vote.reaction.ts", import.meta.url),
  "utf8"
);
const TEST_ENV = {
  ENVIRONMENT: "test",
  JWT_SECRET: "synthetic-poll-integration-secret",
} as Env;

// Real schemas, authenticated SDK writes, durable activation, run-bound reads,
// completion and isolated script execution. The task claims are controlled;
// dispatch/serialization and every SDK read/write use the real runtime.
async function setup(
  quorum = 10,
  closesAt = new Date(Date.now() + 3_600_000).toISOString(),
  failAfter?: "poll_response_recorded" | "poll_opened" | "poll_closed"
) {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({
    name: "Synthetic Poll Lifecycle",
  });
  const api = workspace.owner;
  for (const key of ["poll", "poll-response"]) {
    const type = config.entities?.find((item) => item.key === key);
    if (!type) throw new Error(`Missing example type ${key}`);
    await api.entity_schema.createType({
      slug: key,
      name: type.name,
      metadata_schema: {
        type: "object",
        properties: type.properties,
        required: type.required ?? [],
      },
      event_kinds: type.eventKinds,
    });
  }
  const state = {
    question: "Choose a synthetic release lane",
    options: ["A", "B"],
    status: "open",
    quorum,
    closes_at: closesAt,
    results: [
      { option: "A", count: 0 },
      { option: "B", count: 0 },
    ],
    response_count: 0,
  };
  const created = await api.entities.create({
    entity_type: "poll",
    name: "Synthetic ballot",
    metadata: state,
  });
  const entityId = Number(created.entity?.id);
  expect(entityId).toBeGreaterThan(0);
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: "synthetic-poll-owner",
  });
  expect(definition!.executor).toMatchObject({
    kind: "scriptSource",
    path: "./poll-vote.reaction.ts",
  });
  expect(definition!.reaction).toBeNull();
  // Inject an uncertain response after the real database commit. The receipt
  // makes the second execution observable as a replay, so it fails only once.
  const sourceCode = failAfter
    ? reducer.replace(
        "export default async function reducePollVote",
        "async function reducePollVote"
      ) +
      `
    export default async function(ctx, client) {
      await reducePollVote(ctx, {
        query: (...args) => client.query(...args),
        entities: client.entities,
        log: (...args) => client.log(...args),
        knowledge: {
          read: (...args) => client.knowledge.read(...args),
          save: async (input) => {
            const result = await client.knowledge.save(input);
            if (input.semantic_type === ${JSON.stringify(failAfter)} && result.created) {
              throw new Error("Synthetic response lost after durable projection");
            }
            return result;
          }
        }
      });
    }`
    : reducer;
  const automation = await api.automations.create({
    slug: "synthetic-poll-reducer",
    name: "Synthetic poll reducer",
    managed_agent_id: agent.agentId,
    triggers: definition!.triggers,
    execution_config: { executor: { kind: "script", source: sourceCode } },
  });
  const automationId = Number(automation.automation_id);
  const source = await api.knowledge.save({
    entity_ids: [entityId],
    semantic_type: "poll_opened",
    content: "Choose A or B",
    title: state.question,
    payload_type: "empty",
    metadata: state,
  });

  async function head() {
    const rows =
      await sql`SELECT id, semantic_type, metadata FROM events WHERE organization_id = ${workspace.org.id} AND entity_ids @> ARRAY[${entityId}]::bigint[] AND semantic_type IN ('poll_opened','poll_closed') AND superseded_by IS NULL ORDER BY id`;
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }
  async function vote(
    actor: "owner" | "member",
    choice: string,
    interactionId: string,
    sourceEventId?: number
  ) {
    const userId = workspace.users[actor].id;
    return invokeTemplateEventAction({
      organizationId: workspace.org.id,
      sourceEventId: sourceEventId ?? Number((await head()).id),
      action: "vote",
      value: choice,
      interactionId,
      surface: "web",
      actor: { platform: "lobu", platformUserId: userId, userId },
    });
  }
  async function activate(eventId: number) {
    const [task] =
      await sql`SELECT action_input FROM runs WHERE organization_id = ${workspace.org.id} AND action_key = 'activate-workspace-event' AND (action_input->'payload'->>'eventId')::bigint = ${eventId}`;
    expect(task).toBeDefined();
    const result = await activateWorkspaceEventTask(
      task!.action_input.payload as WorkspaceEventActivationTaskPayload
    );
    expect(result).toMatchObject({ matched: 1, queued: 1 });
    const [run] =
      await sql`SELECT id FROM runs WHERE automation_id = ${automationId} AND run_type = 'automation' AND approved_input->'trigger_signal'->>'event_id' = ${String(eventId)} ORDER BY id`;
    expect(run).toBeDefined();
    return Number(run!.id);
  }
  async function status(runId: number) {
    const [run] =
      await sql`SELECT status, error_message, model_used FROM runs WHERE id = ${runId}`;
    return run!;
  }
  async function execute(runId: number, attempt = 1) {
    await dispatchPendingAutomationRuns({ runIds: [runId] });
    const [task] =
      await sql`SELECT id FROM runs WHERE parent_run_id = ${runId} AND action_key = 'automation-script'`;
    expect(task).toBeDefined();
    await sql`UPDATE runs SET status = 'claimed', claimed_by = 'synthetic-poll-queue', claimed_at = now() WHERE id = ${task!.id}`;
    await runAutomationScriptTask(
      { organizationId: workspace.org.id, automationId, sourceRunId: runId },
      TEST_ENV,
      Number(task!.id),
      attempt
    );
    expect(await status(runId)).toMatchObject({
      status: "completed",
      error_message: null,
      model_used: "script",
    });
  }
  async function reduce(eventId: number) {
    const runId = await activate(eventId);
    await execute(runId);
    return runId;
  }
  async function projection() {
    const [entity] =
      await sql`SELECT metadata FROM entities WHERE id = ${entityId}`;
    return entity!.metadata;
  }
  return {
    sql,
    workspace,
    api,
    source,
    entityId,
    automationId,
    head,
    vote,
    activate,
    status,
    execute,
    reduce,
    projection,
  };
}

describe("personal poll lifecycle through persistent runtime", () => {
  beforeEach(cleanupTestDatabase);

  it("counts two actors and replaces a changed vote without adding a participant", async () => {
    const h = await setup();
    const [first, second] = await Promise.all([
      h.vote("owner", "A", "owner-initial", h.source.id),
      h.vote("member", "B", "member-initial", h.source.id),
    ]);
    await h.reduce(first.eventId);
    await h.reduce(second.eventId);
    expect((await h.head()).metadata).toMatchObject({
      response_count: 2,
      results: [
        { option: "A", count: 1 },
        { option: "B", count: 1 },
      ],
    });
    const changed = await h.vote("owner", "B", "owner-changed");
    const run = await h.reduce(changed.eventId);
    await h.execute(run, 2);
    const expected = {
      response_count: 2,
      results: [
        { option: "A", count: 0 },
        { option: "B", count: 2 },
      ],
    };
    expect((await h.head()).metadata).toMatchObject(expected);
    expect(await h.projection()).toMatchObject(expected);
  });

  it("serializes independently accepted votes through the durable Automation queue", async () => {
    const h = await setup();
    const votes = await Promise.all([
      h.vote("owner", "A", "owner-concurrent", h.source.id),
      h.vote("member", "B", "member-concurrent", h.source.id),
    ]);
    const runs = await Promise.all(
      votes.map((vote) => h.activate(vote.eventId))
    );
    await Promise.all(
      runs.map((runId) => dispatchPendingAutomationRuns({ runIds: [runId] }))
    );
    const statuses = await Promise.all(runs.map(h.status));
    expect(statuses.map((run) => run.status).sort()).toEqual([
      "pending",
      "running",
    ]);
    const first = runs[statuses.findIndex((run) => run.status === "running")]!;
    const second = runs.find((run) => run !== first)!;
    await h.execute(first);
    await h.execute(second);
    expect((await h.head()).metadata).toMatchObject({
      response_count: 2,
      results: [
        { option: "A", count: 1 },
        { option: "B", count: 1 },
      ],
    });
    expect(await h.projection()).toMatchObject({ response_count: 2 });
  });

  it.each([
    "poll_response_recorded",
    "poll_opened",
  ] as const)("recovers after committing %s without releasing the next vote", async (failAfter) => {
    const h = await setup(10, undefined, failAfter);
    const first = await h.vote("owner", "A", "owner-recovery");
    const second = await h.vote("member", "B", "member-recovery");
    const firstRun = await h.activate(first.eventId);
    const secondRun = await h.activate(second.eventId);
    await expect(h.execute(firstRun)).rejects.toThrow(
      "Synthetic response lost"
    );
    expect(await h.status(firstRun)).toMatchObject({ status: "running" });
    await dispatchPendingAutomationRuns({ runIds: [secondRun] });
    expect(await h.status(secondRun)).toMatchObject({ status: "pending" });
    await h.execute(firstRun, 2);
    await expect(h.execute(secondRun)).rejects.toThrow(
      "Synthetic response lost"
    );
    await h.execute(secondRun, 2);
    const expected = {
      response_count: 2,
      results: [
        { option: "A", count: 1 },
        { option: "B", count: 1 },
      ],
    };
    expect((await h.head()).metadata).toMatchObject(expected);
    expect(await h.projection()).toMatchObject(expected);
  });

  it("closes at quorum, includes already accepted votes, and rejects fresh closed-card clicks", async () => {
    const h = await setup(1);
    const first = await h.vote("owner", "A", "owner-quorum");
    const second = await h.vote("member", "B", "member-before-close");
    await h.reduce(first.eventId);
    expect((await h.head()).metadata).toMatchObject({
      status: "closed",
      close_reason: "quorum",
      response_count: 1,
    });
    await h.reduce(second.eventId);
    const expected = {
      status: "closed",
      close_reason: "quorum",
      response_count: 2,
      results: [
        { option: "A", count: 1 },
        { option: "B", count: 1 },
      ],
    };
    expect((await h.head()).metadata).toMatchObject(expected);
    expect(await h.projection()).toMatchObject(expected);
    expect(
      await h.vote("owner", "A", "owner-quorum", h.source.id)
    ).toMatchObject({ eventId: first.eventId, created: false });
    await expect(
      h.vote("owner", "B", "fresh-stale", h.source.id)
    ).rejects.toThrow();
    await expect(h.vote("owner", "B", "fresh-closed")).rejects.toThrow();
    const votes =
      await h.sql`SELECT id FROM events WHERE organization_id = ${h.workspace.org.id} AND semantic_type = 'poll_vote_cast'`;
    expect(votes).toHaveLength(2);
  });

  it("reconciles an uncertain response after a durable quorum close", async () => {
    const h = await setup(1, undefined, "poll_closed");
    const vote = await h.vote("owner", "A", "owner-close-recovery");
    const runId = await h.activate(vote.eventId);
    // The reducer catches the uncertain save, rereads the terminal winner,
    // and repairs the entity projection in the same attempt.
    await h.execute(runId);
    expect((await h.head()).metadata).toMatchObject({
      status: "closed",
      response_count: 1,
    });
    await h.execute(runId, 2);
    expect((await h.head()).metadata).toMatchObject(await h.projection());
    expect(await h.projection()).not.toHaveProperty("_lobu_idempotency_key");
    const responses =
      await h.sql`SELECT id FROM events WHERE organization_id = ${h.workspace.org.id} AND semantic_type = 'poll_response_recorded'`;
    expect(responses).toHaveLength(1);
  });

  it("does not count a vote received after the deadline or reopen a closed poll", async () => {
    const h = await setup(10, new Date(Date.now() - 60_000).toISOString());
    const late = await h.vote("owner", "A", "owner-late");
    const runId = await h.reduce(late.eventId);
    const expected = {
      status: "closed",
      close_reason: "deadline",
      response_count: 0,
    };
    expect((await h.head()).metadata).toMatchObject(expected);
    expect(await h.projection()).toMatchObject(expected);
    await h.execute(runId, 2);
    expect((await h.head()).metadata).toMatchObject(expected);
    const responses =
      await h.sql`SELECT id FROM events WHERE organization_id = ${h.workspace.org.id} AND semantic_type = 'poll_response_recorded'`;
    expect(responses).toHaveLength(0);
  });

  it("reconciles a pre-deadline vote processed after the deadline follow-up closes the poll", async () => {
    const deadline = Date.now() + 2_000;
    const h = await setup(10, new Date(deadline).toISOString());
    const vote = await h.vote("owner", "A", "owner-before-deadline");
    const [accepted] =
      await h.sql`SELECT occurred_at FROM events WHERE id = ${vote.eventId}`;
    expect(new Date(accepted!.occurred_at).getTime()).toBeLessThan(deadline);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, deadline - Date.now() + 10))
    );
    const head = await h.head();
    await h.api.knowledge.save({
      entity_ids: [h.entityId],
      semantic_type: "poll_closed",
      payload_type: "empty",
      content: "Synthetic deadline follow-up",
      supersedes_event_id: Number(head.id),
      idempotency_key: `poll-close:${h.entityId}`,
      metadata: {
        ...head.metadata,
        status: "closed",
        close_reason: "deadline",
        closed_at: new Date().toISOString(),
      },
    });
    await h.reduce(vote.eventId);
    const expected = {
      status: "closed",
      close_reason: "deadline",
      response_count: 1,
      results: [
        { option: "A", count: 1 },
        { option: "B", count: 0 },
      ],
    };
    expect((await h.head()).metadata).toMatchObject(expected);
    expect(await h.projection()).toMatchObject(expected);
  });
});
