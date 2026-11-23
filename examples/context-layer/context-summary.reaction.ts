/**
 * Snapshot the current definition before analysis. This recipe intentionally
 * summarizes one metric; it does not infer dependencies for arbitrary memories.
 */
import type {
  AutomationScriptContext,
  ReactionClient,
} from "@lobu/connector-sdk";

export const input = {
  type: "object",
  properties: {
    summaries: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: {
        type: "object",
        properties: {
          content: { type: "string", minLength: 1, maxLength: 4_000 },
          metadata: {
            type: "object",
            properties: {
              summary_kind: { const: "current-metric-definition" },
              metric: { const: "churn_rate" },
              state: { enum: ["ready", "no_evidence"] },
              evidence_event_ids: {
                type: "array",
                maxItems: 1,
                items: { type: "integer", minimum: 1 },
              },
            },
            oneOf: [
              {
                properties: {
                  state: { const: "ready" },
                  evidence_event_ids: { minItems: 1 },
                },
              },
              {
                properties: {
                  state: { const: "no_evidence" },
                  evidence_event_ids: { maxItems: 0 },
                },
              },
            ],
            required: ["summary_kind", "metric", "state", "evidence_event_ids"],
          },
        },
        required: ["content", "metadata"],
      },
    },
  },
  required: ["summaries"],
};

export interface MetricSnapshot {
  metric: string;
  state: "ready" | "no_evidence";
  prepared_at: string;
  evidence: Array<{
    event_id: number;
    definition: string;
    version: string;
    effective_from: string;
  }>;
}

export async function prepare(
  _ctx: AutomationScriptContext,
  client: ReactionClient
): Promise<{ metric_snapshot: MetricSnapshot[] }> {
  // client.query applies current-version and caller authorization filters.
  // LIMIT 2 detects ambiguity instead of silently choosing one definition.
  // The saved result is current at preparation, not a historical SQL snapshot
  // of every SDK read at the Automation's arrival-window boundary.
  const rows = (await client.query(`
    SELECT e.id, e.payload_text AS definition,
           length(e.payload_text) AS definition_length,
           e.metadata->>'version' AS version,
           e.metadata->>'effective_from' AS effective_from
    FROM events e
    JOIN entities m ON m.id = ANY(e.entity_ids)
    WHERE e.semantic_type = 'definition'
      AND m.entity_type = 'metric-definition'
      AND m.metadata->>'metric' = 'churn_rate'
    ORDER BY e.id DESC
    LIMIT 2
  `)) as Array<{
    id: number;
    definition: string;
    definition_length: number;
    version: string;
    effective_from: string;
  }>;
  if (rows.length > 1) {
    throw new Error(
      "Multiple current churn_rate definitions; supersede the obsolete definition before summarizing."
    );
  }
  const evidence = rows.map((row) => {
    if (
      !Number.isSafeInteger(Number(row.id)) ||
      Number(row.id) < 1 ||
      typeof row.definition !== "string" ||
      Number(row.definition_length) !== Array.from(row.definition).length ||
      row.definition.length > 4_000 ||
      typeof row.version !== "string" ||
      !row.version.trim() ||
      row.version.length > 100 ||
      typeof row.effective_from !== "string" ||
      !row.effective_from.trim() ||
      row.effective_from.length > 100
    ) {
      throw new Error(
        "The current definition is incomplete or exceeds the bounded summary context; read and repair it before summarizing."
      );
    }
    return {
      event_id: Number(row.id),
      definition: row.definition,
      version: row.version,
      effective_from: row.effective_from,
    };
  });
  return {
    metric_snapshot: [
      {
        metric: "churn_rate",
        state: evidence.length ? "ready" : "no_evidence",
        prepared_at: new Date().toISOString(),
        evidence,
      },
    ],
  };
}
