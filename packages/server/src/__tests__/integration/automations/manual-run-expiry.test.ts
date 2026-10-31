import { readAutomationRevision } from './revision-fixture';
import type { AutomationTriggerResult } from '@lobu/core/contracts/tools/manage-automations';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  materializeDueAutomationRuns,
  sweepStaleAutomationRuns,
} from '../../../automations/automation';
import type { Env } from '../../../index';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

async function createAgentlessAutomation(opts: { slug: string }) {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({
    name: `Manual Run Expiry ${opts.slug}`,
  });
  const entity = await createTestEntity({
    name: `Manual Run Entity ${opts.slug}`,
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  const created = (await workspace.owner.automations.create({
    entity_id: entity.id,
    slug: opts.slug,
    name: `Manual Run Automation ${opts.slug}`,
    prompt: 'Summarize the bounded window.',
    managed_agent_id: null,
  })) as { automation_id: string };

  return {
    sql,
    workspace,
    automationId: Number(created.automation_id),
  };
}

async function triggerManual(
  workspace: Awaited<ReturnType<typeof TestWorkspace.create>>,
  automationId: number
) {
  return (await workspace.owner.automations.trigger({
    automation_id: automationId,
  })) as AutomationTriggerResult;
}

describe('abandoned manual Automation run expiry', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('terminalizes one stale agentless manual run across concurrent sweepers and frees a fresh manual trigger', async () => {
    const { sql, workspace, automationId } = await createAgentlessAutomation({
      slug: 'manual-expiry-retrigger',
    });
    const abandoned = await triggerManual(workspace, automationId);
    expect(abandoned.status).toBe('pending');
    if (abandoned.execution.lane !== 'external_client') {
      throw new Error(`Expected external_client, got ${abandoned.execution.lane}`);
    }

    await sql`
      UPDATE runs
      SET created_at = NOW() - INTERVAL '3 hours'
      WHERE id = ${abandoned.run_id}
    `;

    const [sweepA, sweepB] = await Promise.all([
      sweepStaleAutomationRuns(sql),
      sweepStaleAutomationRuns(sql),
    ]);
    expect(sweepA.timedOut + sweepB.timedOut).toBe(1);

    const [expired] = await sql<{
      status: string;
      outcome: string | null;
      claimed_by: string | null;
      completed_at: string | null;
      error_message: string | null;
    }>`
      SELECT status, outcome, claimed_by, completed_at, error_message
      FROM runs
      WHERE id = ${abandoned.run_id}
    `;
    expect(expired).toMatchObject({
      status: 'timeout',
      outcome: 'infra_error',
      claimed_by: null,
    });
    expect(expired.completed_at).not.toBeNull();
    expect(expired.error_message).toMatch(/pending.*2 hours.*without being claimed/i);

    const replacement = await triggerManual(workspace, automationId);
    expect(replacement.run_id).not.toBe(abandoned.run_id);
    expect(replacement.status).toBe('pending');

    expect((await sweepStaleAutomationRuns(sql)).timedOut).toBe(0);
    const [fresh] = await sql<{ status: string; claimed_by: string | null }>`
      SELECT status, claimed_by FROM runs WHERE id = ${replacement.run_id}
    `;
    expect(fresh).toEqual({ status: 'pending', claimed_by: null });
  });

  it('preserves the schedule cursor and frees a due scheduled activation after manual timeout', async () => {
    const { sql, workspace, automationId } = await createAgentlessAutomation({
      slug: 'manual-expiry-schedule',
    });
    const abandoned = await triggerManual(workspace, automationId);
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId: workspace.users.owner.id,
      agentId: 'manual-expiry-schedule-agent',
      name: 'Manual Expiry Schedule Agent',
    });
    await workspace.owner.automations.update({
      expected_revision: await readAutomationRevision(workspace.owner, automationId),
      automation_id: automationId,
      managed_agent_id: agent.agentId,
      triggers: [
        {
          kind: 'schedule',
          cron: '0 * * * *',
          execution: 'window',
          active_run: 'coalesce',
          skip_if_unchanged: false,
        },
      ],
    });
    const dueAt = new Date(Date.now() - 10 * 60 * 1000);
    await sql`
      UPDATE automations
      SET next_run_at = ${dueAt}::timestamptz
      WHERE id = ${automationId}
    `;
    await sql`
      UPDATE runs
      SET created_at = NOW() - INTERVAL '3 hours'
      WHERE id = ${abandoned.run_id}
    `;

    expect((await sweepStaleAutomationRuns(sql)).timedOut).toBe(1);
    const [afterTimeout] = await sql<{ next_run_at: string }>`
      SELECT next_run_at FROM automations WHERE id = ${automationId}
    `;
    expect(new Date(afterTimeout.next_run_at).getTime()).toBe(dueAt.getTime());

    const materialized = await materializeDueAutomationRuns({} as Env);
    expect(materialized.runsCreated).toBe(1);
    const [scheduled] = await sql<{
      id: number;
      status: string;
      dispatch_source: string | null;
    }>`
      SELECT id, status, approved_input->>'dispatch_source' AS dispatch_source
      FROM runs
      WHERE automation_id = ${automationId}
        AND id <> ${abandoned.run_id}
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(scheduled).toMatchObject({
      status: 'pending',
      dispatch_source: 'scheduled',
    });
  });

  it('does not apply pending-run age to freshly claimed or running external work', async () => {
    const claimedSetup = await createAgentlessAutomation({
      slug: 'manual-expiry-claimed',
    });
    const claimed = await triggerManual(
      claimedSetup.workspace,
      claimedSetup.automationId
    );
    const runningSetup = await createAgentlessAutomation({
      slug: 'manual-expiry-running',
    });
    const running = await triggerManual(
      runningSetup.workspace,
      runningSetup.automationId
    );

    await claimedSetup.sql`
      UPDATE runs
      SET status = 'claimed',
          claimed_by = 'mcp:manual-expiry-client',
          claimed_at = NOW() - INTERVAL '30 minutes',
          last_heartbeat_at = NOW() - INTERVAL '30 minutes',
          created_at = NOW() - INTERVAL '3 hours'
      WHERE id = ${claimed.run_id}
    `;
    await claimedSetup.sql`
      UPDATE runs
      SET status = 'running',
          claimed_by = 'mcp:manual-expiry-client',
          claimed_at = NOW() - INTERVAL '30 minutes',
          last_heartbeat_at = NOW() - INTERVAL '30 seconds',
          created_at = NOW() - INTERVAL '3 hours'
      WHERE id = ${running.run_id}
    `;

    expect((await sweepStaleAutomationRuns(claimedSetup.sql)).timedOut).toBe(0);
    const rows = await claimedSetup.sql<{ id: number; status: string }>`
      SELECT id, status FROM runs
      WHERE id IN (${claimed.run_id}, ${running.run_id})
      ORDER BY id
    `;
    expect(rows.map((row) => row.status).sort()).toEqual(['claimed', 'running']);
  });
});
