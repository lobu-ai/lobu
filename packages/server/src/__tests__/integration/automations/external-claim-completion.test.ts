import type { AutomationClaimNextWindowResult } from '@lobu/core/contracts/tools/manage-automations';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEntity, createTestEvent, seedOwnerContext } from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { handleClaimNextWindow } from '../../../tools/admin/manage_automations/claim-next-window';
import { handleCompleteWindow } from '../../../tools/admin/manage_automations/complete-window';
import { sweepStaleAutomationRuns } from '../../../automations/automation';

const ENV = { JWT_SECRET: 'test-jwt-secret-for-testing-only' } as Env;

/**
 * `claim_next_window` writes the run's claim owner and `complete_window`
 * re-derives it to fence the completion, so the two encodings only ever meet on
 * an Automation with NO managed agent and NO device worker that is claimed and
 * then completed by the same external caller. The other claim-then-complete
 * suites seed `managed_agent_id`, which skips the fence; the agentless suites
 * open their runs with `trigger`, where `complete_window` mints the claim
 * itself and therefore agrees with whatever it wrote. Only this shape compares
 * them.
 */
describe('external MCP claim then completion', () => {
  let sql: DbClient;
  let orgId: string;
  let userId: string;
  let entityId: number;
  let automationId: number;
  let api: TestApiClient;
  let ownerCtx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    const seeded = await seedOwnerContext();
    ownerCtx = seeded.ctx as ToolContext;
    sql = getTestDb() as unknown as DbClient;
    orgId = seeded.org.id;
    userId = seeded.user.id;
    const entity = await createTestEntity({
      name: 'External claim subject',
      organization_id: orgId,
      created_by: userId,
    });
    entityId = entity.id;
    api = await TestApiClient.for({ organizationId: orgId, userId, memberRole: 'owner' });
    const created = (await api.automations.create({
      entity_id: entityId,
      slug: 'external-claim',
      name: 'External claim',
      prompt: 'Extract durable signals from each arrival window.',
      sources: [
        {
          name: 'content',
          query:
            "SELECT id, occurred_at, payload_text FROM events WHERE semantic_type = 'content' ORDER BY occurred_at DESC, id DESC",
        },
      ],
      outputs: { signals: { event: 'observation' } },
      // Manual-only (no triggers), so no executor is required and both
      // `managed_agent_id` and `device_worker_id` stay null — the shape an
      // external MCP client claims and completes itself.
    })) as { automation_id: string };
    automationId = Number(created.automation_id);
  });

  it('completes a window the same caller claimed', async () => {
    await createTestEvent({
      entity_id: entityId,
      organization_id: orgId,
      content: 'Arrival inside the claimed window',
    });

    const claimed = (await api.automations.claimNextWindow({
      automation_id: String(automationId),
    })) as AutomationClaimNextWindowResult;

    const [run] = await sql<{ claimed_by: string | null }>`
      SELECT claimed_by FROM runs WHERE id = ${claimed.run_id}
    `;
    // claim_next_window records the caller as `external:{...}`.
    expect(String(run.claimed_by)).toMatch(/^external:/);

    const completed = (await api.automations.completeWindow({
      automation_id: String(automationId),
      run_id: claimed.run_id,
      window_token: claimed.context.window_token,
      extracted_data: { signals: [] },
    })) as { run_id: number; completed_now: boolean };

    expect(completed).toMatchObject({ run_id: claimed.run_id, completed_now: true });

    const [after] = await sql<{
      next_window_start: string | Date;
      last_completed_window_start: string | Date | null;
    }>`
      SELECT next_window_start, last_completed_window_start
      FROM automations WHERE id = ${automationId}
    `;
    expect(new Date(after.next_window_start).toISOString()).toBe(claimed.context.window_end);
    expect(new Date(after.last_completed_window_start as string).toISOString()).toBe(
      claimed.context.window_start
    );

    // The completion must leave the claim owner byte-identical to the one the
    // claim wrote — a re-encoding that merely happened to pass the fence would
    // still strand the next caller.
    const [finished] = await sql<{ status: string; claimed_by: string | null }>`
      SELECT status, claimed_by FROM runs WHERE id = ${claimed.run_id}
    `;
    expect(finished).toMatchObject({ status: 'completed', claimed_by: run.claimed_by });
  });

  it('completes a claim opened under a DIFFERENT MCP session', async () => {
    // ChatGPT opens a new MCP session per tool call, so the session that claims
    // a window is never the session that completes it. An owner encoding that
    // included `mcp_session_id` made the pairing structurally impossible.
    const claimSession: ToolContext = { ...ownerCtx, mcpSessionId: 'session-claim' };
    const completeSession: ToolContext = { ...ownerCtx, mcpSessionId: 'session-complete' };

    const claimed = await handleClaimNextWindow(
      { action: 'claim_next_window', automation_id: String(automationId) } as never,
      ENV,
      claimSession
    );

    const completed = (await handleCompleteWindow(
      {
        action: 'complete_window',
        automation_id: String(automationId),
        run_id: claimed.run_id,
        window_token: claimed.context.window_token,
        extracted_data: { signals: [] },
      } as never,
      ENV,
      completeSession
    )) as { run_id: number; completed_now: boolean };

    expect(completed).toMatchObject({ run_id: claimed.run_id, completed_now: true });

    const [after] = await sql<{ next_window_start: string | Date }>`
      SELECT next_window_start FROM automations WHERE id = ${automationId}
    `;
    expect(new Date(after.next_window_start).toISOString()).toBe(claimed.context.window_end);
  });

  it('completes an empty window so the arrival mark still advances', async () => {
    const claimed = (await api.automations.claimNextWindow({
      automation_id: String(automationId),
    })) as AutomationClaimNextWindowResult;

    const completed = (await api.automations.completeWindow({
      automation_id: String(automationId),
      run_id: claimed.run_id,
      window_token: claimed.context.window_token,
      extracted_data: { signals: [] },
    })) as { completed_now: boolean };

    expect(completed.completed_now).toBe(true);

    const [after] = await sql<{ next_window_start: string | Date }>`
      SELECT next_window_start FROM automations WHERE id = ${automationId}
    `;
    expect(new Date(after.next_window_start).toISOString()).toBe(claimed.context.window_end);
  });

  it('keeps a paginated external claim completable until its explicit lease expires', async () => {
    for (const content of ['First arrival', 'Second arrival']) {
      await createTestEvent({ entity_id: entityId, organization_id: orgId, content });
    }
    const first = await api.automations.claimNextWindow({
      automation_id: String(automationId), limit: 1, lease_seconds: 1800,
    });
    expect(first.context.page.has_more).toBe(true);
    const cursor = first.context.page.next_cursor!;
    const second = await api.automations.claimNextWindow({
      automation_id: String(automationId), run_id: first.run_id,
      before_occurred_at: cursor.occurred_at, before_id: cursor.id,
      limit: 1, lease_seconds: 1800,
    });
    expect(second.context.page.has_more).toBe(false);
    // The continuation advances the heartbeat past the claim. A processor can
    // then legitimately spend more than three minutes investigating this window.
    await sql`
      UPDATE runs SET claimed_at = NOW() - INTERVAL '10 minutes',
        last_heartbeat_at = NOW() - INTERVAL '4 minutes'
      WHERE id = ${first.run_id}
    `;
    expect((await sweepStaleAutomationRuns(sql)).timedOut).toBe(0);
    const completed = await api.automations.completeWindow({
      automation_id: String(automationId), run_id: first.run_id,
      window_tokens: [first.context.window_token, second.context.window_token],
      extracted_data: { signals: [] },
    });
    expect(completed.completed_now).toBe(true);
    const [after] = await sql`SELECT next_window_start FROM automations WHERE id = ${automationId}`;
    expect(new Date(after.next_window_start).toISOString()).toBe(first.context.window_end);
  });

  it('keeps a live external lease beyond the coarse claim-age backstop', async () => {
    const claimed = await api.automations.claimNextWindow({
      automation_id: String(automationId), lease_seconds: 1800,
    });
    await sql`
      UPDATE runs SET claimed_at = NOW() - INTERVAL '3 hours',
        last_heartbeat_at = NOW() - INTERVAL '3 hours'
      WHERE id = ${claimed.run_id}
    `;
    expect((await sweepStaleAutomationRuns(sql)).timedOut).toBe(0);
    const completed = await api.automations.completeWindow({
      automation_id: String(automationId), run_id: claimed.run_id,
      window_token: claimed.context.window_token, extracted_data: { signals: [] },
    });
    expect(completed.completed_now).toBe(true);
  });

  it.each([false, true])('expires a lease exactly once, preserving the mark and fencing old completion (continued=%s)', async (continued) => {
    const claimed = await api.automations.claimNextWindow({
      automation_id: String(automationId), lease_seconds: 1800,
    });
    if (continued) {
      await api.automations.claimNextWindow({
        automation_id: String(automationId), run_id: claimed.run_id,
        lease_seconds: 1800,
      });
    }
    await sql`UPDATE runs SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ${claimed.run_id}`;
    const swept = await Promise.all([sweepStaleAutomationRuns(sql), sweepStaleAutomationRuns(sql)]);
    expect(swept[0].timedOut + swept[1].timedOut).toBe(1);
    const [expired] = await sql`SELECT status, error_message FROM runs WHERE id = ${claimed.run_id}`;
    expect(expired).toMatchObject({ status: 'timeout', error_message: 'External Automation window lease expired' });
    const [mark] = await sql`SELECT next_window_start FROM automations WHERE id = ${automationId}`;
    expect(new Date(mark.next_window_start).toISOString()).toBe(claimed.context.window_start);

    const retry = await api.automations.claimNextWindow({ automation_id: String(automationId) });
    expect(retry.run_id).not.toBe(claimed.run_id);
    expect(retry.context.window_start).toBe(claimed.context.window_start);
    await expect(api.automations.completeWindow({
      automation_id: String(automationId), run_id: claimed.run_id,
      window_token: claimed.context.window_token, extracted_data: { signals: [] },
    })).rejects.toThrow(/already claimed by another executor/);
    const completed = await api.automations.completeWindow({
      automation_id: String(automationId), run_id: retry.run_id,
      window_token: retry.context.window_token, extracted_data: { signals: [] },
    });
    expect(completed.completed_now).toBe(true);
  });
});
