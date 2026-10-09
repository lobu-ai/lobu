/** Eval replays record proposed output on the eval run without mutating live runs. */

import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { handleCompleteWindow } from '../../../tools/admin/manage_automations/complete-window';
import { captureSideEffect } from '../../../gateway/routes/internal/capture-mode';
import { createLegacyCapturedRun } from '../../setup/legacy-captured-run';
import { createAutomationRun } from '../../../runs/queue-service';
import { computePendingWindow } from '../../../utils/window-utils';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

const TEST_ENV: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
};

const LIVE_EXTRACTION = { summary: 'the real completion' };
const EVAL_EXTRACTION = { summary: 'the replay output' };

function toolCtx(
  organizationId: string,
  userId: string,
  executionMode: 'live' | 'capture'
): ToolContext {
  return {
    organizationId,
    userId,
    memberRole: 'owner',
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
    executionMode,
  };
}

async function setup() {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({ name: 'Eval Capture Org' });
  const ownerUserId = workspace.users.owner.id;
  const parentEntity = await createTestEntity({
    name: 'Parent Brand',
    organization_id: workspace.org.id,
    created_by: ownerUserId,
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: 'eval-capture-agent',
    name: 'Eval Capture Agent',
  });
  const api = await TestApiClient.for({
    organizationId: workspace.org.id,
    userId: ownerUserId,
    memberRole: 'owner',
  });
  const created = (await workspace.owner.automations.create({
    entity_id: parentEntity.id,
    slug: 'eval-capture-automation',
    name: 'Eval Capture Automation',
    prompt: 'Summarize activity for {{entities}}.',
    triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
    managed_agent_id: agent.agentId,
  })) as { automation_id: string };
  const automationId = Number(created.automation_id);
  await sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '10 minutes' WHERE id = ${automationId}`;
  await createTestEvent({
    entity_id: parentEntity.id,
    organization_id: workspace.org.id,
    content: 'Something happened worth summarizing.',
    occurred_at: new Date(Date.now() - 60 * 60 * 1000),
  });
  const { windowStart, windowEnd } = await computePendingWindow(sql as unknown as DbClient, automationId);
  const sourceRun = await createAutomationRun({
    organizationId: workspace.org.id,
    automationId,
    agentId: agent.agentId,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    dispatchSource: 'scheduled',
  });
  await sql`
    UPDATE runs SET status = 'running', claimed_at = NOW(), claimed_by = ${`lobu:${agent.agentId}`}
    WHERE id = ${sourceRun.runId}
  `;
  // Bind every read to the run that will complete it, the way a real Automation
  // run does. An unbound read recomputes the arrival window against the clock,
  // so its bounds land milliseconds after the ones the run was queued with and
  // the completion is rejected for a period the run does not own.
  const liveKnowledge = (await api.knowledge.read({
    automation_id: automationId,
    run_id: sourceRun.runId,
  })) as {
    window_token: string;
  };
  const liveContext = toolCtx(workspace.org.id, ownerUserId, 'live');
  await handleCompleteWindow(
    {
      action: 'complete_window',
      automation_id: String(automationId),
      window_token: liveKnowledge.window_token,
      extracted_data: LIVE_EXTRACTION,
      run_id: sourceRun.runId,
    } as never,
    TEST_ENV,
    liveContext
  );
  const evalRun = await createLegacyCapturedRun(
    sourceRun.runId,
    sql as unknown as DbClient
  );
  if (!evalRun) throw new Error('eval run was not created');
  const evalKnowledge = (await api.knowledge.read({
    automation_id: automationId,
    run_id: evalRun.runId,
  })) as {
    window_token: string;
  };

  return {
    sql,
    orgId: workspace.org.id,
    ownerUserId,
    automationId,
    sourceRunId: sourceRun.runId,
    evalRunId: evalRun.runId,
    windowToken: evalKnowledge.window_token,
    liveContext,
    captureContext: toolCtx(workspace.org.id, ownerUserId, 'capture'),
  };
}

describe('eval complete_window capture', () => {
  beforeEach(cleanupTestDatabase);

  it('records replay output on the eval run and leaves the live result unchanged', async () => {
    const ctx = await setup();
    const captured = await handleCompleteWindow(
      {
        action: 'complete_window',
        automation_id: String(ctx.automationId),
        window_token: ctx.windowToken,
        extracted_data: EVAL_EXTRACTION,
        run_id: ctx.evalRunId,
      } as never,
      TEST_ENV,
      ctx.captureContext
    );

    expect(captured).toMatchObject({
      run_id: ctx.evalRunId,
      captured: true,
      reaction_status: 'skipped',
    });
    const [live] = await ctx.sql<{ action_output: Record<string, unknown> }[]>`
      SELECT action_output FROM runs WHERE id = ${ctx.sourceRunId}
    `;
    expect(live.action_output).toEqual(LIVE_EXTRACTION);
    const [evalResult] = await ctx.sql<
      {
        dry_run: boolean;
        dry_run_preview: { captured: string; extracted_data: unknown };
        claimed_by: string | null;
      }[]
    >`
      SELECT dry_run, dry_run_preview, claimed_by FROM runs WHERE id = ${ctx.evalRunId}
    `;
    expect(evalResult.dry_run).toBe(true);
    expect(evalResult.claimed_by).toBeNull();
    expect(evalResult.dry_run_preview).toMatchObject({
      captured: 'complete_window',
      extracted_data: EVAL_EXTRACTION,
    });
  });

  it('keeps live and eval run IDs in separate lanes', async () => {
    const ctx = await setup();
    const input = {
      action: 'complete_window',
      automation_id: String(ctx.automationId),
      window_token: ctx.windowToken,
      extracted_data: EVAL_EXTRACTION,
    };
    await expect(
      handleCompleteWindow(
        { ...input, run_id: ctx.evalRunId } as never,
        TEST_ENV,
        ctx.liveContext
      )
    ).rejects.toMatchObject({ httpStatus: 409 });
    await expect(
      handleCompleteWindow(
        { ...input, run_id: ctx.sourceRunId } as never,
        TEST_ENV,
        ctx.captureContext
      )
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('preserves side effects already captured on the eval run', async () => {
    const ctx = await setup();
    await captureSideEffect(
      {
        get: (key: string) =>
          key === 'worker'
            ? {
                executionMode: 'capture',
                automationRunId: ctx.evalRunId,
                organizationId: ctx.orgId,
              }
            : undefined,
        json: (body: unknown) => new Response(JSON.stringify(body)),
      } as never,
      'conversations.send',
      { text: 'would have posted this' }
    );
    await handleCompleteWindow(
      {
        action: 'complete_window',
        automation_id: String(ctx.automationId),
        window_token: ctx.windowToken,
        extracted_data: EVAL_EXTRACTION,
        run_id: ctx.evalRunId,
      } as never,
      TEST_ENV,
      ctx.captureContext
    );
    const [row] = await ctx.sql<
      { captured: string | null; side_effects: Array<{ action: string }> | null }[]
    >`
      SELECT dry_run_preview->>'captured' AS captured,
             dry_run_preview->'side_effects' AS side_effects
      FROM runs WHERE id = ${ctx.evalRunId}
    `;
    expect(row.captured).toBe('complete_window');
    expect(row.side_effects?.map((effect) => effect.action)).toEqual(['conversations.send']);
  });
});
