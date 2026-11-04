import type {
  AutomationScriptContext,
  ReactionClient,
} from "@lobu/connector-sdk";
type RecordRow = {
  id: number;
  name: string;
  metadata: Record<string, unknown>;
};
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
async function link(
  client: ReactionClient,
  from: number,
  to: number,
  relation: string
) {
  if (!/^[a-z-]+$/.test(relation))
    throw new Error("Invalid relationship type.");
  const find = async () =>
    (await client.query(
      `SELECT r.id FROM entity_relationships r JOIN entity_relationship_types t ON t.id = r.relationship_type_id WHERE r.from_entity_id = ${id(from)} AND r.to_entity_id = ${id(to)} AND t.slug = '${relation}' AND r.deleted_at IS NULL LIMIT 1`
    )) as Array<{ id: number }>;
  if ((await find()).length) return;
  try {
    applied(
      await client.entities.link({
        from_entity_id: from,
        to_entity_id: to,
        relationship_type_slug: relation,
      })
    );
  } catch (error) {
    if (!(await find()).length) throw error;
  }
}
async function upsert(
  client: ReactionClient,
  type: string,
  slug: string,
  name: string,
  metadata: Record<string, unknown>,
  parentId?: number,
  refresh = false
) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !/^[a-z-]+$/.test(type))
    throw new Error("Invalid legal record key.");
  const find = async () =>
    (await client.query(
      `SELECT id FROM entities WHERE entity_type = '${type}' AND slug = '${slug}' LIMIT 1`
    )) as Array<{ id: number }>;
  const existing = await find();
  if (existing[0]) {
    if (refresh) await patch(client, Number(existing[0].id), metadata);
    return Number(existing[0].id);
  }
  try {
    const result = await client.entities.create({
      entity_type: type,
      slug,
      name,
      metadata,
      ...(parentId ? { parent_id: parentId } : {}),
    });
    applied(result);
    return id(result.entity?.id);
  } catch (error) {
    // Reconcile a committed create after a lost response or a competing retry.
    const committed = await find();
    if (!committed[0]) throw error;
    return Number(committed[0].id);
  }
}

export default async function maintain(
  ctx: AutomationScriptContext,
  client: ReactionClient
) {
  const asOf = stamp(ctx.window.window_end);
  if (ctx.automation.slug === "legal-decisions")
    return applyDecisions(ctx, client);
  if (ctx.automation.slug === "legal-intake-triage") {
    const requests = await list(client, "legal-request");
    const people = await list(client, "person");
    let triaged = 0;
    // The agreement's document pointer is intake input; lifecycle fields remain
    // Automation-owned so a human upload does not claim ownership of status.
    for (const request of requests.filter(
      (r) => r.metadata.contract_id && r.metadata.status !== "closed"
    )) {
      const contract = await get(
        client,
        request.metadata.contract_id,
        "contract"
      );
      const next = contract.metadata.current_document_id;
      if (
        !next ||
        Number(next) === Number(request.metadata.current_document_id)
      )
        continue;
      const document = await get(client, next, "legal-document");
      if (
        Number(document.metadata.counterparty_id) !==
          Number(request.metadata.counterparty_id) ||
        Number(document.metadata.contract_id) !== contract.id ||
        !(
          Date.parse(String(document.metadata.available_at)) <= Date.parse(asOf)
        )
      )
        throw new Error(
          "The new revision is unavailable or belongs to another agreement."
        );
      const changed = {
        current_document_id: document.id,
        status: "new",
        review_event_id: 0,
        review_document_id: 0,
      };
      await patch(client, request.id, changed);
      Object.assign(request.metadata, changed);
    }
    for (const request of requests.filter((r) =>
      ["new", "blocked"].includes(String(r.metadata.status))
    )) {
      const m = request.metadata;
      if (!m.current_document_id || !m.counterparty_id || !m.requester_id) {
        await patch(client, request.id, { status: "blocked" });
        continue;
      }
      const candidates = people.filter(
        (p) =>
          p.metadata.role === "counsel" &&
          String(p.metadata.expertise ?? "")
            .split(",")
            .map((x) => x.trim())
            .includes(String(m.matter_type))
      );
      if (!m.owner_id && candidates.length !== 1) {
        await patch(client, request.id, { status: "blocked" });
        continue;
      }
      const owner = await get(client, m.owner_id || candidates[0].id, "person");
      const document = await get(
        client,
        m.current_document_id,
        "legal-document"
      );
      if (
        Number(document.metadata.counterparty_id) !==
          Number(m.counterparty_id) ||
        (m.contract_id &&
          Number(document.metadata.contract_id) !== Number(m.contract_id))
      )
        throw new Error(
          "Intake document belongs to another counterparty or agreement."
        );
      if (owner.metadata.role !== "counsel")
        throw new Error("The assigned person is not designated counsel.");
      await get(client, m.requester_id, "person");
      await get(client, m.counterparty_id, "counterparty");
      for (const [target, relationship] of [
        [owner.id, "assigned-to"],
        [id(m.requester_id), "requested-by"],
        [id(m.counterparty_id), "concerns"],
        ...(m.knowledge_bank_id
          ? [[id(m.knowledge_bank_id), "guided-by"]]
          : []),
        ...(m.contract_id ? [[id(m.contract_id), "covered-by"]] : []),
      ] as Array<[number, string]>) {
        await link(client, request.id, target, relationship);
      }
      await patch(client, request.id, {
        status: "triaged",
        owner_id: owner.id,
        first_touch_at: m.first_touch_at || asOf,
      });
      triaged++;
    }
    return { triaged };
  }
  if (ctx.automation.slug !== "legal-monitoring")
    throw new Error("Unknown legal maintenance Automation.");
  const requests = await list(client, "legal-request");
  const contracts = await list(client, "contract");
  const obligations = await list(client, "legal-obligation");
  let alerts = 0;
  for (const contract of contracts) {
    if (
      !contract.metadata.expiry_date ||
      contract.metadata.status === "expired"
    )
      continue;
    const notice =
      Date.parse(String(contract.metadata.expiry_date)) -
      Number(contract.metadata.notice_days ?? 30) * 86_400_000;
    if (
      Date.parse(String(contract.metadata.expiry_date)) >= Date.parse(asOf) &&
      notice <= Date.parse(asOf) + 30 * 86_400_000
    ) {
      await upsert(
        client,
        "legal-suggestion",
        `renewal-${contract.id}-${String(contract.metadata.expiry_date).replaceAll("-", "")}`,
        `Renewal: ${contract.name}`,
        {
          kind: "renewal",
          status: "open",
          subject_id: contract.id,
          summary: `Review the renewal before ${new Date(notice).toISOString().slice(0, 10)}.`,
        }
      );
      alerts++;
    }
  }
  for (const obligation of obligations) {
    if (
      obligation.metadata.status !== "open" ||
      Date.parse(String(obligation.metadata.due_at)) >
        Date.parse(asOf) + 7 * 86_400_000
    )
      continue;
    await upsert(
      client,
      "legal-suggestion",
      `obligation-${obligation.id}`,
      `Due: ${obligation.name}`,
      {
        kind: "obligation",
        status: "open",
        subject_id: obligation.id,
        summary: String(obligation.metadata.summary),
        evidence_ids: obligation.metadata.source_event_id
          ? [id(obligation.metadata.source_event_id)]
          : [],
      }
    );
    alerts++;
  }
  const open = requests.filter(
    (r) => !["closed", "approved"].includes(String(r.metadata.status))
  );
  await upsert(
    client,
    "legal-ops-snapshot",
    "current-legal-operations",
    "Legal operations",
    {
      as_of: asOf,
      open_requests: open.length,
      awaiting_decision: requests.filter(
        (r) => r.metadata.status === "awaiting_decision"
      ).length,
      sla_breaches: open.filter(
        (r) =>
          r.metadata.sla_due_at &&
          Date.parse(String(r.metadata.sla_due_at)) < Date.parse(asOf)
      ).length,
      approvals: requests.filter((r) => r.metadata.status === "approved")
        .length,
      completed: requests.filter((r) => r.metadata.status === "closed").length,
      coverage: `Complete current-state scan of ${requests.length} requests, ${contracts.length} agreements and ${obligations.length} obligations.`,
    },
    undefined,
    true
  );
  return { alerts, requests: requests.length };
}

async function applyDecisions(
  ctx: AutomationScriptContext,
  client: ReactionClient
) {
  const receipts = (await client.query(
    `SELECT id, metadata, entity_ids, created_by FROM events WHERE semantic_type = 'legal-decision' AND origin_type IN ('view_interaction', 'template_interaction') AND created_by IS NOT NULL AND created_at >= '${stamp(ctx.window.window_start)}' AND created_at <= '${stamp(ctx.window.window_end)}' ORDER BY id LIMIT 101`
  )) as Array<{
    id: number;
    metadata: Record<string, any>;
    entity_ids: number[];
    created_by: string;
  }>;
  if (receipts.length > 100)
    throw new Error(
      "More than 100 decision receipts; narrow the decision window."
    );
  let appliedCount = 0;
  for (const receipt of receipts) {
    const interaction = receipt.metadata.interaction;
    if (
      !interaction ||
      interaction.actor?.platform !== "lobu" ||
      interaction.actor.id !== receipt.created_by ||
      !["approve", "negotiate", "escalate"].includes(interaction.action)
    )
      throw new Error("Unverified legal decision receipt.");
    const sourceId = id(interaction.source_event_id);
    const [review] = (await client.query(
      `SELECT id, metadata, entity_ids FROM events WHERE id = ${sourceId} AND semantic_type = 'legal-review' LIMIT 1`
    )) as Array<{
      id: number;
      metadata: Record<string, unknown>;
      entity_ids: number[];
    }>;
    if (!review)
      throw new Error(
        "The decision's reviewed evidence is no longer available."
      );
    const request = await get(
      client,
      review.metadata.entity_id,
      "legal-request"
    );
    const m = request.metadata;
    if (Number(m.last_decision_id ?? 0) >= Number(receipt.id)) continue;
    if (
      !receipt.entity_ids.includes(request.id) ||
      !review.entity_ids.includes(request.id)
    )
      throw new Error("Decision is not linked to its reviewed request.");
    if (
      Number(m.review_event_id) !== sourceId ||
      Number(m.current_document_id) !== Number(review.metadata.document_id)
    )
      continue;
    const value = interaction.value ?? {};
    if (
      typeof value.instruction !== "string" ||
      value.instruction.length > 1500 ||
      (value.reuse !== undefined && typeof value.reuse !== "boolean")
    )
      throw new Error("Invalid counsel instruction.");
    const state: Record<string, string> = {
      approve: "approved",
      negotiate: "negotiating",
      escalate: "escalated",
    };
    // A scoped draft is a proposal, never an automatic global playbook update.
    if (value.reuse && value.instruction.trim()) {
      await upsert(
        client,
        "legal-guidance",
        `decision-${receipt.id}`,
        `Guidance: ${m.request_id}`,
        {
          question: `What position was taken on ${m.request_id}?`,
          answer: value.instruction,
          status: "draft",
          counterparty_id: id(m.counterparty_id),
          request_id: m.request_id,
          source_event_ids: [
            Number(receipt.id),
            ...(review.metadata.evidence_ids as number[]),
          ],
          effective_at: stamp(ctx.window.window_end),
          decision_id: Number(receipt.id),
        },
        m.knowledge_bank_id ? id(m.knowledge_bank_id) : undefined
      );
      await upsert(
        client,
        "legal-suggestion",
        `guidance-${receipt.id}`,
        `Review guidance from ${m.request_id}`,
        {
          kind: "guidance",
          status: "open",
          subject_id: request.id,
          evidence_ids: [Number(receipt.id)],
          summary:
            "Counsel marked this instruction for reuse. Review its scope and approve the draft answer before it is used elsewhere.",
        }
      );
    }
    await patch(client, request.id, {
      status: state[interaction.action],
      decision: interaction.action,
      instruction: value.instruction,
      last_decision_id: Number(receipt.id),
      decision_document_id: Number(review.metadata.document_id),
      decision_review_id: sourceId,
    });
    appliedCount++;
  }
  return { applied: appliedCount };
}
