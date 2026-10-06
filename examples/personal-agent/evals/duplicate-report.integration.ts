import { readFileSync } from "node:fs";
import type { ReactionContext } from "@lobu/connector-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestAgent,
  createTestEntity,
  ownerToolContext,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import { TestWorkspace } from "../../../packages/server/src/__tests__/setup/test-mcp-client";
import { executeAutomationScript } from "../../../packages/server/src/automations/reaction-executor";
import type { Env } from "../../../packages/server/src/index";
import { createAutomationRun } from "../../../packages/server/src/runs/queue-service";
import { buildClientSDK } from "../../../packages/server/src/sandbox/client-sdk";
import config from "../lobu.config";

const script = readFileSync(
  new URL("../duplicate-report.reaction.ts", import.meta.url),
  "utf8"
);
const definition = config.automations!.find(
  (a) => a.slug === "duplicate-entity-resolution-real-v3-final"
)!;
afterEach(cleanupTestDatabase);

async function setup() {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({
    name: "Synthetic Duplicate Reports",
  });
  const seed = await createTestEntity({
    name: "Seed",
    entity_type: "person",
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: "synthetic-duplicate-agent",
  });
  const created = (await workspace.owner.automations.create({
    entity_id: seed.id,
    slug: "synthetic-duplicate-report",
    name: "Synthetic Duplicate Report",
    prompt: "Report only",
    managed_agent_id: agent.agentId,
    triggers: [
      { kind: "schedule", cron: "0 6 * * *", skip_if_unchanged: false },
    ],
  })) as { automation_id: string };
  const automationId = Number(created.automation_id);
  const run = await createAutomationRun({
    organizationId: workspace.org.id,
    automationId,
    agentId: agent.agentId,
    windowStart: "2026-10-01T00:00:00Z",
    windowEnd: "2026-10-02T00:00:00Z",
    dispatchSource: "manual",
  });
  const context: ReactionContext = {
    organization_id: workspace.org.id,
    organization_slug: workspace.org.slug,
    automation: {
      id: automationId,
      slug: "synthetic-duplicate-report",
      name: "Synthetic Duplicate Report",
      version: 1,
    },
    window: {
      automation_id: automationId,
      run_id: run.runId,
      window_start: "2026-10-01T00:00:00Z",
      window_end: "2026-10-02T00:00:00Z",
      content_analyzed: 0,
    },
    entities: [],
    extracted_data: { analysis_summary: "", uncertain_groups: [] },
  };
  const client = buildClientSDK(
    ownerToolContext(workspace.org.id, workspace.users.owner.id),
    {} as Env
  );
  const candidatePages = async () => {
    const rows: Array<Record<string, unknown>> = [];
    let after = 0;
    while (true) {
      const page = (await client.query(
        `SELECT * FROM (${(definition.sources!.people as { query: string }).query}) candidates WHERE id > ${after} ORDER BY id LIMIT 499`
      )) as Array<Record<string, unknown>>;
      if (!page.length) break;
      rows.push(...page);
      after = Number(page.at(-1)!.id);
    }
    return rows;
  };
  const react = () =>
    executeAutomationScript({ compiledScript: script, context, env: {} });
  const reports = () =>
    sql`SELECT id, metadata FROM events WHERE organization_id = ${workspace.org.id} AND metadata->>'schema' = 'duplicate-candidates/v2' ORDER BY id`;
  const notifications = () =>
    sql`SELECT id FROM events WHERE organization_id = ${workspace.org.id} AND semantic_type = 'notification' ORDER BY id`;
  let sequence = 0;
  const person = async (
    name: string,
    metadata: Record<string, unknown> = {}
  ) => {
    const entity = await createTestEntity({
      name: `Fixture ${++sequence}`,
      entity_type: "person",
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    await sql`UPDATE entities SET name = ${name}, metadata = ${sql.json(metadata as never)} WHERE id = ${entity.id}`;
    return entity.id;
  };
  return {
    sql,
    workspace,
    seed,
    context,
    react,
    reports,
    notifications,
    candidatePages,
    person,
  };
}

describe("duplicate report reaction", () => {
  it("reads more than 1000 candidates without splitting the boundary pair", async () => {
    const h = await setup();
    await h.person("Person 251");
    await h.sql`INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      SELECT ${h.workspace.org.id}, entity_type_id, 'Person ' || ((n+1)/2)::text, 'duplicate-fixture-' || n::text, '{}'::jsonb, ${h.workspace.users.owner.id}
      FROM entities CROSS JOIN generate_series(1, 1202) n WHERE id = ${h.seed.id}`;
    const rows = await h.candidatePages();
    expect(rows).toHaveLength(1203);
    expect(rows[499].match_reasons).toEqual(rows[500].match_reasons);
    expect(await h.react()).toMatchObject({
      success: true,
      returnValue: { candidate_count: 1203, group_count: 601 },
    });
    const reports = await h.reports();
    expect(reports).toHaveLength(1);
    expect(reports[0].metadata.candidates).toHaveLength(1203);
    expect(reports[0].metadata.groups).toHaveLength(601);
  });

  it("retains overlapping name/email/phone groups and excludes deleted, merged and test contacts before matching", async () => {
    const h = await setup();
    const a = await h.person("Shared Name", {
      email: "owner@sample.invalid",
      phone: "+44 1234 56789",
    });
    const b = await h.person("Shared Name", {
      company: "$5M {{fund}} O'Neil",
    });
    const c = await h.person("Other Name", {
      email: " OWNER@sample.invalid ",
      phone: "44123456789",
    });
    await h.person("Test Only");
    await h.person("Test Only", { email: "synthetic@example.test" });
    const deleted = await h.person("Shared Name");
    const merged = await h.person("Shared Name");
    await h.sql`UPDATE entities SET deleted_at = NOW() WHERE id = ${deleted}`;
    await h.sql`UPDATE entities SET merged_into = ${a} WHERE id = ${merged}`;
    expect(await h.react()).toMatchObject({
      success: true,
      returnValue: { candidate_count: 3, group_count: 3 },
    });
    expect((await h.reports())[0].metadata.groups).toEqual([
      { reason: "email:owner@sample.invalid", ids: [a, c] },
      { reason: "name:sharedname", ids: [a, b] },
      { reason: "phone:44123456789", ids: [a, c] },
    ]);
  });

  it("deduplicates concurrent retries, ignores incidental edits, and reopens same-day material evidence", async () => {
    const h = await setup();
    const a = await h.person("Shared Name", {
      company: "Original",
      x_handle: "sample",
    });
    await h.person("Shared Name", { company: "Original" });
    const before =
      await h.sql`SELECT id, name, metadata, deleted_at, merged_into FROM entities WHERE organization_id = ${h.workspace.org.id} ORDER BY id`;
    const concurrent = await Promise.all([h.react(), h.react()]);
    expect(concurrent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ success: true }),
        expect.objectContaining({ success: true }),
      ])
    );
    expect(await h.reports()).toHaveLength(1);
    expect(await h.notifications()).toHaveLength(1);
    expect(
      await h.sql`SELECT id, name, metadata, deleted_at, merged_into FROM entities WHERE organization_id = ${h.workspace.org.id} ORDER BY id`
    ).toEqual(before);
    await h.sql`UPDATE entities SET updated_at = NOW(), metadata = metadata || '{"last_interaction_at":"2026-10-03","x_handle":"sample"}'::jsonb WHERE id = ${a}`;
    expect(await h.react()).toMatchObject({ success: true });
    expect(await h.reports()).toHaveLength(1);
    expect(await h.notifications()).toHaveLength(1);
    await h.sql`UPDATE entities SET metadata = metadata || '{"company":"Changed","position":"Engineer"}'::jsonb WHERE id = ${a}`;
    expect(await h.react()).toMatchObject({ success: true });
    expect(await h.reports()).toHaveLength(2);
    expect(await h.notifications()).toHaveLength(2);
    const reports = await h.reports();
    expect(reports[0].metadata.fingerprint).not.toEqual(
      reports[1].metadata.fingerprint
    );
    expect(
      reports[1].metadata.candidates.find((row: { id: number }) => row.id === a)
        .evidence.company
    ).toBe("Changed");
    await h.sql`UPDATE entities SET metadata = metadata || '{"email":" SHARED@sample.invalid "}'::jsonb WHERE organization_id = ${h.workspace.org.id} AND name = 'Shared Name'`;
    expect(await h.react()).toMatchObject({
      success: true,
      returnValue: { candidate_count: 2, group_count: 2 },
    });
    expect(await h.reports()).toHaveLength(3);
    await h.sql`UPDATE entities SET metadata = metadata || '{"email":"shared@sample.invalid"}'::jsonb WHERE organization_id = ${h.workspace.org.id} AND name = 'Shared Name'`;
    expect(await h.react()).toMatchObject({ success: true });
    expect(await h.reports()).toHaveLength(3);
    expect(await h.notifications()).toHaveLength(3);
    await h.sql`UPDATE entities SET deleted_at = NOW() WHERE id = ${a}`;
    expect(await h.react()).toMatchObject({
      success: true,
      returnValue: { candidate_count: 0, group_count: 0 },
    });
    expect(await h.notifications()).toHaveLength(4);
  });
});
