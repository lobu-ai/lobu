import { readFileSync } from "node:fs";
import type {
  AutomationScriptContext,
  ReactionContext,
} from "@lobu/connector-sdk";
import { afterEach, expect, test } from "vitest";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestAgent,
  ownerToolContext,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import { TestWorkspace } from "../../../packages/server/src/__tests__/setup/test-mcp-client";
import { executeAutomationScript } from "../../../packages/server/src/automations/reaction-executor";
import type { Env } from "../../../packages/server/src/index";
import { createAutomationRun } from "../../../packages/server/src/runs/queue-service";
import { buildClientSDK } from "../../../packages/server/src/sandbox/client-sdk";
import {
  executeTool,
  type AuthContext,
} from "../../../packages/server/src/tools/execute";
import { seedLegalDemo } from "../demo";
import config from "../lobu.config";
import type { ReviewCase } from "../legal-workflows.reaction";

const reviewSource = readFileSync(
  new URL("../legal-workflows.reaction.ts", import.meta.url),
  "utf8"
);
const maintenanceSource = readFileSync(
  new URL("../legal-maintenance.reaction.ts", import.meta.url),
  "utf8"
);
const viewSource = readFileSync(
  new URL("../views/review.tsx", import.meta.url),
  "utf8"
);
afterEach(cleanupTestDatabase);

async function setup() {
  const workspace = await TestWorkspace.create({ name: "Synthetic Legal" });
  const sql = getTestDb();
  for (const type of config.entities ?? []) {
    await workspace.owner.entity_schema.createType({
      slug: type.key,
      name: type.name ?? type.key,
      metadata_schema: {
        type: "object",
        properties: type.properties ?? {},
        required: type.required ?? [],
      },
      event_kinds: type.eventKinds,
      ...(type.rules
        ? {
            rules_source: readFileSync(
              new URL(`../${type.rules.path}`, import.meta.url),
              "utf8"
            ),
          }
        : {}),
    });
  }
  for (const relation of config.relationships ?? []) {
    await workspace.owner.entity_schema.createRelType({
      slug: relation.key,
      name: relation.name ?? relation.key,
    });
    for (const rule of relation.rules ?? [])
      await workspace.owner.entity_schema.addRule({
        slug: relation.key,
        source_entity_type_slug: rule.source,
        target_entity_type_slug: rule.target,
      });
  }
  const auth = {
    ...ownerToolContext(workspace.org.id, workspace.users.owner.id),
    tokenOrganizationId: workspace.org.id,
  } as AuthContext;
  const client = buildClientSDK(
    ownerToolContext(workspace.org.id, workspace.users.owner.id),
    {} as Env
  );
  const asOf = new Date(Date.now() + 60_000).toISOString();
  const data = await seedLegalDemo(client, asOf);
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: "synthetic-legal-agent",
  });
  const automations = new Map<string, number>();
  const context = async (
    slug: string,
    windowStart = new Date(Date.parse(asOf) - 86_400_000).toISOString()
  ): Promise<ReactionContext & AutomationScriptContext> => {
    if (!automations.has(slug)) {
      const created = (await workspace.owner.automations.create({
        entity_id: data.folder,
        slug,
        name: slug,
        prompt: "Synthetic legal workflow",
        managed_agent_id: agent.agentId,
        triggers: [
          { kind: "schedule", cron: "* * * * *", skip_if_unchanged: false },
        ],
      })) as { automation_id: string };
      automations.set(slug, Number(created.automation_id));
    }
    const automationId = automations.get(slug)!;
    await sql`UPDATE runs SET status = 'completed', completed_at = now() WHERE organization_id = ${workspace.org.id} AND automation_id = ${automationId} AND status IN ('pending','running')`;
    const run = await createAutomationRun({
      organizationId: workspace.org.id,
      automationId,
      agentId: agent.agentId,
      windowStart,
      windowEnd: asOf,
      dispatchSource: "manual",
    });
    return {
      organization_id: workspace.org.id,
      organization_slug: workspace.org.slug,
      automation: { id: automationId, slug, name: slug, version: 1 },
      window: {
        automation_id: automationId,
        run_id: run.runId,
        window_start: windowStart,
        window_end: asOf,
        content_analyzed: 0,
      },
      entities: [],
      trigger_signals: [],
      extracted_data: {},
    };
  };
  const maintain = async (slug: string, windowStart?: string) =>
    executeAutomationScript({
      compiledScript: maintenanceSource,
      context: await context(slug, windowStart),
      env: {},
    });
  const prepare = async () =>
    executeAutomationScript({
      compiledScript: reviewSource,
      context: await context("legal-first-pass"),
      entryExport: "prepare",
      env: {},
    });
  const get = async (entityId: number) =>
    (await workspace.owner.entities.get({ entity_id: entityId })).entity!;
  const reviews = () =>
    sql`SELECT id, metadata FROM events WHERE organization_id = ${workspace.org.id} AND semantic_type = 'legal-review' ORDER BY id`;
  const save = async (
    cases: ReviewCase[],
    overrides: Record<string, unknown> = {}
  ) => {
    const ctx = await context("legal-first-pass");
    ctx.sources = { cases: cases as unknown as Record<string, unknown>[] };
    ctx.extracted_data = {
      reviews: cases.map((c) => ({
        entity_id: c.entity_id,
        document_id: c.document_id,
        summary: "Counsel should review the twelve-month cap.",
        evidence_ids: c.evidence.map((e) => e.id),
        findings: [
          {
            clause: "Liability",
            risk: "medium",
            rationale: "Compare this exact cap with the approved position.",
            evidence_id: c.evidence[0].id,
            quote:
              "Liability is capped at fees paid in the preceding twelve months.",
          },
        ],
        ...overrides,
      })),
    };
    return executeAutomationScript({
      compiledScript: reviewSource,
      context: ctx,
      env: {},
    });
  };
  const decide = async (
    reviewId: number,
    action = "negotiate",
    instruction: unknown = "Keep the twelve-month cap; do not accept unlimited liability.",
    reuse: unknown = true,
    interactionId = `synthetic-${reviewId}-${action}`
  ) => {
    await workspace.owner.views.set({ source_code: viewSource });
    return executeTool(
      "invoke_view_action",
      {
        view: "legal-review",
        scope: { event: reviewId },
        action,
        value: { instruction, reuse },
        interaction_id: interactionId,
      },
      {} as Env,
      auth
    ) as Promise<{ event_id: number }>;
  };
  return {
    workspace,
    client,
    sql,
    data,
    asOf,
    maintain,
    prepare,
    save,
    get,
    reviews,
    decide,
  };
}

async function prepared(h: Awaited<ReturnType<typeof setup>>) {
  expect(await h.maintain("legal-intake-triage")).toMatchObject({
    success: true,
    returnValue: { triaged: 1 },
  });
  const result = await h.prepare();
  expect(result).toMatchObject({ success: true });
  return (result.returnValue as { cases: ReviewCase[] }).cases;
}

test("the legal example stores linked people, folders, Knowledge Banks and original evidence through the SDK", async () => {
  const h = await setup();
  expect((await h.get(h.data.bank)).parent_id).toBe(h.data.folder);
  expect((await h.get(h.data.counsel)).metadata.role).toBe("counsel");
  expect((await h.get(h.data.contract)).metadata.auto_renew).toBe(false);
  const replay = await seedLegalDemo(h.client, h.asOf);
  expect(replay).toEqual(h.data);
  const cases = await prepared(h);
  expect(cases).toHaveLength(1);
  expect(cases[0].evidence.map((e) => e.id)).toEqual([h.data.v4.evidenceId]);
  expect(cases[0].guidance).toEqual([]);
  expect(cases[0].positions).toEqual([]);
  expect(JSON.stringify(cases)).not.toContain("Beacon only");
  expect(JSON.stringify(cases)).not.toContain(
    "This revision becomes available"
  );
});

test("native human receipts apply to the displayed revision, survive retries and carry instructions into a re-review", async () => {
  const h = await setup();
  const cases = await prepared(h);
  expect(await h.save(cases)).toMatchObject({ success: true });
  const [review] = await h.reviews();
  const receipt = await h.decide(Number(review.id));
  const [event] =
    await h.sql`SELECT semantic_type, metadata FROM events WHERE id = ${receipt.event_id}`;
  expect(event.semantic_type).toBe("legal-decision");
  expect(event.metadata.interaction.value.instruction).toContain(
    "Keep the twelve-month cap"
  );
  expect(await h.maintain("legal-decisions")).toMatchObject({
    success: true,
    returnValue: { applied: 1 },
  });
  expect((await h.get(h.data.request)).metadata).toMatchObject({
    status: "negotiating",
    last_decision_id: receipt.event_id,
    decision_document_id: h.data.v4.id,
  });
  expect(await h.maintain("legal-decisions")).toMatchObject({
    success: true,
    returnValue: { applied: 0 },
  });
  const guidance = await h.workspace.owner.entities.list({
    entity_type: "legal-guidance",
  });
  expect(guidance.entities).toHaveLength(2);
  expect(
    guidance.entities.find((e) => e.slug === `decision-${receipt.event_id}`)
      ?.metadata
  ).toMatchObject({ status: "draft", counterparty_id: h.data.company });
  await h.workspace.owner.entities.update({
    entity_id: h.data.contract,
    metadata: { current_document_id: h.data.unrelated.id },
  });
  expect(await h.maintain("legal-intake-triage")).toMatchObject({
    success: false,
  });
  const revision = await h.workspace.owner.entities.create({
    entity_type: "legal-document",
    name: "Synthetic negotiated revision",
    metadata: {
      version: 6,
      counterparty_id: h.data.company,
      source_event_id: 0,
      available_at: new Date(Date.parse(h.asOf) - 1000).toISOString(),
      contract_id: h.data.contract,
    },
  });
  const revisionId = Number(revision.entity!.id);
  const source = await h.workspace.owner.knowledge.save({
    title: "Synthetic negotiated source",
    content: cases[0].evidence[0].content,
    semantic_type: "legal-document-evidence",
    entity_ids: [revisionId, h.data.company, h.data.contract],
  });
  await h.workspace.owner.entities.update({
    entity_id: revisionId,
    metadata: { source_event_id: source.id },
  });
  await h.workspace.owner.entities.update({
    entity_id: h.data.contract,
    metadata: { current_document_id: revisionId },
  });
  const again = await prepared(h);
  expect(again[0].document_id).toBe(revisionId);
  expect(again[0].instruction).toContain("Keep the twelve-month cap");
  expect(again[0].prior_decisions).toHaveLength(1);
  expect(await h.save(again)).toMatchObject({ success: true });
  const current = (await h.reviews()).at(-1)!;
  // Receipts a client can submit but the view would refuse (over-long or
  // non-string instruction, non-boolean reuse) neither block the decision
  // behind them nor stop a window holding more than one page of receipts.
  for (let i = 0; i < 101; i++) {
    await h.decide(
      Number(current.id),
      "escalate",
      i % 3 === 0 ? "x".repeat(1501) : i % 3 === 1 ? 42 : "Escalate.",
      i % 3 === 2 ? "yes" : false,
      `synthetic-malformed-${i}`
    );
  }
  await h.decide(Number(current.id), "approve", "Ready for signature.", false);
  for (let batch = 0; batch < 4; batch++) {
    expect(
      await h.maintain(
        "legal-decisions",
        batch > 0 ? new Date(Date.parse(h.asOf) - 1).toISOString() : undefined
      )
    ).toMatchObject({
      success: true,
      returnValue: { applied: 0, rejected: 25, has_more: true },
    });
    expect((await h.get(h.data.request)).metadata.status).toBe(
      "awaiting_decision"
    );
  }
  // The native arrival window has advanced beyond these receipts. The saved
  // cursor must still carry the final malformed row and valid decision forward.
  const advancedStart = new Date(Date.parse(h.asOf) - 1).toISOString();
  expect(await h.maintain("legal-decisions", advancedStart)).toMatchObject({
    success: true,
    returnValue: { applied: 1, rejected: 1, has_more: false },
  });
  expect(await h.maintain("legal-decisions", advancedStart)).toMatchObject({
    success: true,
    returnValue: { applied: 0, rejected: 0, has_more: false },
  });
  expect((await h.get(h.data.request)).metadata.status).toBe("approved");
  expect((await h.get(h.data.contract)).metadata.status).toBe("negotiating");
});

test("fabricated citations and quotes persist no review and unavailable evidence fails closed", async () => {
  const h = await setup();
  const cases = await prepared(h);
  expect(
    await h.save(cases, { evidence_ids: [h.data.unrelated.evidenceId] })
  ).toMatchObject({ success: false });
  expect(
    await h.save(cases, {
      findings: [
        {
          clause: "Liability",
          risk: "low",
          rationale: "Invented",
          evidence_id: h.data.v4.evidenceId,
          quote: "A cap which is not in the document",
        },
      ],
    })
  ).toMatchObject({ success: false });
  expect(await h.reviews()).toHaveLength(0);
  await expect(
    h.workspace.owner.entities.update({
      entity_id: h.data.v4.id,
      metadata: { source_event_id: h.data.unrelated.evidenceId },
    })
  ).rejects.toThrow();
  const wrong = await h.workspace.owner.entities.create({
    entity_type: "legal-document",
    name: "Synthetic wrong evidence reference",
    metadata: {
      version: 7,
      counterparty_id: h.data.company,
      source_event_id: h.data.unrelated.evidenceId,
      available_at: new Date(Date.parse(h.asOf) - 1000).toISOString(),
      contract_id: h.data.contract,
    },
  });
  await h.workspace.owner.entities.update({
    entity_id: h.data.contract,
    metadata: { current_document_id: Number(wrong.entity!.id) },
  });
  expect(await h.maintain("legal-intake-triage")).toMatchObject({
    success: true,
  });
  expect(await h.prepare()).toMatchObject({ success: false });
  await h.workspace.owner.entities.update({
    entity_id: h.data.contract,
    metadata: { current_document_id: h.data.future.id },
  });
  expect(await h.maintain("legal-intake-triage")).toMatchObject({
    success: false,
  });
  const otherAgreement = await h.workspace.owner.entities.create({
    entity_type: "contract",
    name: "Another synthetic agreement for the same company",
    metadata: { counterparty_id: h.data.company },
  });
  const otherDocument = await h.workspace.owner.entities.create({
    entity_type: "legal-document",
    name: "Synthetic same-company document from another agreement",
    metadata: {
      version: 1,
      counterparty_id: h.data.company,
      contract_id: Number(otherAgreement.entity!.id),
      source_event_id: 0,
      available_at: new Date(Date.parse(h.asOf) - 1000).toISOString(),
    },
  });
  const otherId = Number(otherDocument.entity!.id);
  const otherSource = await h.workspace.owner.knowledge.save({
    title: "Synthetic other agreement evidence",
    content: "This is a different agreement for the same company.",
    semantic_type: "legal-document-evidence",
    entity_ids: [otherId],
  });
  await h.workspace.owner.entities.update({
    entity_id: otherId,
    metadata: { source_event_id: otherSource.id },
  });
  await h.workspace.owner.entities.update({
    entity_id: h.data.contract,
    metadata: { current_document_id: otherId },
  });
  await h.workspace.owner.entities.update({
    entity_id: h.data.request,
    metadata: {
      current_document_id: otherId,
      status: "new",
      review_event_id: 0,
    },
  });
  expect(await h.maintain("legal-intake-triage")).toMatchObject({
    success: false,
  });
  await h.workspace.owner.entities.update({
    entity_id: h.data.request,
    metadata: { status: "triaged" },
  });
  expect(await h.prepare()).toMatchObject({ success: false });
  // The SQL bridge returns bigint[] as text. A different record whose ID
  // contains the selected ID must never count as a linked revision.
  const selected = await h.workspace.owner.entities.create({
    entity_type: "legal-document",
    name: "Synthetic selected revision with mismatched source",
    metadata: {
      version: 8,
      counterparty_id: h.data.company,
      contract_id: h.data.contract,
      source_event_id: 0,
      available_at: new Date(Date.parse(h.asOf) - 1000).toISOString(),
    },
  });
  const selectedId = Number(selected.entity!.id);
  // Control only the fixture's next generated ID; both records and evidence
  // still go through the real SDK entrypoints.
  await h.sql`SELECT setval(pg_get_serial_sequence('entities', 'id'), ${selectedId * 10}, false)`;
  const decoy = await h.workspace.owner.entities.create({
    entity_type: "legal-document",
    name: "Synthetic decoy revision",
    metadata: {
      version: 9,
      counterparty_id: h.data.company,
      contract_id: h.data.contract,
      source_event_id: 0,
      available_at: new Date(Date.parse(h.asOf) - 1000).toISOString(),
    },
  });
  expect(Number(decoy.entity!.id)).toBe(selectedId * 10);
  const decoyEvidence = await h.workspace.owner.knowledge.save({
    title: "Evidence for the decoy, not the selected revision",
    content: "This source belongs to another revision.",
    semantic_type: "legal-document-evidence",
    entity_ids: [Number(decoy.entity!.id)],
  });
  await h.workspace.owner.entities.update({
    entity_id: selectedId,
    metadata: { source_event_id: decoyEvidence.id },
  });
  await h.workspace.owner.entities.update({
    entity_id: h.data.contract,
    metadata: { current_document_id: selectedId },
  });
  await h.workspace.owner.entities.update({
    entity_id: h.data.request,
    metadata: {
      current_document_id: selectedId,
      status: "new",
      review_event_id: 0,
    },
  });
  await h.workspace.owner.entities.update({
    entity_id: h.data.request,
    metadata: { status: "triaged" },
  });
  expect(await h.prepare()).toMatchObject({ success: false });
});

test("renewal and obligation suggestions preserve dismissals while operations stay current", async () => {
  const h = await setup();
  expect(await h.maintain("legal-monitoring")).toMatchObject({
    success: true,
    returnValue: { alerts: 2 },
  });
  const suggestions = await h.workspace.owner.entities.list({
    entity_type: "legal-suggestion",
  });
  expect(suggestions.entities).toHaveLength(2);
  await h.workspace.owner.entities.update({
    entity_id: suggestions.entities[0].id,
    metadata: { status: "dismissed" },
  });
  expect(await h.maintain("legal-monitoring")).toMatchObject({ success: true });
  expect((await h.get(suggestions.entities[0].id)).metadata.status).toBe(
    "dismissed"
  );
  expect(
    (await h.workspace.owner.entities.list({ entity_type: "legal-suggestion" }))
      .entities
  ).toHaveLength(2);
  const snapshots = await h.workspace.owner.entities.list({
    entity_type: "legal-ops-snapshot",
  });
  expect(snapshots.entities).toHaveLength(1);
  expect(snapshots.entities[0].metadata).toMatchObject({
    open_requests: 1,
    approvals: 0,
    completed: 0,
  });
});

test("reusable guidance needs native human approval and stale review writes cannot cross revisions", async () => {
  const h = await setup();
  const pending = await h.workspace.owner.entities.update({
    entity_id: h.data.guidance,
    metadata: { status: "approved" },
  });
  expect(pending.approval_queued).toBe(true);
  expect((await h.get(h.data.guidance)).metadata.status).toBe("draft");
  await h.workspace.owner
    .withAuth({ tokenType: "session" })
    .operations.approve({ run_id: pending.approval_run_id! });
  expect((await h.get(h.data.guidance)).metadata.status).toBe("approved");
  const cases = await prepared(h);
  expect(cases[0].guidance.map((g) => g.id)).toEqual([h.data.guidance]);
  expect(await h.save(cases)).toMatchObject({ success: true });
  const [review] = await h.reviews();
  await expect(
    h.workspace.owner.entities.update({
      entity_id: h.data.request,
      metadata: {
        review_event_id: review.id,
        review_document_id: h.data.future.id,
      },
    })
  ).rejects.toThrow();
  await expect(
    h.workspace.owner.entities.update({
      entity_id: h.data.request,
      metadata: {
        last_decision_id: 999999,
        decision_document_id: h.data.future.id,
        decision_review_id: review.id,
      },
    })
  ).rejects.toThrow();
  expect((await h.get(h.data.request)).metadata).toMatchObject({
    current_document_id: h.data.v4.id,
    status: "awaiting_decision",
  });
});

test("intake assigns a single suitable counsel and retries a blocked request when facts arrive", async () => {
  const h = await setup();
  const missing = await h.workspace.owner.entities.create({
    entity_type: "legal-request",
    name: "Synthetic incomplete intake",
    metadata: { request_id: "SYNTHETIC-MISSING", status: "new" },
  });
  const entityId = Number(missing.entity!.id);
  expect(await h.maintain("legal-intake-triage")).toMatchObject({
    success: true,
    returnValue: { triaged: 1 },
  });
  expect((await h.get(entityId)).metadata.status).toBe("blocked");
  await h.workspace.owner.entities.update({
    entity_id: entityId,
    metadata: {
      requester_id: h.data.requester,
      counterparty_id: h.data.company,
      current_document_id: h.data.v4.id,
      contract_id: h.data.contract,
      knowledge_bank_id: h.data.bank,
      matter_type: "commercial",
    },
  });
  expect(await h.maintain("legal-intake-triage")).toMatchObject({
    success: true,
    returnValue: { triaged: 1 },
  });
  expect((await h.get(entityId)).metadata).toMatchObject({
    status: "triaged",
    owner_id: h.data.counsel,
  });
});
