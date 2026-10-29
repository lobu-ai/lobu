/**
 * Compact automation feedback contract.
 *
 * High-value coverage retained from the deleted feedback suite: the feedback
 * API is the durable human-correction path for automation outputs, so it must
 * store field-level mutations transactionally, return scoped feedback, validate
 * malformed corrections, and block cross-org writes.
 *
 * Corrections live only on the events spine (semantic_type='correction'): the
 * dedicated window-feedback table is retired, and the prompt summary future
 * runs read is rendered from those events.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { manageAutomations } from '../../../tools/admin/manage_automations';
import type { ToolContext } from '../../../tools/registry';
import { getRecentFeedbackSummary } from '../../../utils/automation-feedback';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createAutomationResultRun, createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

function ownerCtx(workspace: TestWorkspace): ToolContext {
  return {
    organizationId: workspace.org.id,
    userId: workspace.users.owner.id,
    memberRole: 'owner',
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
  };
}

async function seedAutomation(
  workspace: TestWorkspace,
  suffix: string,
  // Defaults to a period that has already closed.
  windowEnd: Date = new Date()
) {
  const entity = await createTestEntity({
    name: `Feedback Entity ${suffix}`,
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
  });
  const automation = (await workspace.owner.automations.create({
    entity_id: entity.id,
    slug: `feedback-automation-${suffix}`,
    name: `Feedback Automation ${suffix}`,
    prompt: 'Analyze inputs.',
    managed_agent_id: agent.agentId,
  })) as { automation_id: string };

  const runId = await createAutomationResultRun({
    automationId: Number(automation.automation_id),
    organizationId: workspace.org.id,
    windowStart: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    windowEnd,
    extractedData: { problems: [{ name: 'A', severity: 'low' }] },
    createdBy: workspace.users.owner.id,
    entityIds: [entity.id],
  });

  return { automationId: automation.automation_id, runId };
}

describe('automation feedback contract', () => {
  let workspace: TestWorkspace;
  let automationId: string;
  let runId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    workspace = await TestWorkspace.create({ name: 'Feedback Contract Org' });
    const seeded = await seedAutomation(workspace, 'primary');
    automationId = seeded.automationId;
    runId = seeded.runId;
  });

  beforeEach(async () => {
    // Corrections are now append-only 'correction' events; use the documented
    // escape hatch to isolate each test (the dedicated feedback table was
    // retired in the P1 consolidation).
    await getTestDb().begin(async (tx) => {
      await tx`SET LOCAL lobu.allow_event_delete = 'on'`;
      await tx`
        DELETE FROM events
        WHERE semantic_type = 'correction'
          AND (metadata->>'automation_id')::bigint = ${Number(automationId)}
      `;
    });
  });

  it('stores set/remove/add field corrections from one batch as separate correction events', async () => {
    const result = (await manageAutomations(
      {
        action: 'submit_feedback',
        automation_id: automationId,
        run_id: runId,
        corrections: [
          {
            field_path: 'problems[0].severity',
            value: 'high',
            note: 'misclassified',
          },
          { field_path: 'problems[0]', mutation: 'remove' },
          {
            field_path: 'problems',
            mutation: 'add',
            value: { name: 'B', severity: 'medium' },
          },
        ],
      } as never,
      {} as never,
      ownerCtx(workspace)
    )) as { feedback_ids: number[] };

    expect(result.feedback_ids).toHaveLength(3);

    const rows = await getTestDb()`
      SELECT metadata->>'field_path' AS field_path, metadata->>'mutation' AS mutation,
             metadata->'corrected_value' AS corrected_value, metadata->>'note' AS note
      FROM events
      WHERE semantic_type = 'correction' AND (metadata->>'automation_id')::bigint = ${Number(automationId)}
      ORDER BY metadata->>'field_path' ASC
    `;
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => `${row.field_path}:${row.mutation}`)).toEqual([
      'problems:add',
      'problems[0]:remove',
      'problems[0].severity:set',
    ]);
    expect(rows.find((row) => row.field_path === 'problems[0].severity')?.corrected_value).toBe(
      'high'
    );
    expect(rows.find((row) => row.field_path === 'problems')?.corrected_value).toEqual({
      name: 'B',
      severity: 'medium',
    });
  });

  it('feedback ids are the correction event ids; historical wwff_ origin_ids still parse', async () => {
    // After the dedicated feedback sequence was dropped, a new correction's
    // feedback id IS its event id (origin_id NULL). Historical rows carry
    // origin_id 'wwff_<seq>' and the reader recovers the legacy id from it.
    const sql = getTestDb();
    const result = (await manageAutomations(
      {
        action: 'submit_feedback',
        automation_id: automationId,
        run_id: runId,
        corrections: [{ field_path: 'summary', value: 'id-contract', note: 'id check' }],
      } as never,
      {} as never,
      ownerCtx(workspace)
    )) as { feedback_ids: number[] };
    expect(result.feedback_ids).toHaveLength(1);
    const [ev] = await sql`
      SELECT id, origin_id FROM events
      WHERE semantic_type = 'correction'
        AND (metadata->>'automation_id')::bigint = ${Number(automationId)}
        AND metadata->>'field_path' = 'summary'
    `;
    expect(Number(ev.id)).toBe(result.feedback_ids[0]);
    expect(ev.origin_id).toBeNull();

    // Seed a historical (pre-3b) correction row with a wwff_ origin_id.
    await sql`
      INSERT INTO events (organization_id, semantic_type, entity_ids, origin_id, run_id, metadata, occurred_at, created_at)
      VALUES (${workspace.org.id}, 'correction', '{}'::bigint[], 'wwff_424242', ${Number(runId)},
        ${sql.json({ automation_id: Number(automationId), field_path: 'legacy.field', mutation: 'set', corrected_value: 'old', note: null })},
        NOW(), NOW())
    `;
    const feedback = (await manageAutomations(
      {
        action: 'get_feedback',
        automation_id: automationId,
        run_id: runId,
      } as never,
      {} as never,
      ownerCtx(workspace)
    )) as { feedback: Array<{ id: number; field_path: string }> };
    const legacy = feedback.feedback.find((f) => f.field_path === 'legacy.field');
    const fresh = feedback.feedback.find((f) => f.field_path === 'summary');
    expect(legacy?.id).toBe(424242);
    expect(fresh?.id).toBe(result.feedback_ids[0]);
  });

  it('submit -> get -> summary round-trips entirely through correction events (no table)', async () => {
    const seeded = await seedAutomation(workspace, `summary-${Date.now()}`);
    const sql = getTestDb();

    const submitted = (await manageAutomations(
      {
        action: 'submit_feedback',
        automation_id: seeded.automationId,
        run_id: seeded.runId,
        corrections: [
          { field_path: 'a', mutation: 'set', value: 'v', note: 'n' },
          { field_path: 'b', mutation: 'remove' },
        ],
      } as never,
      {} as never,
      ownerCtx(workspace)
    )) as { feedback_ids: number[] };
    expect(submitted.feedback_ids).toHaveLength(2);

    // The table is retired — the submit went entirely to events. Match the
    // structural name instead of naming the pre-cutover relation in live code.
    const reg = (await sql`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND c.relname LIKE '%window%field%feedback%'
    `) as Array<{ relname: string }>;
    expect(reg).toEqual([]);

    // get_feedback returns both, from events, with recovered ids + org scoping.
    const got = (await manageAutomations(
      { action: 'get_feedback', automation_id: seeded.automationId } as never,
      {} as never,
      ownerCtx(workspace)
    )) as {
      feedback: Array<{ id: number; field_path: string; mutation: string; created_by: string }>;
    };
    expect(got.feedback).toHaveLength(2);
    expect(
      got.feedback.every(
        (f) => Number.isFinite(f.id) && f.created_by === workspace.users.owner.id
      )
    ).toBe(true);
    expect(got.feedback.map((f) => f.field_path).sort()).toEqual(['a', 'b']);

    // The prompt summary renders the latest-per-field corrections from events.
    const summary = await getRecentFeedbackSummary(Number(seeded.automationId));
    expect(summary).toContain('"a" → v');
    expect(summary).toContain('drop "b"');
  });

  it('returns scoped feedback and honors run filters', async () => {
    const otherRunId = await createAutomationResultRun({
      automationId: Number(automationId),
      organizationId: workspace.org.id,
      windowStart: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
      windowEnd: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      extractedData: { problems: [] },
      createdBy: workspace.users.owner.id,
    });

    await manageAutomations(
      {
        action: 'submit_feedback',
        automation_id: automationId,
        run_id: runId,
        corrections: [{ field_path: 'current', value: 1 }],
      } as never,
      {} as never,
      ownerCtx(workspace)
    );
    await manageAutomations(
      {
        action: 'submit_feedback',
        automation_id: automationId,
        run_id: otherRunId,
        corrections: [{ field_path: 'other', value: 2 }],
      } as never,
      {} as never,
      ownerCtx(workspace)
    );

    const filtered = (await manageAutomations(
      {
        action: 'get_feedback',
        automation_id: automationId,
        run_id: otherRunId,
      } as never,
      {} as never,
      ownerCtx(workspace)
    )) as { feedback: Array<{ field_path: string }> };

    expect(filtered.feedback).toHaveLength(1);
    expect(filtered.feedback[0].field_path).toBe('other');
  });

  it('rejects malformed corrections and cross-org automation/run ids', async () => {
    await expect(
      manageAutomations(
        {
          action: 'submit_feedback',
          automation_id: automationId,
          run_id: runId,
          corrections: [],
        } as never,
        {} as never,
        ownerCtx(workspace)
      )
    ).rejects.toThrow(/non-empty array/);

    await expect(
      manageAutomations(
        {
          action: 'submit_feedback',
          automation_id: automationId,
          run_id: runId,
          corrections: [{ field_path: 'problems[0]', mutation: 'patch', value: 'x' }],
        } as never,
        {} as never,
        ownerCtx(workspace)
      )
      // Boundary validation rejects the bad enum before the handler's own
      // "unsupported mutation" check — both name the offending field.
    ).rejects.toThrow(/mutation/);

    const other = await TestWorkspace.create({ name: 'Feedback Stranger Org' });
    const foreign = await seedAutomation(other, 'foreign');
    await expect(
      manageAutomations(
        {
          action: 'submit_feedback',
          automation_id: foreign.automationId,
          run_id: foreign.runId,
          corrections: [{ field_path: 'problems[0]', value: 'x' }],
        } as never,
        {} as never,
        ownerCtx(workspace)
      )
    ).rejects.toThrow(/not found|access/i);
  });

  it('updates the owning run while retaining append-only correction events', async () => {
    const seeded = await seedAutomation(workspace, `apply-${Date.now()}`);
    await manageAutomations(
      {
        action: 'submit_feedback',
        automation_id: seeded.automationId,
        run_id: seeded.runId,
        corrections: [{ field_path: 'problems[0].severity', value: 'high' }],
      } as never,
      {} as never,
      ownerCtx(workspace)
    );

    const [run] = await getTestDb()`
      SELECT action_output FROM runs WHERE id = ${seeded.runId}
    `;
    expect(run.action_output).toEqual({ problems: [{ name: 'A', severity: 'high' }] });
    const corrections = await getTestDb()`
      SELECT 1 FROM events
      WHERE semantic_type = 'correction'
        AND run_id = ${seeded.runId}
    `;
    expect(corrections).toHaveLength(1);
  });

  it('keeps prototype-polluting field paths inert', async () => {
    const seeded = await seedAutomation(workspace, `pollute-${Date.now()}`);
    await manageAutomations(
      {
        action: 'submit_feedback',
        automation_id: seeded.automationId,
        run_id: seeded.runId,
        corrections: [
          { field_path: '__proto__.polluted', value: 'evil' },
          { field_path: 'constructor.prototype.polluted2', value: 'evil' },
        ],
      } as never,
      {} as never,
      ownerCtx(workspace)
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
    const [run] = await getTestDb()`
      SELECT action_output FROM runs WHERE id = ${seeded.runId}
    `;
    const payload = run.action_output as Record<string, unknown>;
    expect(payload.problems).toEqual([{ name: 'A', severity: 'low' }]);
  });

  it('rejects a run that does not own a completed result', async () => {
    const seeded = await seedAutomation(workspace, `nochain-${Date.now()}`);
    await expect(
      manageAutomations(
        {
          action: 'submit_feedback',
          automation_id: seeded.automationId,
          run_id: 999_999_999,
          corrections: [{ field_path: 'problems[0].severity', value: 'high' }],
        } as never,
        {} as never,
        ownerCtx(workspace)
      )
    ).rejects.toThrow(/not found/i);
  });
});
