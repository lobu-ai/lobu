/**
 * Per-row `entity_ids` on Automation event outputs.
 *
 * One run can write each output event onto its own record (a weekly digest
 * linking "renewal risk: Red" to company A and another to company B). A row's
 * `entity_ids` replace the Automation's bound entities for that row; omitting
 * the field keeps the bound-entity linkage. Each id goes through `requireWriteAccess`,
 * the same gate `save_memory` uses, and a bad id fails the completion with a
 * typed 403 instead of being dropped.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { type DbClient, parsePgNumberArray } from '../../../db/client';
import { createAutomationRun } from '../../../runs/queue-service';
import type { ToolContext } from '../../../tools/registry';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { persistAutomationEventOutput } from '../../../utils/persist-automation-event-output';
import { computePendingWindow } from '../../../utils/window-utils';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

interface Harness {
  sql: ReturnType<typeof getTestDb>;
  workspace: TestWorkspace;
  api: TestApiClient;
  bound: { id: number };
  companyA: { id: number };
  companyB: { id: number };
  automationId: number;
  agentId: string;
}

async function setup(
  outputs: Record<string, unknown>,
  boundEventKinds?: Record<string, unknown>
): Promise<Harness> {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({ name: 'Output Entity Ids Org' });
  await ensureMemberEntityType(workspace.org.id);
  const ownerUserId = workspace.users.owner.id;
  const make = (name: string) =>
    createTestEntity({ name, organization_id: workspace.org.id, created_by: ownerUserId });
  const bound = await createTestEntity({
    name: 'Portfolio',
    entity_type: 'portfolio',
    organization_id: workspace.org.id,
    created_by: ownerUserId,
  });
  if (boundEventKinds) {
    await sql`
      UPDATE entity_types SET event_kinds = ${sql.json(boundEventKinds)}
      WHERE organization_id = ${workspace.org.id} AND slug = 'portfolio'
    `;
  }
  const companyA = await make('Company A');
  const companyB = await make('Company B');
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: 'output-entity-ids-agent',
  });
  const api = await TestApiClient.for({
    organizationId: workspace.org.id,
    userId: ownerUserId,
    memberRole: 'owner',
  });
  const created = (await api.automations.create({
    entity_id: bound.id,
    slug: 'renewal-risk-digest',
    prompt: 'Write one renewal-risk event per company.',
    triggers: [{ kind: 'schedule', cron: '0 9 * * 1' }],
    outputs,
    managed_agent_id: agent.agentId,
  })) as { automation_id: string };
  return {
    sql,
    workspace,
    api,
    bound,
    companyA,
    companyB,
    automationId: Number(created.automation_id),
    agentId: agent.agentId,
  };
}

/** Claim the next window, then complete it with `extracted`. */
async function completeRun(h: Harness, extracted: Record<string, unknown>) {
  await h.sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '10 minutes' WHERE id = ${h.automationId}`;
  const pending = await computePendingWindow(h.sql as unknown as DbClient, h.automationId);
  const queued = await createAutomationRun({
    organizationId: h.workspace.org.id,
    automationId: h.automationId,
    agentId: h.agentId,
    windowStart: pending.windowStart.toISOString(),
    windowEnd: pending.windowEnd.toISOString(),
    dispatchSource: 'scheduled',
  });
  await h.sql`
    UPDATE runs SET status = 'running', claimed_at = NOW(), claimed_by = ${`lobu:${h.agentId}`}
    WHERE id = ${queued.runId}
  `;
  const knowledge = (await h.api.knowledge.read({
    automation_id: h.automationId,
    run_id: queued.runId,
  })) as { window_token: string };
  await h.api.automations.completeWindow({
    automation_id: String(h.automationId),
    window_token: knowledge.window_token,
    extracted_data: extracted,
    run_id: queued.runId,
  });
  return queued.runId;
}

async function outputRows(h: Harness) {
  const rows = await h.sql<{
    id: number;
    payload_text: string;
    entity_ids: unknown;
    supersedes_event_id: number | null;
    superseded_by: number | null;
  }>`
    SELECT id, payload_text, entity_ids, supersedes_event_id, superseded_by
    FROM events
    WHERE organization_id = ${h.workspace.org.id}
      AND metadata->>'automation_output' = 'risks'
    ORDER BY id
  `;
  return rows.map((row) => ({
    ...row,
    id: Number(row.id),
    entity_ids: parsePgNumberArray(row.entity_ids),
    supersedes_event_id: row.supersedes_event_id == null ? null : Number(row.supersedes_event_id),
    superseded_by: row.superseded_by == null ? null : Number(row.superseded_by),
  }));
}

describe('Automation event output entity_ids', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('links each output row to the entities it names, replacing the bound entity', async () => {
    const h = await setup({ risks: { event: 'observation' } });
    await completeRun(h, {
      risks: [
        { content: 'renewal risk: Red', entity_ids: [h.companyA.id] },
        { content: 'renewal risk: Amber', entity_ids: [h.companyB.id] },
      ],
    });

    const rows = await outputRows(h);
    expect(rows.map((row) => [row.payload_text, row.entity_ids])).toEqual([
      ['renewal risk: Red', [h.companyA.id]],
      ['renewal risk: Amber', [h.companyB.id]],
    ]);
  });

  it('keeps the bound-entity linkage when a row omits entity_ids', async () => {
    const h = await setup({ risks: { event: 'observation' } });
    await completeRun(h, {
      risks: [
        { content: 'portfolio summary' },
        { content: 'company B only', entity_ids: [h.companyB.id] },
      ],
    });

    const rows = await outputRows(h);
    expect(rows.map((row) => [row.payload_text, row.entity_ids])).toEqual([
      ['portfolio summary', [h.bound.id]],
      ['company B only', [h.companyB.id]],
    ]);
  });

  it('validates a custom event kind against the row links instead of the bound entity', async () => {
    const h = await setup({ risks: { event: 'renewal_risk' } }, {
      renewal_risk: {
        metadataSchema: {
          type: 'object',
          properties: { portfolio: { type: 'boolean' } },
          required: ['portfolio'],
        },
      },
    });
    const typed = await createTestEntity({
      name: 'Typed company',
      entity_type: 'renewal-account',
      organization_id: h.workspace.org.id,
      created_by: h.workspace.users.owner.id,
    });
    await h.sql`
      UPDATE entity_types
      SET event_kinds = ${h.sql.json({ renewal_risk: { description: 'Renewal risk' } })}
      WHERE organization_id = ${h.workspace.org.id} AND slug = 'renewal-account'
    `;

    await completeRun(h, {
      risks: [{
        content: 'renewal risk: Red',
        metadata: { risk: 'red' },
        entity_ids: [h.companyA.id, typed.id],
      }],
    });
    const rows = await outputRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_ids).toEqual([h.companyA.id, typed.id]);

    await expect(
      completeRun(h, {
        risks: [{ content: 'untyped company', entity_ids: [h.companyA.id] }],
      })
    ).rejects.toThrow(/Invalid event in outputs\.risks\[0\]/);
    expect(await outputRows(h)).toEqual(rows);
  });

  it('rejects an entity from another organization and writes nothing', async () => {
    const h = await setup({ risks: { event: 'observation' } });
    const other = await TestWorkspace.create({ name: 'Foreign Org' });
    const foreign = await createTestEntity({
      name: 'Foreign company',
      organization_id: other.org.id,
      created_by: other.users.owner.id,
    });

    await expect(
      completeRun(h, {
        risks: [
          { content: 'renewal risk: Red', entity_ids: [h.companyA.id] },
          { content: 'leak attempt', entity_ids: [foreign.id] },
        ],
      })
    ).rejects.toThrow(/outputs\.risks\[1\]\.entity_ids.*not found in this workspace/);
    expect(await outputRows(h)).toEqual([]);
  });

  it('rejects an entity id that does not exist', async () => {
    const h = await setup({ risks: { event: 'observation' } });
    await expect(
      completeRun(h, {
        risks: [{ content: 'ghost', entity_ids: [987654321] }],
      })
    ).rejects.toThrow(/outputs\.risks\[0\]\.entity_ids.*not found in this workspace/);
    expect(await outputRows(h)).toEqual([]);
  });

  it('rejects entity ids the run identity may not write', async () => {
    const h = await setup({ risks: { event: 'observation' } });
    const memberCtx: ToolContext = {
      organizationId: h.workspace.org.id,
      userId: h.workspace.users.member.id,
      memberRole: 'member',
      isAuthenticated: true,
    } as ToolContext;
    const [run] = await h.sql<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, automation_id, approval_status, status)
      VALUES (${h.workspace.org.id}, 'automation', ${h.automationId}, 'auto', 'running')
      RETURNING id
    `;

    await expect(
      h.sql.begin((tx) =>
        persistAutomationEventOutput({
          tx: tx as unknown as DbClient,
          ctx: memberCtx,
          rows: [{ content: 'not mine to write', entity_ids: [h.companyA.id] }],
          outputName: 'risks',
          output: { event: 'observation' },
          automationId: h.automationId,
          versionId: null,
          organizationId: h.workspace.org.id,
          runId: Number(run.id),
          boundEntityIds: [h.bound.id],
          validContentIds: new Set<number>(),
          occurredAt: new Date().toISOString(),
        })
      )
    ).rejects.toMatchObject({ httpStatus: 403 });
    expect(await outputRows(h)).toEqual([]);
  });

  it('keeps key/supersede identity independent of entity linkage', async () => {
    const h = await setup({ risks: { event: 'observation', key: ['company'] } });
    await completeRun(h, {
      risks: [
        { content: 'A: Green', metadata: { company: 'a' }, entity_ids: [h.companyA.id] },
        { content: 'B: Green', metadata: { company: 'b' }, entity_ids: [h.companyB.id] },
      ],
    });
    await completeRun(h, {
      risks: [{ content: 'A: Red', metadata: { company: 'a' }, entity_ids: [h.companyA.id] }],
    });

    let rows = await outputRows(h);
    const [aV1, bV1, aV2] = rows;
    expect(aV2).toMatchObject({ payload_text: 'A: Red', supersedes_event_id: aV1.id, superseded_by: null });
    expect(aV2.entity_ids).toEqual([h.companyA.id]);
    expect(bV1).toMatchObject({ payload_text: 'B: Green', superseded_by: null });
    expect(bV1.entity_ids).toEqual([h.companyB.id]);

    // The key alone is the identity: one key cannot carry two entity linkages
    // in one run, even when the rows name different entities.
    await expect(
      completeRun(h, {
        risks: [
          { content: 'A on A', metadata: { company: 'a' }, entity_ids: [h.companyA.id] },
          { content: 'A on B', metadata: { company: 'a' }, entity_ids: [h.companyB.id] },
        ],
      })
    ).rejects.toThrow(/duplicate key \(company\)/);

    // A later version of a key carries ITS row's linkage, so re-pointing a key
    // moves the current head onto the newly named entity.
    await completeRun(h, {
      risks: [{ content: 'A: moved', metadata: { company: 'a' }, entity_ids: [h.companyB.id] }],
    });
    rows = await outputRows(h);
    const head = rows.find((row) => row.payload_text === 'A: moved');
    expect(head).toMatchObject({ supersedes_event_id: aV2.id, superseded_by: null });
    expect(head?.entity_ids).toEqual([h.companyB.id]);
  });
});
