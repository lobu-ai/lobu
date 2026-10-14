import type { AutomationTriggerResult } from '@lobu/core/contracts/tools/manage-automations';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { createAutomationRun } from '../../../runs/queue-service';
import { encodeExternalAutomationClaimOwner } from '../../../tools/admin/manage_automations/claim-next-window';
import { handleCompleteWindow } from '../../../tools/admin/manage_automations/complete-window';
import { handleAutomationMode } from '../../../tools/get_content/automation-mode';
import type { ToolContext } from '../../../tools/registry';
import { generateWindowToken, verifyWindowToken } from '../../../utils/jwt';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAgent,
  createTestEntity,
  createTestEvent,
} from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    task_key: { type: 'string' },
    action: { type: 'string' },
  },
  required: ['task_key', 'action'],
  additionalProperties: true,
};

const TASK_OUTPUTS = {
  tasks: {
    entity: 'task',
    key: ['task_key'],
    name: ['action'],
  },
};

const EDITED_OUTPUTS = {
  findings: {
    entity: 'task',
    key: ['task_key'],
    name: ['action'],
  },
};

const TEST_ENV: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
};

/**
 * The claim owner both `claim_next_window` and `complete_window` encode for a
 * plain user caller. Built through the production encoder so a change to that
 * encoding fails here instead of silently fencing real claimants out.
 */
const claimOwnerForUser = (userId: string): string =>
  encodeExternalAutomationClaimOwner({ userId } as ToolContext);

describe('external manual Automation execution', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('triggers without the gateway, reads the queued run after a version edit, and persists keyed output', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'External Automation Org' });
    const parent = await createTestEntity({
      name: 'Task Board',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });

    await sql`
      INSERT INTO entity_types (
        organization_id, slug, name, metadata_schema, created_at, updated_at
      ) VALUES (
        ${workspace.org.id}, 'task', 'Task', ${sql.json(TASK_SCHEMA)}, NOW(), NOW()
      )
    `;

    const created = (await workspace.owner.automations.create({
      entity_id: parent.id,
      slug: 'external-task-builder',
      name: 'External Task Builder',
      prompt: 'Extract durable tasks.',
      sources: [
        {
          name: 'signals',
          query: 'SELECT id, payload_text, occurred_at FROM events WHERE false',
        },
      ],
      outputs: TASK_OUTPUTS,
      managed_agent_id: null,
    })) as { automation_id: string };
    const automationId = Number(created.automation_id);

    // Vitest has no embedded Lobu gateway. An agentless manual run must still
    // materialize and remain pending for the external MCP completion path.
    const triggered = (await workspace.owner.automations.trigger({
      automation_id: created.automation_id,
    })) as AutomationTriggerResult;
    expect(triggered.status).toBe('pending');
    if (triggered.execution.lane !== 'external_client') {
      throw new Error(`Expected external_client, got ${triggered.execution.lane}`);
    }
    expect(triggered.execution.next_action.then).toBe('automations.completeWindow');

    const [queued] = await sql<{
      status: string;
      approved_input: Record<string, unknown>;
    }>`
      SELECT status, approved_input
      FROM runs
      WHERE id = ${triggered.run_id}
    `;
    expect(queued.status).toBe('pending');
    const queuedVersionId = Number(queued.approved_input.version_id);
    const queuedWindowStart = String(queued.approved_input.window_start);
    const queuedWindowEnd = String(queued.approved_input.window_end);
    expect(queuedVersionId).toBeGreaterThan(0);
    // The run snapshot carries the arrival BOUNDS and nothing that interprets
    // them: there is no period shape to record any more.
    expect(queued.approved_input.granularity).toBeUndefined();
    expect(Date.parse(queuedWindowEnd)).toBeGreaterThan(Date.parse(queuedWindowStart));

    // A workspace event-window run stores exact durable pointers in its run
    // snapshot. The caller should not have to repeat content_ids when reading
    // that run later.
    const triggerOccurredAt = new Date(
      (Date.parse(queuedWindowStart) + Date.parse(queuedWindowEnd)) / 2
    );
    const triggerEvent = await createTestEvent({
      entity_id: parent.id,
      organization_id: workspace.org.id,
      content: 'A durable workspace signal for the task builder.',
      occurred_at: triggerOccurredAt,
      // The window selects `created_at`, so the row has to have been STORED
      // inside the queued range, not merely dated inside it.
      created_at: triggerOccurredAt,
    });
    const workspaceSignal = {
      kind: 'event',
      source: 'workspace',
      event_id: triggerEvent.id,
      event_type: 'observation',
      delivery_id: `workspace-event:${triggerEvent.id}`,
      occurred_at: triggerOccurredAt.toISOString(),
      root_event_ids: [triggerEvent.id],
      causal_automation_ids: [99],
      depth: 1,
    };
    await sql`
      UPDATE runs
      SET approved_input = approved_input
        || jsonb_build_object('dispatch_source', 'event')
        || jsonb_build_object('trigger_signal', ${sql.json(workspaceSignal)}::jsonb)
        || jsonb_build_object('trigger_signals', ${sql.json([workspaceSignal])}::jsonb)
      WHERE id = ${triggered.run_id}
    `;

    // Change the live Automation to an incompatible output name and daily
    // cadence after the run is queued. The run-bound read must keep the
    // original version, schema, and weekly period semantics.
    await workspace.owner.automations.createVersion({
      automation_id: created.automation_id,
      prompt: 'Extract findings instead.',
      outputs: EDITED_OUTPUTS,
    });
    const liveAgent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId: workspace.users.owner.id,
    });
    await workspace.owner.automations.update({
      automation_id: created.automation_id,
      managed_agent_id: liveAgent.agentId,
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
    });
    const [edited] = await sql<{ current_version_id: number }>`
      SELECT current_version_id
      FROM automations
      WHERE id = ${automationId}
    `;
    expect(Number(edited.current_version_id)).not.toBe(queuedVersionId);

    const read = (await workspace.owner.knowledge.read({
      ...triggered.execution.next_action.read.input,
      limit: 25,
    })) as {
      window_token?: string;
      window_start?: string;
      window_end?: string;
      content: Array<{ id?: number }>;
      extraction_schema?: {
        required?: string[];
        properties?: Record<string, unknown>;
      };
      window_lag?: { granularity?: string };
    };
    expect(read.window_start).toBe(queuedWindowStart);
    expect(read.window_end).toBe(queuedWindowEnd);
    expect(read.extraction_schema?.required).toContain('tasks');
    expect(read.extraction_schema?.properties?.tasks).toBeDefined();
    expect(read.extraction_schema?.properties?.findings).toBeUndefined();
    expect(read.content.map((item) => Number(item.id))).toContain(triggerEvent.id);
    if (!read.window_token) throw new Error('run-bound read returned no window token');
    // An ordinary run-bound read starts at the mark, so it leaves nothing
    // unclaimed behind it, and the axis travels with the bounds.
    expect(read.window_axis).toBe('created_at');
    expect(read.window_lag?.unclaimed_from).toBeNull();
    expect(read.window_lag?.unclaimed_to).toBeNull();
    expect(
      (await verifyWindowToken(read.window_token, TEST_ENV)).granularity
    ).toBeUndefined();

    const unrelatedEvent = await createTestEvent({
      entity_id: parent.id,
      organization_id: workspace.org.id,
      content: 'Not part of the queued run trigger snapshot.',
      occurred_at: triggerOccurredAt,
    });
    await expect(
      workspace.owner.knowledge.read({
        automation_id: automationId,
        run_id: triggered.run_id,
        content_ids: [unrelatedEvent.id],
      })
    ).rejects.toThrow(/does not include trigger content id/);

    const other = (await workspace.owner.automations.create({
      entity_id: parent.id,
      slug: 'other-external-automation',
      name: 'Other External Automation',
      prompt: 'Do something else.',
      sources: [
        {
          name: 'signals',
          query: 'SELECT id, payload_text, occurred_at FROM events WHERE false',
        },
      ],
    })) as { automation_id: string };
    await expect(
      workspace.owner.knowledge.read({
        automation_id: Number(other.automation_id),
        run_id: triggered.run_id,
      })
    ).rejects.toThrow(/does not belong to Automation/);

    await expect(
      workspace.owner.automations.completeWindow({
        automation_id: created.automation_id,
        run_id: triggered.run_id,
        window_token: read.window_token,
        extracted_data: {
          tasks: [{ task_key: 'invalid-before-claim' }],
        },
        model: 'chatgpt/test',
      })
    ).rejects.toThrow(/extracted_data does not match/);
    const [stillPendingAfterInvalid] = await sql<{
      status: string;
      claimed_by: string | null;
    }>`
      SELECT status, claimed_by FROM runs WHERE id = ${triggered.run_id}
    `;
    expect(stillPendingAfterInvalid).toEqual({
      status: 'pending',
      claimed_by: null,
    });

    const identitylessContext: ToolContext = {
      organizationId: workspace.org.id,
      userId: null,
      memberRole: 'owner',
      agentId: null,
      isAuthenticated: true,
      clientId: null,
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      tokenType: 'session',
      scopedToOrg: true,
      allowCrossOrg: false,
      executionMode: 'live',
    };
    await expect(
      handleCompleteWindow(
        {
          action: 'complete_window',
          automation_id: created.automation_id,
          run_id: triggered.run_id,
          window_token: read.window_token,
          extracted_data: {
            tasks: [{ task_key: 'identityless', action: 'Must not persist' }],
          },
          model: 'chatgpt/test',
        } as never,
        TEST_ENV,
        identitylessContext
      )
    ).rejects.toThrow(/complete_window requires an identified caller/);
    const [stillUnclaimed] = await sql<{ status: string; claimed_by: string | null }>`
      SELECT status, claimed_by FROM runs WHERE id = ${triggered.run_id}
    `;
    expect(stillUnclaimed).toEqual({ status: 'pending', claimed_by: null });

    const completion = (await workspace.owner.automations.completeWindow({
      automation_id: triggered.automation_id,
      run_id: triggered.run_id,
      window_token: read.window_token,
      extracted_data: {
        tasks: [{ task_key: 'invoice-review', action: 'Review invoice' }],
      },
      model: 'chatgpt/test',
    })) as { action: string; run_id: number };
    expect(completion.action).toBe('complete_window');
    expect(completion.run_id).toBe(triggered.run_id);

    const [completed] = await sql<{
      status: string;
      claimed_by: string | null;
      model_used: string | null;
      approved_input: Record<string, unknown>;
    }>`
      SELECT status, claimed_by, model_used, approved_input
      FROM runs
      WHERE id = ${triggered.run_id}
    `;
    expect(completed).toMatchObject({
      status: 'completed',
      // complete_window must persist the SAME owner encoding claim_next_window
      // writes, so a claimed run stays completable by its own claimant.
      claimed_by: claimOwnerForUser(workspace.users.owner.id),
      model_used: 'chatgpt/test',
    });
    expect(completed.approved_input.granularity).toBeUndefined();
    const completedReplay = (await workspace.owner.automations.completeWindow({
      automation_id: created.automation_id,
      run_id: triggered.run_id,
      window_token: read.window_token,
      extracted_data: {
        tasks: [{ task_key: 'invoice-review', action: 'Review invoice' }],
      },
      model: 'chatgpt/test',
    })) as { completed_now: boolean };
    expect(completedReplay.completed_now).toBe(false);

    // A token minted for run A must not authorize run B even when both runs
    // deliberately cover the same Automation period.
    const secondRun = await createAutomationRun({
      organizationId: workspace.org.id,
      automationId,
      agentId: null,
      windowStart: queuedWindowStart,
      windowEnd: queuedWindowEnd,
      dispatchSource: 'manual',
    });
    await expect(
      handleAutomationMode(
        {
          automation_id: automationId,
          run_id: secondRun.runId,
        },
        TEST_ENV,
        sql,
        {
          organizationId: workspace.org.id,
          userId: workspace.users.owner.id,
          claimedWindow: {
            runId: triggered.run_id,
            windowStart: queuedWindowStart,
            windowEnd: queuedWindowEnd,
            templateVersionId: queuedVersionId,
          },
        }
      )
    ).rejects.toThrow(/does not match claimed run/);
    await expect(
      workspace.owner.automations.completeWindow({
        automation_id: created.automation_id,
        run_id: secondRun.runId,
        window_token: read.window_token,
        extracted_data: {
          findings: [{ task_key: 'wrong-run', action: 'Must not persist' }],
        },
        model: 'chatgpt/test',
      })
    ).rejects.toThrow(/window_token is fenced to Automation run/);
    const [stillPending] = await sql<{ status: string }>`
      SELECT status FROM runs WHERE id = ${secondRun.runId}
    `;
    expect(stillPending.status).toBe('pending');

    const legacyToken = await generateWindowToken(
      {
        automation_id: automationId,
        window_start: queuedWindowStart,
        window_end: queuedWindowEnd,
        content_count: 0,
        content_ids: [],
      },
      TEST_ENV
    );
    await expect(
      workspace.owner.automations.completeWindow({
        automation_id: created.automation_id,
        run_id: secondRun.runId,
        window_token: legacyToken,
        extracted_data: {
          findings: [{ task_key: 'legacy-token', action: 'Must not persist' }],
        },
        model: 'chatgpt/test',
      })
    ).rejects.toThrow(/requires a run-bound window_token/);
    const [stillPendingAfterLegacyToken] = await sql<{
      status: string;
      claimed_by: string | null;
    }>`
      SELECT status, claimed_by FROM runs WHERE id = ${secondRun.runId}
    `;
    expect(stillPendingAfterLegacyToken).toEqual({
      status: 'pending',
      claimed_by: null,
    });

    const secondRead = (await workspace.owner.knowledge.read({
      automation_id: automationId,
      run_id: secondRun.runId,
      limit: 25,
    })) as { window_token?: string };
    if (!secondRead.window_token) throw new Error('second run returned no window token');

    const secondTokenPayload = await verifyWindowToken(secondRead.window_token, TEST_ENV);
    if (secondTokenPayload.run_id == null) {
      throw new Error('second run returned an unbound window token');
    }
    const boundRootToken = await generateWindowToken(
      {
        automation_id: secondTokenPayload.automation_id,
        run_id: secondTokenPayload.run_id,
        window_start: secondTokenPayload.window_start,
        window_end: secondTokenPayload.window_end,
        content_count: 0,
        content_ids: [],
      },
      TEST_ENV
    );
    const unboundContinuationToken = await generateWindowToken(
      {
        automation_id: secondTokenPayload.automation_id,
        window_start: secondTokenPayload.window_start,
        window_end: secondTokenPayload.window_end,
        content_count: 0,
        content_ids: [],
      },
      TEST_ENV
    );
    await expect(
      workspace.owner.automations.completeWindow({
        automation_id: created.automation_id,
        run_id: secondRun.runId,
        window_tokens: [boundRootToken, unboundContinuationToken],
        extracted_data: {
          findings: [{ task_key: 'mixed-fence', action: 'Must not persist' }],
        },
        model: 'chatgpt/test',
      })
    ).rejects.toThrow(/must all carry the same Automation run fence/);
    const [stillPendingAfterMixedFence] = await sql<{
      status: string;
      claimed_by: string | null;
    }>`
      SELECT status, claimed_by FROM runs WHERE id = ${secondRun.runId}
    `;
    expect(stillPendingAfterMixedFence).toEqual({ status: 'pending', claimed_by: null });

    // The external claim is part of the completion transaction. A failure
    // after pending -> running must roll the claim back with every output write.
    await expect(
      workspace.owner.automations.completeWindow({
        automation_id: created.automation_id,
        run_id: secondRun.runId,
        window_token: secondRead.window_token,
        extracted_data: {
          findings: [
            { task_key: 'duplicate', action: 'Same key' },
            { task_key: 'duplicate', action: 'Same key' },
          ],
        },
        model: 'chatgpt/test',
      })
    ).rejects.toThrow(/duplicate exact key/);
    const [rolledBackClaim] = await sql<{
      status: string;
      claimed_by: string | null;
    }>`
      SELECT status, claimed_by FROM runs WHERE id = ${secondRun.runId}
    `;
    expect(rolledBackClaim).toEqual({ status: 'pending', claimed_by: null });

    await sql`
      UPDATE runs
      SET status = 'running',
          claimed_by = 'mcp:other-client',
          claimed_at = NOW()
      WHERE id = ${secondRun.runId}
    `;
    await expect(
      workspace.owner.automations.completeWindow({
        automation_id: created.automation_id,
        run_id: secondRun.runId,
        window_token: secondRead.window_token,
        extracted_data: {
          findings: [{ task_key: 'other-claim', action: 'Must not persist' }],
        },
        model: 'chatgpt/test',
      })
    ).rejects.toThrow(/already claimed by another executor/);

    // A running row without durable claimant attribution is invalid state. An
    // external caller must not adopt it by supplying a valid run-bound token.
    await sql`
      UPDATE runs
      SET claimed_by = NULL
      WHERE id = ${secondRun.runId}
    `;
    await expect(
      workspace.owner.automations.completeWindow({
        automation_id: created.automation_id,
        run_id: secondRun.runId,
        window_token: secondRead.window_token,
        extracted_data: {
          findings: [{ task_key: 'unclaimed-running', action: 'Must not persist' }],
        },
        model: 'chatgpt/test',
      })
    ).rejects.toThrow(/could not be claimed/);
    const [invalidRunning] = await sql<{ status: string; claimed_by: string | null }>`
      SELECT status, claimed_by FROM runs WHERE id = ${secondRun.runId}
    `;
    expect(invalidRunning).toEqual({ status: 'running', claimed_by: null });

    // Retrying a claim already durably owned by this caller remains valid.
    await sql`
      UPDATE runs
      SET claimed_by = ${claimOwnerForUser(workspace.users.owner.id)}
      WHERE id = ${secondRun.runId}
    `;
    const sameClaimRetry = (await workspace.owner.automations.completeWindow({
      automation_id: created.automation_id,
      run_id: secondRun.runId,
      window_token: secondRead.window_token,
      extracted_data: { findings: [] },
      model: 'chatgpt/test',
    })) as { completed_now: boolean };
    expect(sameClaimRetry.completed_now).toBe(true);

    const legacyWindowStart = new Date(
      new Date(queuedWindowStart).getTime() + 14 * 24 * 60 * 60 * 1000
    ).toISOString();
    const legacyWindowEnd = new Date(
      new Date(queuedWindowEnd).getTime() + 14 * 24 * 60 * 60 * 1000
    ).toISOString();
    const inProcessRun = await createAutomationRun({
      organizationId: workspace.org.id,
      automationId,
      agentId: null,
      windowStart: legacyWindowStart,
      windowEnd: legacyWindowEnd,
      dispatchSource: 'manual',
    });
    await sql`
      UPDATE runs
      SET approved_input = approved_input - 'window_start' - 'window_end'
      WHERE id = ${inProcessRun.runId}
    `;

    // An external pending read has no authoritative claim context and must not
    // reconstruct a missing durable snapshot from the live arrival mark. The
    // mark always yields SOME window, so a fallback here would silently hand a
    // caller a range the run never recorded.
    await expect(
      handleAutomationMode(
        { automation_id: automationId, run_id: inProcessRun.runId },
        TEST_ENV,
        sql,
        {
          organizationId: workspace.org.id,
          userId: workspace.users.owner.id,
        }
      )
    ).rejects.toThrow(/missing a valid queued window snapshot/);
    const [pendingWithoutSnapshot] = await sql<{
      status: string;
      claimed_by: string | null;
    }>`
      SELECT status, claimed_by FROM runs WHERE id = ${inProcessRun.runId}
    `;
    expect(pendingWithoutSnapshot).toEqual({ status: 'pending', claimed_by: null });

    // origin/main already resolves trusted claimedWindow context for the
    // matching claimed/running in-process run. Preserve that established lane
    // without adding a general mark-based fallback for external callers. Put
    // the snapshot back first: the bound-run load requires it whoever is
    // calling, and the assertion above has had its answer.
    await sql`
      UPDATE runs
      SET status = 'running',
          approved_input = approved_input || ${sql.json({
            window_start: legacyWindowStart,
            window_end: legacyWindowEnd,
          })}::jsonb
      WHERE id = ${inProcessRun.runId}
    `;
    const inProcessRead = await handleAutomationMode(
      { automation_id: automationId, run_id: inProcessRun.runId },
      TEST_ENV,
      sql,
      {
        organizationId: workspace.org.id,
        userId: null,
        claimedWindow: {
          runId: inProcessRun.runId,
          windowStart: legacyWindowStart,
          windowEnd: legacyWindowEnd,
          templateVersionId: queuedVersionId,
        },
      }
    );
    expect(inProcessRead.window_axis).toBe('created_at');
    const inProcessToken = await verifyWindowToken(inProcessRead.window_token, TEST_ENV);
    expect(inProcessToken).toMatchObject({
      run_id: inProcessRun.runId,
    });

    const promoted = await sql<{
      parent_id: number | null;
      metadata: Record<string, unknown>;
    }>`
      SELECT e.parent_id, e.metadata
      FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id
      WHERE ei.organization_id = ${workspace.org.id}
        AND ei.namespace = 'automation_key'
        AND e.deleted_at IS NULL
    `;
    expect(promoted).toHaveLength(1);
    expect(Number(promoted[0].parent_id)).toBe(parent.id);
    expect(promoted[0].metadata).toMatchObject({
      task_key: 'invoice-review',
      action: 'Review invoice',
      automation_id: automationId,
      run_id: triggered.run_id,
    });
  });
});
