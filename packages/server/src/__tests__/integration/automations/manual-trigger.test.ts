/**
 * Integration test for the manual-trigger endpoint:
 *   POST /api/workers/me/automations/:automation_id/trigger
 *
 * Verifies:
 *   - Correctly-bound device → 200, pending run row created with manual
 *     dispatch_source.
 *   - Wrong device → 403, no run row created.
 *   - Re-trigger while a run is active → 200 `already_queued: true`, no
 *     second run row created.
 *   - Trigger does NOT advance `automations.next_run_at`.
 */

import { readAutomationRevision } from './revision-fixture';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import type { Env } from '../../../index';
import { generateSecureToken, hashToken } from '../../../auth/oauth/utils';
import { createAutomationEventRun } from '../../../runs/queue-service';
import { manageAutomations } from '../../../tools/admin/manage_automations';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';
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

/**
 * Mint a PAT bound to a specific device worker_id with `device_worker:run`
 * scope — same shape as createWorkerBoundPat in the sibling automation
 * contract test.
 */
async function createWorkerBoundPat(
  userId: string,
  organizationId: string,
  workerId: string,
  scope = 'device_worker:run'
): Promise<{ token: string }> {
  const sql = getTestDb();
  const token = `owl_pat_${generateSecureToken(24)}`;
  const tokenHash = hashToken(token);
  const tokenPrefix = token.substring(0, 12);
  await sql`
    INSERT INTO personal_access_tokens (
      token_hash, token_prefix, user_id, organization_id, name, scope, worker_id,
      created_at, updated_at
    ) VALUES (
      ${tokenHash}, ${tokenPrefix}, ${userId}, ${organizationId},
      ${`Test worker PAT (${workerId})`}, ${scope}, ${workerId},
      NOW(), NOW()
    )
  `;
  return { token };
}

/**
 * Set up a device-pinned automation owned by the workspace owner. Returns
 * everything the tests need to mint the right PAT + assert on the run row.
 */
async function setupDevicePinnedAutomation(opts: { workerId: string }): Promise<{
  sql: ReturnType<typeof getTestDb>;
  dbClient: DbClient;
  workspace: Awaited<ReturnType<typeof TestWorkspace.create>>;
  automationId: number;
  deviceWorkerId: string;
  agentId: string;
}> {
  const sql = getTestDb();
  const dbClient = sql as unknown as DbClient;
  const workspace = await TestWorkspace.create({ name: 'Manual Trigger Org' });
  const ownerUserId = workspace.users.owner.id;

  // Pre-register a device worker so the trigger can resolve the bound id.
  const inserted = (await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
    VALUES (${ownerUserId}, ${opts.workerId}, 'macos', ${sql.json({})}, 'Mac Test', ${workspace.org.id})
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  const deviceWorkerId = String(inserted[0].id);

  const entity = await createTestEntity({
    name: 'Trigger Entity',
    organization_id: workspace.org.id,
    created_by: ownerUserId,
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: 'trigger-agent',
    name: 'Trigger Agent',
  });
  const automation = (await workspace.owner.automations.create({
    entity_id: entity.id,
    slug: 'trigger-automation',
    name: 'Trigger Automation',
    prompt: 'Summarize {{entities}}.',
    triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
    managed_agent_id: agent.agentId,
  })) as { automation_id: string };
  const automationId = Number(automation.automation_id);

  // Pin the automation to the device directly rather than through
  // automations.create — matches how automation-contract.test.ts pins
  // automations for the #802 dispatcher tests.
  await sql`
    UPDATE automations
    SET device_worker_id = ${deviceWorkerId}::uuid,
        agent_kind = 'claude-code'
    WHERE id = ${automationId}
  `;

  return {
    sql,
    dbClient,
    workspace,
    automationId,
    deviceWorkerId,
    agentId: agent.agentId,
  };
}

describe('POST /api/workers/me/automations/:automation_id/trigger', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('correctly-bound device → 200 + manual run row', async () => {
    const ctx = await setupDevicePinnedAutomation({ workerId: 'mac-trigger-ok' });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-trigger-ok'
    );

    const response = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      run_id: number;
      status: string;
      already_queued: boolean;
    };
    expect(json.run_id).toBeGreaterThan(0);
    expect(json.status).toBe('pending');
    expect(json.already_queued).toBe(false);

    const runs = await ctx.sql`
      SELECT id, status, automation_id, run_type, approved_input
      FROM runs
      WHERE automation_id = ${ctx.automationId}
    `;
    expect(runs).toHaveLength(1);
    expect(String(runs[0].run_type)).toBe('automation');
    expect(String(runs[0].status)).toBe('pending');
    const approved = runs[0].approved_input as Record<string, unknown>;
    expect(approved.dispatch_source).toBe('manual');
    expect(approved.device_worker_id).toBe(ctx.deviceWorkerId);
    expect(approved.agent_kind).toBe('claude-code');
  });

  it('wrong device → 403, no run created', async () => {
    const ctx = await setupDevicePinnedAutomation({ workerId: 'mac-pinned' });
    const ownerUserId = ctx.workspace.users.owner.id;

    // Same user registers a second, unrelated device. Their token is bound
    // to that second worker_id and must NOT be able to trigger automation A.
    await ctx.sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
      VALUES (${ownerUserId}, 'mac-other', 'macos', ${ctx.sql.json({})}, 'Other Mac', ${ctx.workspace.org.id})
    `;
    const { token } = await createWorkerBoundPat(ownerUserId, ctx.workspace.org.id, 'mac-other');

    const response = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/not pinned to this device/i);

    const runs = await ctx.sql`
      SELECT id FROM runs WHERE automation_id = ${ctx.automationId}
    `;
    expect(runs).toHaveLength(0);
  });

  it('re-trigger while a run is pending → 200 already_queued, no duplicate run', async () => {
    const ctx = await setupDevicePinnedAutomation({
      workerId: 'mac-trigger-idem',
    });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-trigger-idem'
    );

    const first = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as {
      run_id: number;
      already_queued: boolean;
    };
    expect(firstJson.already_queued).toBe(false);

    const second = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      run_id: number;
      status: string;
      already_queued: boolean;
    };
    expect(secondJson.already_queued).toBe(true);
    expect(secondJson.run_id).toBe(firstJson.run_id);

    const runs = await ctx.sql`
      SELECT id FROM runs WHERE automation_id = ${ctx.automationId}
    `;
    expect(runs).toHaveLength(1);
  });

  it('also returns already_queued for claimed/running existing runs', async () => {
    const ctx = await setupDevicePinnedAutomation({
      workerId: 'mac-trigger-claimed',
    });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-trigger-claimed'
    );

    const first = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { run_id: number };

    // Advance the run from pending → running (post-claim state). The trigger
    // helper should still see it as active and refuse to start a second run.
    await ctx.sql`
      UPDATE runs SET status = 'running', claimed_at = NOW(), claimed_by = 'mac-trigger-claimed'
      WHERE id = ${firstJson.run_id}
    `;

    const second = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      run_id: number;
      already_queued: boolean;
    };
    expect(secondJson.already_queued).toBe(true);
    expect(secondJson.run_id).toBe(firstJson.run_id);

    const runs = await ctx.sql`
      SELECT id, status FROM runs WHERE automation_id = ${ctx.automationId}
    `;
    expect(runs).toHaveLength(1);
    expect(String(runs[0].status)).toBe('running');
  });

  it('does NOT advance automations.next_run_at', async () => {
    const ctx = await setupDevicePinnedAutomation({ workerId: 'mac-trigger-nra' });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-trigger-nra'
    );

    const [before] = await ctx.sql`
      SELECT next_run_at FROM automations WHERE id = ${ctx.automationId}
    `;
    const beforeNextRun = before.next_run_at as Date | string | null;

    const response = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(response.status).toBe(200);

    const [after] = await ctx.sql`
      SELECT next_run_at FROM automations WHERE id = ${ctx.automationId}
    `;
    const afterNextRun = after.next_run_at as Date | string | null;
    // Either both null (no schedule) or identical timestamps. Manual trigger
    // must NOT shift the cron schedule forward.
    if (beforeNextRun === null) {
      expect(afterNextRun).toBeNull();
    } else {
      const beforeMs = new Date(beforeNextRun).getTime();
      const afterMs = afterNextRun ? new Date(afterNextRun).getTime() : 0;
      expect(afterMs).toBe(beforeMs);
    }
  });

  it('returns 404 for an unknown automation id', async () => {
    const ctx = await setupDevicePinnedAutomation({ workerId: 'mac-404' });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-404'
    );

    const response = await post('/api/workers/me/automations/999999999/trigger', {
      token,
    });
    expect(response.status).toBe(404);
  });

  it('poll payload carries the automation execution_config', async () => {
    const ctx = await setupDevicePinnedAutomation({ workerId: 'mac-poll-exec' });
    const execCfg = {
      timeout_seconds: 1800,
      model: 'opus',
      permission_mode: 'plan',
    };
    await ctx.sql`
      UPDATE automations SET execution_config = ${ctx.sql.json(execCfg)} WHERE id = ${ctx.automationId}
    `;
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-poll-exec'
    );

    // Trigger queues a pending run pinned to this device.
    const trig = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(trig.status).toBe(200);

    // The device poll claims it and gets the payload envelope the dispatcher
    // builds its CLI invocation from — execution_config must round-trip.
    const pollRes = await post('/api/workers/poll', {
      token,
      body: { worker_id: 'mac-poll-exec', capabilities: {} },
    });
    expect(pollRes.status).toBe(200);
    const job = (await pollRes.json()) as {
      run_type?: string;
      payload?: { automation?: { execution_config?: Record<string, unknown> } };
    };
    expect(job.run_type).toBe('automation');
    expect(job.payload?.automation?.execution_config).toEqual(execCfg);
  });

  it('leaves a second queued run pending while the same Automation is running', async () => {
    const ctx = await setupDevicePinnedAutomation({ workerId: 'mac-poll-serial' });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-poll-serial'
    );

    const trig = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(trig.status).toBe(200);

    const firstPoll = await post('/api/workers/poll', {
      token,
      body: { worker_id: 'mac-poll-serial', capabilities: {} },
    });
    expect(firstPoll.status).toBe(200);
    const firstJob = (await firstPoll.json()) as { run_id?: number };
    expect(firstJob.run_id).toBeDefined();

    const queued = await createAutomationEventRun({
      organizationId: ctx.workspace.org.id,
      automationId: ctx.automationId,
      agentId: ctx.agentId,
      trigger: {
        kind: 'event',
        connector_key: 'github',
        event_types: ['pull_request.created'],
        active_run: 'queue',
      },
      signal: {
        connector_key: 'github',
        event_type: 'pull_request.created',
        delivery_id: 'event:device-queued',
        label: 'Queued event',
        input_text: 'A second event arrived while the Automation was running.',
      },
      deviceWorkerId: ctx.deviceWorkerId,
      agentKind: 'claude-code',
    });

    const secondPoll = await post('/api/workers/poll', {
      token,
      body: { worker_id: 'mac-poll-serial', capabilities: {} },
    });
    expect(secondPoll.status).toBe(200);
    expect(await secondPoll.json()).toEqual({ next_poll_seconds: 10 });

    const [stillQueued] = await ctx.sql`
      SELECT status FROM runs WHERE id = ${queued.runId}
    `;
    expect(stillQueued.status).toBe('pending');
  });

  it('serializes concurrent claims for two pending runs of one Automation', async () => {
    const ctx = await setupDevicePinnedAutomation({ workerId: 'mac-poll-race' });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-poll-race'
    );

    const triggered = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, {
      token,
    });
    expect(triggered.status).toBe(200);
    const firstRunId = Number(((await triggered.json()) as { run_id: number }).run_id);
    const second = await createAutomationEventRun({
      organizationId: ctx.workspace.org.id,
      automationId: ctx.automationId,
      agentId: ctx.agentId,
      trigger: {
        kind: 'event',
        connector_key: 'github',
        event_types: ['pull_request.created'],
        active_run: 'queue',
      },
      signal: {
        connector_key: 'github',
        event_type: 'pull_request.created',
        delivery_id: 'event:device-race',
        label: 'Concurrent queued event',
        input_text: 'A second event is waiting for the same Automation.',
      },
      deviceWorkerId: ctx.deviceWorkerId,
      agentKind: 'claude-code',
    });

    const responses = await Promise.all([
      post('/api/workers/poll', {
        token,
        body: { worker_id: 'mac-poll-race', capabilities: {} },
      }),
      post('/api/workers/poll', {
        token,
        body: { worker_id: 'mac-poll-race', capabilities: {} },
      }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<Record<string, unknown>>)
    );
    expect(bodies.filter((body) => typeof body.run_id === 'number')).toHaveLength(1);
    expect(bodies.filter((body) => body.next_poll_seconds === 10)).toHaveLength(1);

    const runs = await ctx.sql`
      SELECT id, status
      FROM runs
      WHERE id IN (${firstRunId}, ${second.runId})
      ORDER BY id
    `;
    expect(runs.filter((run) => run.status === 'running')).toHaveLength(1);
    expect(runs.filter((run) => run.status === 'pending')).toHaveLength(1);
  });

  it('poll payload carries the run-pinned prompt and skills, not a later edit', async () => {
    const ctx = await setupDevicePinnedAutomation({ workerId: 'mac-poll-prompt' });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-poll-prompt'
    );

    await ctx.sql`
      UPDATE automation_versions
      SET skills = ${ctx.sql.json([
        { name: 'device-runbook', content: 'Follow the frozen v1 runbook.' },
      ])}
      WHERE id = (
        SELECT current_version_id FROM automations WHERE id = ${ctx.automationId}
      )
    `;

    // Queue a run: createAutomationRun snapshots the current version (prompt +
    // skills v1) into approved_input.version_id.
    const trig = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(trig.status).toBe(200);

    // Edit the automation AFTER the run is queued: a new current version with a
    // different prompt. The already-queued run must NOT pick this up.
    const v2 = (await manageAutomations(
      {
        expected_revision: await readAutomationRevision(ctx.workspace.owner, String(ctx.automationId)),
        action: 'create_version',
        automation_id: String(ctx.automationId),
        prompt: 'EDITED-AFTER-QUEUE prompt v2.',
        change_notes: 'edit after queue',
      } as never,
      {} as Env,
      ownerCtx(ctx.workspace)
    )) as { version: number };
    expect(v2.version).toBe(2);

    // The poll must deliver both instruction sources from the version
    // snapshotted at queue time (v1) — the same version complete_window
    // validates against — not the edit.
    const pollRes = await post('/api/workers/poll', {
      token,
      body: { worker_id: 'mac-poll-prompt', capabilities: {} },
    });
    expect(pollRes.status).toBe(200);
    const job = (await pollRes.json()) as {
      run_type?: string;
      payload?: { automation?: { prompt?: string } };
    };
    expect(job.run_type).toBe('automation');
    expect(job.payload?.automation?.prompt).toContain('Summarize {{entities}}.');
    expect(job.payload?.automation?.prompt).toContain('### device-runbook');
    expect(job.payload?.automation?.prompt).toContain('Follow the frozen v1 runbook.');
    expect(job.payload?.automation?.prompt).not.toContain('EDITED-AFTER-QUEUE');
  });
});
