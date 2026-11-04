import type {
  AutomationScriptContext,
  ReactionClient,
  ReactionContext,
} from "@lobu/connector-sdk";

type RecordRow = {
  id: number;
  name: string;
  metadata: Record<string, unknown>;
  parent_id?: number | null;
  created_at?: string;
  updated_at?: string;
};
type Evidence = { id: number; content: string; source_url: string | null };
export interface ReviewCase {
  entity_id: number;
  request_id: string;
  document_id: number;
  counterparty_id: number;
  summary: string;
  evidence: Evidence[];
  guidance: RecordRow[];
  positions: RecordRow[];
  prior_decisions: unknown[];
  instruction: string;
}
const id = (value: unknown): number => {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
  )
    throw new Error("A positive stored record ID is required.");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1)
    throw new Error("A positive stored record ID is required.");
  return result;
};
const stamp = (value: string): string => {
  if (!Number.isFinite(Date.parse(value)))
    throw new Error("An explicit window timestamp is required.");
  return new Date(value).toISOString();
};
function applied(result: unknown) {
  const r = result as {
    approval_queued?: boolean;
    blocked_fields?: string[];
    status?: string;
  };
  if (
    r.approval_queued ||
    r.blocked_fields?.length ||
    r.status === "pending_approval"
  ) {
    throw new Error(
      "The legal update is awaiting approval; processing has not completed."
    );
  }
}
async function list(
  client: ReactionClient,
  type: string
): Promise<RecordRow[]> {
  const rows: RecordRow[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await client.entities.list({
      entity_type: type,
      limit: 100,
      offset,
      sort_by: "id",
      sort_order: "asc",
    });
    rows.push(...(page.entities as unknown as RecordRow[]));
    if (!page.metadata.has_more) return rows;
  }
  throw new Error(
    `The ${type} batch exceeds 1000 records; narrow the workspace before processing.`
  );
}
async function get(
  client: ReactionClient,
  entityId: unknown,
  type?: string
): Promise<RecordRow> {
  const result = await client.entities.get({ entity_id: id(entityId) });
  const entity = result.entity as unknown as RecordRow & {
    entity_type: string;
  };
  if (!entity || (type && entity.entity_type !== type))
    throw new Error(`Expected a readable ${type ?? "stored"} record.`);
  return entity;
}
async function patch(
  client: ReactionClient,
  entityId: number,
  metadata: Record<string, unknown>
) {
  applied(await client.entities.update({ entity_id: entityId, metadata }));
}
async function evidence(
  client: ReactionClient,
  eventId: unknown,
  asOf: string,
  documentId?: number
): Promise<Evidence> {
  const rows = (await client.query(
    `SELECT id, payload_text AS content, source_url, length(payload_text) AS body_length, entity_ids, semantic_type FROM events WHERE id = ${id(eventId)} AND created_at <= '${stamp(asOf)}' AND occurred_at <= '${stamp(asOf)}' LIMIT 1`
  )) as Array<
    Evidence & {
      body_length: number;
      entity_ids: number[];
      semantic_type: string;
    }
  >;
  const row = rows[0];
  if (!row)
    throw new Error(
      "The selected source evidence is unavailable at this review cutoff."
    );
  if (
    documentId &&
    (!row.content ||
      !row.entity_ids.includes(documentId) ||
      row.semantic_type !== "legal-document-evidence")
  )
    throw new Error("The evidence is not the selected document revision.");
  if (Number(row.body_length) > 3500)
    throw new Error(
      "The source needs bounded sections before automated review; no partial review was produced."
    );
  return {
    id: Number(row.id),
    content: row.content ?? "",
    source_url: row.source_url,
  };
}
const bytes = (value: unknown) =>
  encodeURIComponent(JSON.stringify(value)).replace(/%[A-F0-9]{2}|./g, "x")
    .length;
const available = (row: RecordRow, asOf: string) => {
  const cutoff = Date.parse(asOf);
  return (
    row.metadata.status === "approved" &&
    Date.parse(String(row.metadata.effective_at)) <= cutoff &&
    (!row.metadata.expires_at ||
      Date.parse(String(row.metadata.expires_at)) > cutoff) &&
    (!row.updated_at || Date.parse(row.updated_at) <= cutoff)
  );
};

/** Immutable preparation: every case has one exact document and its own sources. */
export async function prepare(
  ctx: AutomationScriptContext,
  client: ReactionClient
) {
  const asOf = stamp(ctx.window.window_end);
  const requests = (await list(client, "legal-request")).filter(
    (r) => r.metadata.status === "triaged"
  );
  const guidance = await list(client, "legal-guidance");
  const positions = await list(client, "playbook-position");
  const cases: ReviewCase[] = [];
  for (const request of requests.slice(0, 5)) {
    const m = request.metadata;
    const document = await get(client, m.current_document_id, "legal-document");
    const counterpartyId = id(m.counterparty_id);
    if (
      Number(document.metadata.counterparty_id) !== counterpartyId ||
      (m.contract_id &&
        Number(document.metadata.contract_id) !== Number(m.contract_id)) ||
      !(Date.parse(String(document.metadata.available_at)) <= Date.parse(asOf))
    ) {
      throw new Error(
        "Document counterparty, agreement or availability does not match this request."
      );
    }
    const selected = await evidence(
      client,
      document.metadata.source_event_id,
      asOf,
      document.id
    );
    const applicable = (row: RecordRow) =>
      available(row, asOf) &&
      [0, counterpartyId].includes(Number(row.metadata.counterparty_id ?? 0)) &&
      Number(row.parent_id) === Number(m.knowledge_bank_id);
    const approved = guidance.filter(applicable);
    const approvedPositions = positions.filter(applicable);
    for (const item of [...approved, ...approvedPositions]) {
      const refs = item.metadata.source_event_ids as unknown[];
      if (!Array.isArray(refs) || refs.length === 0)
        throw new Error("Approved guidance has no readable source evidence.");
      for (const ref of refs) await evidence(client, ref, asOf);
    }
    const prior = document.metadata.contract_id
      ? await client.query(
          `SELECT d.id, d.metadata->'interaction'->'value' AS instruction FROM entities r JOIN events d ON d.id = (r.metadata->>'last_decision_id')::bigint WHERE r.entity_type = 'legal-request' AND r.metadata->>'counterparty_id' = '${counterpartyId}' AND r.metadata->>'contract_id' = '${id(document.metadata.contract_id)}' AND d.created_at <= '${asOf}' ORDER BY d.id DESC LIMIT 20`
        )
      : [];
    const candidate: ReviewCase = {
      entity_id: request.id,
      request_id: String(m.request_id),
      document_id: document.id,
      counterparty_id: counterpartyId,
      summary: String(m.summary ?? ""),
      evidence: [selected],
      guidance: approved,
      positions: approvedPositions,
      prior_decisions: prior,
      instruction: String(m.instruction ?? ""),
    };
    if (bytes({ cases: [...cases, candidate] }) > 12_000) {
      if (!cases.length)
        throw new Error(
          "This request exceeds the bounded context budget; narrow its approved guidance or source sections."
        );
      break;
    }
    cases.push(candidate);
  }
  return { cases: cases as unknown as Record<string, unknown>[] };
}

export const input = {
  type: "object",
  additionalProperties: false,
  required: ["reviews"],
  properties: {
    reviews: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "entity_id",
          "document_id",
          "summary",
          "evidence_ids",
          "findings",
        ],
        properties: {
          entity_id: { type: "integer", minimum: 1 },
          document_id: { type: "integer", minimum: 1 },
          summary: { type: "string", minLength: 1, maxLength: 2500 },
          evidence_ids: {
            type: "array",
            minItems: 1,
            maxItems: 30,
            items: { type: "integer", minimum: 1 },
          },
          findings: {
            type: "array",
            maxItems: 15,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["clause", "risk", "rationale", "evidence_id", "quote"],
              properties: {
                clause: { type: "string", maxLength: 150 },
                risk: { type: "string", enum: ["low", "medium", "high"] },
                rationale: { type: "string", maxLength: 1000 },
                evidence_id: { type: "integer", minimum: 1 },
                quote: { type: "string", minLength: 1, maxLength: 500 },
              },
            },
          },
        },
      },
    },
  },
};
interface Review {
  entity_id: number;
  document_id: number;
  summary: string;
  evidence_ids: number[];
  findings: Array<{
    clause: string;
    risk: string;
    rationale: string;
    evidence_id: number;
    quote: string;
  }>;
}
export default async function saveReviews(
  ctx: ReactionContext & { sources?: Record<string, unknown> },
  client: ReactionClient
) {
  const cases = ctx.sources?.cases as unknown as ReviewCase[] | undefined;
  const reviews = ctx.extracted_data.reviews as Review[] | undefined;
  if (!cases || !Array.isArray(reviews) || reviews.length !== cases.length)
    throw new Error("A review is required for every prepared request.");
  const seen = new Set<number>();
  // Validate the complete response before making any persistent change.
  for (const review of reviews) {
    const source = cases.find((c) => c.entity_id === review.entity_id);
    if (
      !source ||
      seen.has(review.entity_id) ||
      source.document_id !== review.document_id
    )
      throw new Error("Review is outside its prepared request/document scope.");
    seen.add(review.entity_id);
    const refs = new Set(source.evidence.map((e) => e.id));
    if (
      typeof review.summary !== "string" ||
      !review.summary.trim() ||
      review.summary.length > 2500 ||
      !Array.isArray(review.findings) ||
      review.findings.length > 15
    )
      throw new Error("Invalid review content.");
    if (
      !Array.isArray(review.evidence_ids) ||
      !review.evidence_ids.length ||
      review.evidence_ids.some((ref) => !refs.has(ref))
    )
      throw new Error("Review cites evidence outside its request.");
    for (const finding of review.findings) {
      if (
        typeof finding.quote !== "string" ||
        !finding.quote ||
        finding.quote.length > 500 ||
        !["low", "medium", "high"].includes(finding.risk) ||
        !review.evidence_ids.includes(finding.evidence_id) ||
        !source.evidence
          .find((e) => e.id === finding.evidence_id)
          ?.content.includes(finding.quote)
      )
        throw new Error(
          "A finding must quote its exact cited document evidence."
        );
    }
    const current = await get(client, review.entity_id, "legal-request");
    if (
      Number(current.metadata.current_document_id) !== review.document_id ||
      !["triaged", "awaiting_decision"].includes(
        String(current.metadata.status)
      )
    )
      throw new Error("The request changed; prepare a new review.");
  }
  for (const review of reviews) {
    const source = cases.find((c) => c.entity_id === review.entity_id)!;
    const saved = await client.knowledge.save({
      title: `Review: ${source.request_id}`,
      payload_type: "empty",
      semantic_type: "legal-review",
      entity_ids: [review.entity_id, review.document_id],
      idempotency_key: `legal-review:${ctx.window.run_id}:${review.entity_id}`,
      metadata: {
        ...review,
        request_id: source.request_id,
        counterparty_id: source.counterparty_id,
        as_of: ctx.window.window_end,
      },
    });
    await patch(client, review.entity_id, {
      status: "awaiting_decision",
      review_event_id: saved.id,
      review_document_id: review.document_id,
    });
  }
}
