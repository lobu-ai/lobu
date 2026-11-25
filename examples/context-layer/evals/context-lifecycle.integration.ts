/**
 * Real Postgres, SDK authorization, preparation sandbox and durable outputs.
 * Completion data is scripted: this verifies mechanics, not model quality.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { materializeDueAutomationRuns } from "../../../packages/server/src/automations/automation";
import { runAutomationPreparationTask } from "../../../packages/server/src/automations/preparation-task";
import type { DbClient } from "../../../packages/server/src/db/client";
import type { Env } from "../../../packages/server/src/index";
import {
  claimPendingAutomationRun,
  createAutomationRun,
} from "../../../packages/server/src/runs/queue-service";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestAgent,
  createTestWorkspaceSkill,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import { TestWorkspace } from "../../../packages/server/src/__tests__/setup/test-mcp-client";
import type { MetricSnapshot } from "../context-summary.reaction";
import config from "../lobu.config";

const definition = config.automations!.find(
  (item) => item.slug === "current-metric-definition"
)!;
const analyst = config.agents!.find((item) => item.id === "analyst")!;
const metricType = config.entities!.find(
  (item) => item.key === "metric-definition"
)!;
const script = readFileSync(
  new URL("../context-summary.reaction.ts", import.meta.url),
  "utf8"
);
const START = "2026-08-01T00:00:00.000Z";
const FIRST_END = "2026-08-01T00:20:00.000Z";
const SECOND_END = "2026-08-01T00:40:00.000Z";
const ENV = { ENVIRONMENT: "test" } as Env;

interface WindowContext {
  window_token: string;
  sources: {
    metric_snapshot: MetricSnapshot[];
    definition_changes: Array<{ id: number }>;
  };
}

async function setup() {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({
    name: "Synthetic Metric Context",
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: "synthetic-metric-analyst",
  });
  await workspace.owner.entity_schema.createType({
    slug: metricType.key,
    name: metricType.name,
    event_kinds: metricType.eventKinds,
  });
  const { entity: metric } = (await workspace.owner.entities.create({
    name: "churn_rate",
    entity_type: metricType.key,
    metadata: { metric: "churn_rate" },
  })) as { entity: { id: number } };
  const skills = (analyst.skills ?? [])
    .filter((skill) => definition.skills?.includes(skill.name!))
    .map((skill) => ({ name: skill.name!, content: skill.content! }));
  for (const skill of skills) {
    await createTestWorkspaceSkill({
      organizationId: workspace.org.id,
      name: skill.name,
      content: skill.content,
      appliesTo: [{ kind: "agent", id: agent.agentId }],
    });
  }
  const created = (await workspace.owner.automations.create({
    slug: definition.slug,
    name: definition.name,
    prompt: definition.prompt,
    skills: skills.map((skill) => skill.name),
    managed_agent_id: agent.agentId,
    triggers: definition.triggers,
    sources: Object.entries(definition.sources ?? {}).map(([name, value]) => ({
      name,
      ...(typeof value === "string" ? { query: value } : value),
    })),
    outputs: definition.outputs,
    reaction_script: script,
  })) as { automation_id: string };
  const automationId = Number(created.automation_id);
  await sql`UPDATE automations SET next_window_start = ${START}::timestamptz,
    next_run_at = now() + interval '1 day' WHERE id = ${automationId}`;

  async function save(content: string, createdAt: string, previous?: number) {
    const result = (await workspace.owner.knowledge.save({
      content,
      semantic_type: "definition",
      entity_ids: [metric.id],
      // Both original and correction occurred before all processing windows.
      occurred_at: "2025-01-01T00:00:00.000Z",
      metadata: {
        version: previous ? "v2" : "v1",
        effective_from: "2025-01-01",
      },
      ...(previous ? { supersedes_event_id: previous } : {}),
    })) as { id: number };
    // Control only the synthetic arrival clock; writes/supersession use the SDK.
    await sql`UPDATE events SET created_at = ${createdAt}::timestamptz
      WHERE id = ${result.id}`;
    return result.id;
  }

  async function lifecycle(runId: number) {
    const [task] = await sql`SELECT id FROM runs
      WHERE parent_run_id = ${runId} AND action_key = 'automation-preparation'`;
    expect(task).toBeDefined();
    const taskRunId = Number(task.id);
    const prepare = async (attempt = 1) => {
      await sql`UPDATE runs SET status = 'claimed',
        claimed_by = 'synthetic-context-preparation', claimed_at = now()
        WHERE id = ${taskRunId}`;
      await runAutomationPreparationTask(
        {
          organizationId: workspace.org.id,
          automationId,
          sourceRunId: runId,
        },
        ENV,
        taskRunId,
        attempt
      );
    };
    const claim = () =>
      sql.begin((tx) =>
        claimPendingAutomationRun(tx as unknown as DbClient, {
          runId,
          automationId,
          claimedBy: "synthetic-context-agent",
          status: "running",
        })
      );
    const read = () =>
      workspace.owner.knowledge.read({
        automation_id: automationId,
        run_id: runId,
      }) as Promise<WindowContext>;
    return {
      runId,
      prepare,
      claim,
      read,
      async complete(page: WindowContext) {
        const snapshot = page.sources.metric_snapshot[0];
        const evidence = snapshot.evidence[0];
        const extracted = {
          summaries: [
            {
              content: evidence
                ? `${evidence.definition} Effective ${evidence.effective_from}. Source event ${evidence.event_id}.`
                : "No current supporting definition is available; the previous summary is withdrawn.",
              metadata: {
                summary_kind: "current-metric-definition",
                metric: snapshot.metric,
                state: snapshot.state,
                evidence_event_ids: snapshot.evidence.map(
                  (item) => item.event_id
                ),
              },
            },
          ],
        };
        await workspace.owner.automations.completeWindow({
          automation_id: String(automationId),
          run_id: runId,
          window_token: page.window_token,
          extracted_data: extracted,
        });
      },
    };
  }

  async function activate(start: string, end: string) {
    const run = await createAutomationRun({
      organizationId: workspace.org.id,
      automationId,
      agentId: agent.agentId,
      windowStart: start,
      windowEnd: end,
      dispatchSource: "manual",
      expectedWindowStart: start,
    });
    return lifecycle(run.runId);
  }

  return {
    sql,
    workspace,
    automationId,
    save,
    activate,
    lifecycle,
    summaries: () => sql`SELECT id, payload_text, metadata,
        supersedes_event_id, superseded_by, run_id
      FROM events WHERE organization_id = ${workspace.org.id}
        AND automation_id = ${automationId} AND semantic_type = 'summary'
      ORDER BY id`,
  };
}

describe("current definition summary lifecycle", () => {
  beforeEach(cleanupTestDatabase);

  it("freezes evidence, refreshes a late correction and withdraws a scheduled empty source", async () => {
    const h = await setup();
    const original = await h.save(
      "Every cancellation counts.",
      "2026-08-01T00:10:00.000Z"
    );
    const first = await h.activate(START, FIRST_END);
    expect(await first.claim()).toBe(false);
    await expect(first.read()).rejects.toThrow("preparation is not ready");
    await first.prepare();
    const firstPage = await first.read();
    expect(firstPage.sources.metric_snapshot[0]).toMatchObject({
      state: "ready",
      evidence: [
        { event_id: original, definition: "Every cancellation counts." },
      ],
    });
    expect(
      firstPage.sources.definition_changes.map((row) => Number(row.id))
    ).toEqual([original]);

    const foreign = await TestWorkspace.create({
      name: "Synthetic Other Context",
    });
    await expect(
      foreign.owner.knowledge.read({
        automation_id: h.automationId,
        run_id: first.runId,
      })
    ).rejects.toThrow();

    const corrected = await h.save(
      "Exclude payment failures inside the 28-day grace period.",
      "2026-08-01T00:30:00.000Z",
      original
    );
    // A retry/late read of the existing run must not silently adopt the correction.
    await first.prepare();
    expect((await first.read()).sources.metric_snapshot).toEqual(
      firstPage.sources.metric_snapshot
    );
    expect(await first.claim()).toBe(true);
    await first.complete(firstPage);

    const second = await h.activate(FIRST_END, SECOND_END);
    await second.prepare();
    expect(await second.claim()).toBe(true);
    const secondPage = await second.read();
    expect(secondPage.sources.metric_snapshot[0]).toMatchObject({
      state: "ready",
      evidence: [{ event_id: corrected, version: "v2" }],
    });
    // Old business occurrence is still delivered on the new arrival axis.
    expect(
      secondPage.sources.definition_changes.map((row) => Number(row.id))
    ).toEqual([corrected]);
    await second.complete(secondPage);
    const firstOutputs = await h.summaries();
    expect(firstOutputs).toHaveLength(2);
    expect(firstOutputs[0].superseded_by).toBe(firstOutputs[1].id);
    expect(firstOutputs[1]).toMatchObject({
      supersedes_event_id: firstOutputs[0].id,
      superseded_by: null,
      metadata: { state: "ready", evidence_event_ids: [corrected] },
    });

    const removed = (await h.workspace.owner.knowledge.delete({
      content_id: corrected,
      reason: "Synthetic source withdrawal",
    })) as { deleted_ids: number[]; tombstone_ids: number[] };
    expect(removed.deleted_ids).toEqual([corrected]);
    await h.sql`UPDATE events SET created_at = '2026-08-01T00:50:00Z'
      WHERE id = ${removed.tombstone_ids[0]}`;
    await h.sql`UPDATE automations SET next_run_at = now() - interval '1 hour'
      WHERE id = ${h.automationId}`;
    expect(
      await materializeDueAutomationRuns(ENV, h.sql as unknown as DbClient)
    ).toMatchObject({ runsCreated: 1, skipped: 0 });
    const [scheduled] = await h.sql`SELECT id FROM runs
      WHERE automation_id = ${h.automationId}
        AND run_type = 'automation' AND status = 'pending'`;
    const third = await h.lifecycle(Number(scheduled.id));
    await third.prepare();
    expect(await third.claim()).toBe(true);
    const emptyPage = await third.read();
    expect(emptyPage.sources.definition_changes).toEqual([]);
    expect(emptyPage.sources.metric_snapshot[0]).toMatchObject({
      state: "no_evidence",
      evidence: [],
    });
    const invalidSummaries = [
      [],
      ...[
        { state: "ready", evidence_event_ids: [] },
        { state: "no_evidence", evidence_event_ids: [corrected] },
      ].map((metadata) => [
        {
          content: "Synthetic invalid summary.",
          metadata: {
            summary_kind: "current-metric-definition",
            metric: "churn_rate",
            ...metadata,
          },
        },
      ]),
    ];
    for (const summaries of invalidSummaries) {
      await expect(
        h.workspace.owner.automations.completeWindow({
          automation_id: String(h.automationId),
          run_id: third.runId,
          window_token: emptyPage.window_token,
          extracted_data: { summaries },
        })
      ).rejects.toMatchObject({ httpStatus: 400 });
    }
    expect(await h.summaries()).toHaveLength(2);
    await third.complete(emptyPage);
    const outputs = await h.summaries();
    expect(outputs).toHaveLength(3);
    expect(outputs[1].superseded_by).toBe(outputs[2].id);
    expect(outputs[2]).toMatchObject({
      supersedes_event_id: outputs[1].id,
      superseded_by: null,
      metadata: { state: "no_evidence", evidence_event_ids: [] },
    });
    const current = (await h.workspace.owner.knowledge.read({
      semantic_type: "summary",
    })) as {
      content: Array<{ id: number; metadata: Record<string, unknown> }>;
    };
    expect(current.content.map((row) => Number(row.id))).toEqual([
      outputs[2].id,
    ]);
    expect(current.content[0].metadata.state).toBe("no_evidence");
    expect(
      await h.sql`SELECT id FROM events
      WHERE id IN (${original}, ${corrected})`
    ).toHaveLength(2);
  });

  it.each([
    "ambiguous",
    "oversized",
  ] as const)("fails %s evidence without publishing or advancing the arrival mark", async (failure) => {
    const h = await setup();
    await h.save(
      failure === "oversized"
        ? "rule ".repeat(1_000)
        : "First current definition.",
      "2026-08-01T00:10:00.000Z"
    );
    if (failure === "ambiguous") {
      await h.save(
        "Unreconciled second definition.",
        "2026-08-01T00:11:00.000Z"
      );
    }
    const run = await h.activate(START, FIRST_END);
    await run.prepare(3);
    const [stored] = await h.sql`SELECT status, run_metadata FROM runs
        WHERE id = ${run.runId}`;
    expect(stored.status).toBe("failed");
    expect(stored.run_metadata.preparation_sources).toBeUndefined();
    expect(await run.claim()).toBe(false);
    expect(await h.summaries()).toEqual([]);
    const [automation] = await h.sql`SELECT next_window_start FROM automations
        WHERE id = ${h.automationId}`;
    expect(new Date(automation.next_window_start).toISOString()).toBe(START);
  });
});
