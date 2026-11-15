import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

export const input = {
  type: "object",
  properties: {
    reports: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          report_id: { type: "integer", minimum: 1 },
          summary: { type: "string", minLength: 1, maxLength: 2000 },
          kind: { enum: ["bug", "feature", "ops"] },
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
  kind: "bug" | "feature" | "ops";
  task_id?: number;
  issue_id?: number;
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
function id(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error("Expected a positive record id");
  return Number(value);
}

/** The inbox belongs to this example. Shared runtime knows no feedback keys,
 * task/issue semantics, recipient identifiers, or reporting policy.
 */
export default async function triageFeedback(
  ctx: ReactionContext,
  client: ReactionClient
): Promise<Record<string, unknown>> {
  const decisions = ctx.extracted_data.reports as Decision[];
  if (!Array.isArray(decisions) || decisions.length > 100)
    throw new Error("Expected a bounded feedback batch");
  const start = new Date(ctx.window.window_start).toISOString();
  const end = new Date(ctx.window.window_end).toISOString();
  const source = {
    automation_id: id(ctx.window.automation_id),
    run_id: id(ctx.window.run_id),
  };
  const expected = (await client.query(`
    SELECT e.id FROM events e JOIN connections c ON c.id = e.connection_id
    WHERE c.slug = 'product-feedback-inbox' AND c.connector_key = 'webhook'
      AND c.deleted_at IS NULL AND e.semantic_type = 'product.feedback'
      AND e.created_at >= ${literal(start)}::timestamptz
      AND e.created_at < ${literal(end)}::timestamptz
    ORDER BY e.created_at, e.id LIMIT 101
  `)) as Array<{ id: number }>;
  const reportIds = new Set(
    decisions.map((decision) => id(decision.report_id))
  );
  if (
    expected.length > 100 ||
    reportIds.size !== decisions.length ||
    expected.length !== decisions.length ||
    expected.some((report) => !reportIds.has(Number(report.id)))
  )
    throw new Error(
      "Expected every report in this inbox and window exactly once; split windows larger than 100 reports"
    );
  const results: Array<{ report_id: number; task_id: number }> = [];
  for (const decision of decisions) {
    const reportId = id(decision.report_id);
    const [report] = (await client.query(`
      SELECT e.id, e.title, e.payload_data,
        md5(e.connection_id::text || ':' || e.origin_id) AS report_key
      FROM events e JOIN connections c ON c.id = e.connection_id
      WHERE e.id = ${reportId} AND c.slug = 'product-feedback-inbox'
        AND c.connector_key = 'webhook' AND c.deleted_at IS NULL
        AND e.semantic_type = 'product.feedback'
        AND e.created_at >= ${literal(start)}::timestamptz
        AND e.created_at < ${literal(end)}::timestamptz
      LIMIT 1
    `)) as Array<{
      id: number;
      title: string | null;
      payload_data: { subject?: string };
      report_key: string;
    }>;
    if (!report || !/^[0-9a-f]{32}$/.test(report.report_key))
      throw new Error("Feedback report is not in this inbox and window");
    if (
      !decision.summary?.trim() ||
      decision.summary.length > 2000 ||
      !["bug", "feature", "ops"].includes(decision.kind)
    )
      throw new Error("Invalid feedback triage");
    const key = `feedback-triage:${report.report_key}`;
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
      const targets = [decision.task_id, decision.issue_id].filter(
        (value): value is number => value !== undefined
      );
      if (targets.length) {
        const records = (await client.query(`
          SELECT e.id, e.entity_type FROM entities e
          WHERE e.id IN (${targets.map(id).join(",")}) AND e.deleted_at IS NULL
        `)) as Array<{ id: number; entity_type: string }>;
        for (const [target, expected] of [
          [decision.task_id, "task"],
          [decision.issue_id, "issue"],
        ] as const) {
          if (
            target !== undefined &&
            !records.some(
              (row) => Number(row.id) === target && row.entity_type === expected
            )
          )
            throw new Error(
              "Feedback target is not an accessible task or issue"
            );
        }
      }
      taskId = decision.task_id;
      if (!taskId) {
        const slug = `feedback-${report.report_key}`;
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
              name: (typeof report.payload_data?.subject === "string"
                ? report.payload_data.subject
                : report.title || "Product feedback"
              ).slice(0, 160),
              metadata: {
                kind: decision.kind,
                status: "open",
                summary: decision.summary,
                confidence: "hypothesis",
                next_action:
                  "Review the user report and verify or reproduce it before changing issue lifecycle or counts.",
              },
              automation_source: source,
            });
            taskId =
              created.entity?.id == null
                ? undefined
                : id(Number(created.entity.id));
            if (!taskId)
              throw new Error(
                "Feedback task creation requires approval or did not complete"
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
        title: "User-reported product feedback",
        content: decision.summary,
        semantic_type: "observation",
        entity_ids: [taskId, ...(decision.issue_id ? [decision.issue_id] : [])],
        parent_event_id: reportId,
        idempotency_key: key,
        payload_data: {
          report_id: reportId,
          task_id: taskId,
          issue_id: decision.issue_id ?? null,
          verification: "user_reported",
        },
        automation_source: source,
      });
      if (!saved || !Number.isSafeInteger(saved.id) || saved.id <= 0)
        throw new Error("Feedback evidence was not saved");
    }
    await client.notifications.send({
      title: "Product feedback received",
      body: "A user report has been attached to a team task. Review its source evidence before changing issue lifecycle or affected-user counts.",
      recipients: "admins",
      idempotency_key: `feedback-alert:${report.report_key}`,
      automation_source: source,
    });
    results.push({ report_id: reportId, task_id: id(Number(taskId)) });
  }
  return { reports: results };
}
