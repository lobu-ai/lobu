import type { ReactionClient } from "@lobu/connector-sdk";

/** Explicitly invoked synthetic fixtures. Replays preserve subsequent human edits. */
export async function seedLegalDemo(client: ReactionClient, asOf: string) {
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(cutoff))
    throw new Error("An explicit demo date is required.");
  const at = (days: number) =>
    new Date(cutoff + days * 86_400_000).toISOString();
  const ensure = async (
    type: string,
    slug: string,
    name: string,
    metadata: Record<string, unknown>,
    parentId?: number
  ) => {
    const found = (await client.query(
      `SELECT id FROM entities WHERE entity_type = '${type}' AND slug = '${slug}' LIMIT 1`
    )) as Array<{ id: number }>;
    if (found[0]) return Number(found[0].id);
    const result = await client.entities.create({
      entity_type: type,
      slug,
      name,
      metadata,
      ...(parentId ? { parent_id: parentId } : {}),
    });
    if (
      result.approval_queued ||
      !result.entity ||
      !Number.isSafeInteger(Number(result.entity.id)) ||
      Number(result.entity.id) < 1
    )
      throw new Error(`Demo record ${slug} was not applied.`);
    return Number(result.entity.id);
  };
  const folder = await ensure(
    "legal-folder",
    "demo-commercial",
    "Commercial · synthetic demo",
    { description: "Synthetic commercial legal workspace" }
  );
  const bank = await ensure(
    "knowledge-bank",
    "demo-vendor-guidance",
    "Vendor guidance · synthetic demo",
    {
      topic: "Commercial agreements",
      description: "Draft answers require counsel approval before reuse.",
    },
    folder
  );
  const team = await ensure(
    "legal-team",
    "demo-commercial-team",
    "Commercial legal · synthetic demo",
    { practice: "commercial" }
  );
  const counsel = await ensure(
    "person",
    "demo-counsel",
    "Avery · synthetic counsel",
    {
      role: "counsel",
      team: "commercial",
      expertise: "commercial",
      capacity: 10,
    }
  );
  const requester = await ensure(
    "person",
    "demo-requester",
    "Morgan · synthetic requester",
    { role: "sales", team: "commercial" }
  );
  const company = await ensure(
    "counterparty",
    "demo-harbor",
    "Harbor · synthetic company",
    { relationship: "vendor", risk_tier: "medium" }
  );
  const otherCompany = await ensure(
    "counterparty",
    "demo-beacon",
    "Beacon · synthetic company",
    { relationship: "customer" }
  );
  const contract = await ensure(
    "contract",
    "demo-harbor-agreement",
    "Harbor services · synthetic agreement",
    {
      status: "negotiating",
      counterparty_id: company,
      expiry_date: at(45).slice(0, 10),
      auto_renew: false,
      notice_days: 30,
    }
  );
  const document = async (
    slug: string,
    name: string,
    version: number,
    counterpartyId: number,
    available: string,
    text: string,
    agreementId?: number
  ) => {
    const record = await ensure(
      "legal-document",
      slug,
      name,
      {
        version,
        counterparty_id: counterpartyId,
        source_event_id: 0,
        available_at: available,
        ...(agreementId ? { contract_id: agreementId } : {}),
      },
      bank
    );
    const saved = await client.knowledge.save({
      title: name,
      content: text,
      semantic_type: "legal-document-evidence",
      entity_ids: [
        record,
        counterpartyId,
        ...(agreementId ? [agreementId] : []),
      ],
      occurred_at: available,
      idempotency_key: `synthetic-legal:${slug}`,
    });
    const current = await client.entities.get({ entity_id: record });
    if (!current.entity?.metadata?.source_event_id) {
      const updated = await client.entities.update({
        entity_id: record,
        metadata: { source_event_id: saved.id },
      });
      if (updated.approval_queued || updated.blocked_fields?.length)
        throw new Error("Demo evidence attachment requires approval.");
    }
    return { id: record, evidenceId: saved.id };
  };
  const v4 = await document(
    "demo-harbor-v4",
    "Harbor services v4 · synthetic",
    4,
    company,
    at(-1),
    "Section 8. Liability is capped at fees paid in the preceding twelve months. Section 9. Either party may terminate on thirty days' notice.",
    contract
  );
  const future = await document(
    "demo-harbor-v5",
    "Harbor services v5 · future synthetic revision",
    5,
    company,
    at(7),
    "Section 8. Liability is unlimited. This revision becomes available seven days after the demo cutoff.",
    contract
  );
  const unrelated = await document(
    "demo-beacon-v1",
    "Beacon services v1 · unrelated synthetic agreement",
    1,
    otherCompany,
    at(-1),
    "Beacon only: liability is capped at three times annual fees."
  );
  const agreement = await client.entities.get({ entity_id: contract });
  if (!agreement.entity?.metadata?.current_document_id) {
    const result = await client.entities.update({
      entity_id: contract,
      metadata: { current_document_id: v4.id },
    });
    if (result.approval_queued || result.blocked_fields?.length)
      throw new Error("Demo agreement document requires approval.");
  }
  const request = await ensure(
    "legal-request",
    "demo-harbor-review",
    "Review Harbor services · synthetic",
    {
      request_id: "SYNTHETIC-LEGAL-001",
      status: "new",
      matter_type: "commercial",
      summary: "Review the liability cap in Harbor services v4.",
      requester_id: requester,
      owner_id: counsel,
      counterparty_id: company,
      current_document_id: v4.id,
      contract_id: contract,
      knowledge_bank_id: bank,
      priority: "normal",
      sla_due_at: at(2),
    }
  );
  const guidance = await ensure(
    "legal-guidance",
    "demo-liability-answer",
    "Vendor liability cap · draft answer",
    {
      question: "What cap should we request?",
      answer:
        "Request a cap of fees paid in the preceding twelve months; escalate exceptions to counsel.",
      status: "draft",
      source_event_ids: [v4.evidenceId],
      counterparty_id: 0,
      effective_at: at(-1),
    },
    bank
  );
  const position = await ensure(
    "playbook-position",
    "demo-liability-position",
    "Liability · draft position",
    {
      clause: "Liability",
      preferred_position: "Twelve months of fees",
      fallback_position: "Only a counsel-approved exception",
      escalate_if: "Unlimited liability",
      rationale: "Synthetic policy awaiting approval.",
      status: "draft",
      source_event_ids: [v4.evidenceId],
      counterparty_id: 0,
      effective_at: at(-1),
    },
    bank
  );
  const obligation = await ensure(
    "legal-obligation",
    "demo-insurance-obligation",
    "Provide insurance certificate · synthetic",
    {
      contract_id: contract,
      due_at: at(5),
      status: "open",
      owner_id: counsel,
      summary: "Provide the agreed insurance certificate before onboarding.",
      source_event_id: v4.evidenceId,
    }
  );
  for (const [from, to, relation] of [
    [counsel, team, "works-with"],
    [requester, company, "works-with"],
    [v4.id, contract, "document-of"],
    [v4.id, company, "document-of"],
    [v4.id, request, "document-of"],
  ] as Array<[number, number, string]>) {
    const linked = async () =>
      (await client.query(
        `SELECT r.id FROM entity_relationships r JOIN entity_relationship_types t ON t.id = r.relationship_type_id WHERE r.from_entity_id = ${from} AND r.to_entity_id = ${to} AND t.slug = '${relation}' AND r.deleted_at IS NULL LIMIT 1`
      )) as Array<{ id: number }>;
    if (!(await linked()).length) {
      try {
        const result = await client.entities.link({
          from_entity_id: from,
          to_entity_id: to,
          relationship_type_slug: relation,
        });
        if ((result as { approval_queued?: boolean }).approval_queued)
          throw new Error("Demo relationship requires approval.");
      } catch (error) {
        if (!(await linked()).length) throw error;
      }
    }
  }
  return {
    folder,
    bank,
    team,
    counsel,
    requester,
    company,
    otherCompany,
    contract,
    v4,
    future,
    unrelated,
    request,
    guidance,
    position,
    obligation,
  };
}

export default async function seed(_ctx: unknown, client: ReactionClient) {
  return seedLegalDemo(client, new Date().toISOString());
}
