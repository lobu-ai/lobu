import type {
  AutomationScriptContext,
  ReactionClient,
  ReactionContext,
} from "@lobu/connector-sdk";

export const input = {
  type: "object",
  properties: {
    reports: {
      type: "array",
      minItems: 1,
      // The trigger queues one run per delivery. Keeping that boundary also
      // bounds completion to at most eight SDK calls, below the 200-call quota.
      maxItems: 1,
      items: {
        type: "object",
        properties: {
          report_id: { type: "integer", minimum: 1 },
          summary: { type: "string", minLength: 1, maxLength: 2000 },
          kind: { enum: ["bug", "feature", "ops", "content"] },
          task_id: { type: "integer", minimum: 1 },
          issue_id: { type: "integer", minimum: 1 },
        },
        required: ["report_id", "summary", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["reports"],
  additionalProperties: false,
};

interface Decision {
  report_id: number;
  summary: string;
  kind: "bug" | "feature" | "ops" | "content";
  task_id?: number;
  issue_id?: number;
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
function id(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error("Expected a positive record id");
  return Number(value);
}

interface ReportPointer {
  id: number;
  origin_id: string;
}

/** Bind one accepted notification event by its durable trigger pointer. */
export async function prepare(
  ctx: AutomationScriptContext,
  client: ReactionClient
): Promise<{ reports: ReportPointer[] }> {
  const signal = ctx.trigger_signals?.[0] as
    | { source?: string; event_type?: string; event_id?: number }
    | undefined;
  if (
    ctx.trigger_signals?.length !== 1 ||
    signal?.source !== "workspace" ||
    signal.event_type !== "product.issue"
  )
    throw new Error("Expected one queued issue report delivery");
  const reports = (await client.query(`
    SELECT id, origin_id FROM events
    WHERE id = ${id(signal.event_id)} AND semantic_type = 'product.issue'
      AND metadata->'inbox_submission'->>'inbox' = 'product.issue'
    LIMIT 1
  `)) as ReportPointer[];
  if (reports.length !== 1)
    throw new Error("Issue report is not accessible in this inbox");
  return { reports };
}

/** The inbox belongs to this example. Shared runtime knows no report keys,
 * task/issue semantics, recipient identifiers, or reporting policy.
 */
export default async function triageIssueReport(
  ctx: ReactionContext,
  client: ReactionClient
): Promise<Record<string, unknown>> {
  const decisions = ctx.extracted_data.reports as Decision[];
  const expected = ctx.sources?.reports as ReportPointer[] | undefined;
  if (
    !Array.isArray(decisions) ||
    decisions.length !== 1 ||
    !Array.isArray(expected) ||
    expected.length !== 1 ||
    id(expected[0].id) !== id(decisions[0].report_id)
  )
    throw new Error(
      "Expected every report in this inbox delivery exactly once"
    );
  const pointer = expected[0];
  const source = {
    automation_id: id(ctx.window.automation_id),
    run_id: id(ctx.window.run_id),
  };
  const results: Array<{ report_id: number; task_id: number }> = [];
  for (const decision of decisions) {
    const reportId = id(decision.report_id);
    const [report] = (await client.query(`
      SELECT e.id, e.title,
        md5(e.origin_id) AS report_key,
        e.payload_data->'evidence'->>'failure_fingerprint' AS failure_fingerprint
      FROM events e
      WHERE e.id = ${reportId} AND e.semantic_type = 'product.issue'
        AND e.metadata->'inbox_submission'->>'inbox' = 'product.issue'
        AND e.origin_id = ${literal(pointer.origin_id)}
      LIMIT 1
    `)) as Array<{
      id: number;
      title: string | null;
      report_key: string;
      failure_fingerprint: string | null;
    }>;
    if (!report || !/^[0-9a-f]{32}$/.test(report.report_key))
      throw new Error("Issue report is not in this inbox delivery");
    if (
      !decision.summary?.trim() ||
      decision.summary.length > 2000 ||
      !["bug", "feature", "ops", "content"].includes(decision.kind)
    )
      throw new Error("Invalid issue triage");
    const key = `issue-triage:${report.report_key}`;
    // The producer key persists the first decision. Replays keep its task
    // instead of rematching the same report or creating another task.
    const previous = (await client.query(`
      SELECT payload_data FROM events
      WHERE metadata ? '_lobu_idempotency_key'
        AND metadata->>'_lobu_idempotency_key' = ${literal(key)}
      LIMIT 1
    `)) as Array<{ payload_data: { task_id?: number } }>;
    let taskId = previous[0]?.payload_data?.task_id;
    if (!taskId) {
      // A cited failure fingerprint names its telemetry issue exactly; it wins
      // over a model match. The schema pins the 32-hex shape, rechecked here.
      let issueId = decision.issue_id;
      if (
        report.failure_fingerprint &&
        /^[0-9a-f]{32}$/.test(report.failure_fingerprint)
      ) {
        const [tracked] = (await client.query(`
          SELECT e.id FROM entities e
          WHERE e.slug = ${literal(`issue-${report.failure_fingerprint}`)}
            AND e.entity_type = 'issue' AND e.deleted_at IS NULL
          LIMIT 1
        `)) as Array<{ id: number }>;
        if (tracked) issueId = id(Number(tracked.id));
      }
      const targets = [decision.task_id, issueId].filter(
        (value): value is number => value !== undefined
      );
      if (targets.length) {
        const records = (await client.query(`
          SELECT e.id, e.entity_type FROM entities e
          WHERE e.id IN (${targets.map(id).join(",")}) AND e.deleted_at IS NULL
        `)) as Array<{ id: number; entity_type: string }>;
        for (const [target, expected] of [
          [decision.task_id, "task"],
          [issueId, "issue"],
        ] as const) {
          if (
            target !== undefined &&
            !records.some(
              (row) => Number(row.id) === target && row.entity_type === expected
            )
          )
            throw new Error(
              "Issue report target is not an accessible task or issue"
            );
        }
      }
      taskId = decision.task_id;
      if (!taskId) {
        const slug = `issue-report-${report.report_key}`;
        const find = () =>
          client.query(`
          SELECT e.id FROM entities e
          WHERE e.slug = ${literal(slug)} AND e.entity_type = 'task' AND e.deleted_at IS NULL LIMIT 1
        `) as Promise<Array<{ id: number }>>;
        taskId = (await find())[0]?.id;
        if (!taskId) {
          try {
            const created = await client.entities.create({
              entity_type: "task",
              slug,
              name: (report.title || "Lobu issue report").slice(0, 160),
              metadata: {
                kind: decision.kind,
                status: "open",
                summary: decision.summary,
                confidence: "hypothesis",
                next_action:
                  "Verify or reproduce the reported issue before changing issue lifecycle or counts.",
              },
              automation_source: source,
            });
            taskId =
              created.entity?.id == null
                ? undefined
                : id(Number(created.entity.id));
            if (!taskId)
              throw new Error(
                "Issue report task creation requires approval or did not complete"
              );
          } catch (error) {
            // Concurrent retries meet on the same source-derived slug. Only
            // a successful indexed readback can turn a create error into success.
            taskId = (await find())[0]?.id;
            if (!taskId) throw error;
          }
        }
      }
      taskId = id(Number(taskId));
      const saved = await client.knowledge.save({
        title: "Reported Lobu issue",
        content: decision.summary,
        semantic_type: "observation",
        entity_ids: [taskId, ...(issueId ? [issueId] : [])],
        parent_event_id: reportId,
        idempotency_key: key,
        payload_data: {
          report_id: reportId,
          task_id: taskId,
          issue_id: issueId ?? null,
          verification: "user_reported",
        },
        automation_source: source,
      });
      if (!saved || !Number.isSafeInteger(saved.id) || saved.id <= 0)
        throw new Error("Issue report evidence was not saved");
    }
    await client.notifications.send({
      title: "Lobu issue reported",
      body: "A reported issue has been attached to a team task. Review its source evidence before changing issue lifecycle or affected-user counts.",
      recipients: "admins",
      idempotency_key: `issue-report-alert:${report.report_key}`,
      automation_source: source,
    });
    results.push({ report_id: reportId, task_id: id(Number(taskId)) });
  }
  return { reports: results };
}
