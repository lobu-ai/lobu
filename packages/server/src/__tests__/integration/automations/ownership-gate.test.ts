/**
 * Ownership gate on direct agent entity writes.
 *
 * The human<->agent feedback loop protects human-owned entity fields via
 * `entities.field_controls` on the automation PROMOTION path, but the direct
 * `manage_entity` update path used to do a plain merge that silently clobbered
 * human-owned fields. After the fix, EVERY non-human `manage_entity update`
 * runs an ownership-aware `source:'automation'` merge: unowned fields write
 * normally, owned fields are BLOCKED and queued as a human approval, and the
 * tool result reports what happened so the agent can tell the user.
 *
 * These contracts pin that ownership gate end-to-end through `executeTool` (the real
 * access-controlled path) so the post-commit approval proposal is exercised.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import type { AuthContext } from '../../../tools/execute';
import { executeTool } from '../../../tools/execute';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createAutomationResultRun, createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const TEST_ENV: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
};

/** Owner web-session auth context (a real human — claims field ownership). */
function humanCtx(orgId: string, userId: string): AuthContext {
  return {
    organizationId: orgId,
    tokenOrganizationId: orgId,
    userId,
    memberRole: 'owner',
    agentId: null,
    requestedAgentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'session',
    requestUrl: `http://localhost/api/${orgId}`,
    baseUrl: '',
    scopedToOrg: true,
    allowCrossOrg: false,
  };
}

/** Agent auth context — same org/user but attributed to an agent run. */
function agentCtx(orgId: string, userId: string, agentId = 'test-agent-1'): AuthContext {
  return { ...humanCtx(orgId, userId), agentId, requestedAgentId: agentId };
}

async function manageEntityUpdate(
  ctx: AuthContext,
  entityId: number,
  metadata: Record<string, unknown>,
  opts?: {
    affirm_fields?: string[];
    automation_source?: { automation_id: number; run_id: number };
  }
) {
  return executeTool(
    'manage_entity',
    {
      action: 'update',
      entity_id: entityId,
      metadata,
      ...(opts?.affirm_fields ? { affirm_fields: opts.affirm_fields } : {}),
      ...(opts?.automation_source ? { automation_source: opts.automation_source } : {}),
    },
    TEST_ENV,
    ctx
  ) as Promise<{
    action: 'update';
    applied_fields?: string[];
    blocked_fields?: string[];
    approval_queued?: boolean;
    approval_url?: string;
    approval_run_id?: number;
    approval_fields?: Record<string, unknown>;
    approval_current?: Record<string, unknown>;
    approval_attribution?: 'agent' | 'automation';
  }>;
}

/** Seed an automation result run (real FKs for automation_source / reactions). */
async function seedAutomationAndRun(workspace: TestWorkspace, suffix: string) {
  const entity = await createTestEntity({
    name: `Gate Reaction Entity ${suffix}`,
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
  });
  const automation = (await workspace.owner.automations.create({
    entity_id: entity.id,
    slug: `gate-automation-${suffix}`,
    name: `Gate Automation ${suffix}`,
    prompt: 'Analyze inputs.',
    managed_agent_id: agent.agentId,
  })) as { automation_id: string };
  const runId = await createAutomationResultRun({
    automationId: Number(automation.automation_id),
    organizationId: workspace.org.id,
    windowStart: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    windowEnd: new Date(),
    extractedData: { problems: [] },
    createdBy: workspace.users.owner.id,
    entityIds: [entity.id],
  });
  return {
    entity,
    automationId: Number(automation.automation_id),
    runId,
    agentId: agent.agentId,
  };
}

describe('ownership gate on agent entity writes', () => {
  let workspace: TestWorkspace;
  let entity: { id: number };

  beforeEach(async () => {
    await cleanupTestDatabase();
    workspace = await TestWorkspace.create({ name: 'Ownership Gate Org' });
    const created = await createTestEntity({
      name: 'Gate Target Entity',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    entity = { id: created.id };
    // The default agentCtx binds 'test-agent-1' (and one test 'restricted-agent').
    // Prod binds an agentId only for an existing agent (codex-17), and the gate's
    // existence check now enforces it — so seed the rows these ctxs assume.
    for (const agentId of ['test-agent-1', 'restricted-agent']) {
      await createTestAgent({
        organizationId: workspace.org.id,
        agentId,
        ownerUserId: workspace.users.owner.id,
      });
    }
  });

  it.each([
    { label: 'OAuth', tokenType: 'oauth' as const, clientId: 'test-oauth-client', mcpSessionId: 'test-mcp-session' },
    { label: 'PAT', tokenType: 'pat' as const, clientId: 'pat_test-client' },
    { label: 'MCP', tokenType: 'session' as const, clientId: null, mcpSessionId: 'test-mcp-session' },
    { label: 'chat turn in another workspace', tokenType: 'session' as const, clientId: null, sourceContext: { platform: 'slack', source: 'test-chat-turn' } },
  ])('does not pin fields written through $label delegated auth', async ({ label: _label, ...transport }) => {
    const ctx = { ...humanCtx(workspace.org.id, workspace.users.owner.id), ...transport };
    const first = await manageEntityUpdate(ctx, entity.id, { severity: 'high' });
    expect(first.applied_fields).toContain('severity');
    const [row] = await getTestDb()`SELECT field_controls FROM entities WHERE id = ${entity.id}`;
    expect(row.field_controls).toEqual({});

    const next = await manageEntityUpdate(agentCtx(workspace.org.id, workspace.users.owner.id), entity.id, {
      severity: 'critical',
    });
    expect(next.applied_fields).toContain('severity');
    expect(next.approval_queued).toBeFalsy();
  });

  it('does not treat a verified Automation write carrying a user identity as a manual edit', async () => {
    const seeded = await seedAutomationAndRun(workspace, 'delegated');
    const result = await manageEntityUpdate(humanCtx(workspace.org.id, workspace.users.owner.id), seeded.entity.id, {
      severity: 'high',
    }, { automation_source: { automation_id: seeded.automationId, run_id: seeded.runId } });
    expect(result.applied_fields).toContain('severity');
    const [row] = await getTestDb()`SELECT field_controls FROM entities WHERE id = ${seeded.entity.id}`;
    expect(row.field_controls).toEqual({});
  });

  it('rejects field ownership assertions from an unbound OAuth client', async () => {
    const ctx = { ...humanCtx(workspace.org.id, workspace.users.owner.id), clientId: 'test-oauth-client' };
    await expect(manageEntityUpdate(ctx, entity.id, { severity: 'high' }, {
      affirm_fields: ['severity'],
    })).rejects.toThrow('affirm_fields is only allowed for human edits');
  });

  it('holds an unbound OAuth client overwrite of a genuine manual edit', async () => {
    const ctx = humanCtx(workspace.org.id, workspace.users.owner.id);
    await manageEntityUpdate(ctx, entity.id, { severity: 'high' });
    const result = await manageEntityUpdate({ ...ctx, clientId: 'test-oauth-client' }, entity.id, {
      severity: 'critical',
      notes: 'delegated write',
    });
    expect(result.blocked_fields).toContain('severity');
    expect(result.applied_fields).toContain('notes');
    expect(result.approval_queued).toBe(true);
    const [row] = await getTestDb()`SELECT metadata, field_controls FROM entities WHERE id = ${entity.id}`;
    expect(row.metadata.severity).toBe('high');
    expect(row.field_controls.severity.set_by).toBe(workspace.users.owner.id);
    expect(row.field_controls.notes).toBeUndefined();
  });

  it('blocks an agent overwrite of a human-owned field and queues an approval', async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;

    // Human claims ownership of `severity` by setting it.
    await manageEntityUpdate(humanCtx(org, user), entity.id, {
      severity: 'high',
    });

    // Agent tries to overwrite the owned field AND write a fresh unowned field.
    const result = await manageEntityUpdate(agentCtx(org, user), entity.id, {
      severity: 'critical',
      notes: 'agent-added',
    });

    // Owned field UNCHANGED — the agent did not clobber it.
    const [row] = await getTestDb()`
      SELECT metadata, field_controls FROM entities WHERE id = ${entity.id}
    `;
    const metadata = row.metadata as Record<string, unknown>;
    const controls = row.field_controls as Record<string, unknown>;
    expect(metadata.severity).toBe('high');
    expect(controls.severity).toBeTruthy();

    // Unowned field wrote through.
    expect(metadata.notes).toBe('agent-added');

    // A pending approval run + interaction event exist for the blocked field.
    const [run] = await getTestDb()`
      SELECT id, action_input FROM runs
      WHERE organization_id = ${org}
        AND run_type = 'internal'
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
        AND status = 'pending'
    `;
    expect(run).toBeTruthy();
    const proposal = run.action_input as {
      entity_id: number;
      fields: Record<string, unknown>;
    };
    expect(Number(proposal.entity_id)).toBe(entity.id);
    expect(proposal.fields.severity).toBe('critical');

    const [event] = await getTestDb()`
      SELECT interaction_status FROM events
      WHERE run_id = ${run.id} AND interaction_type = 'approval'
    `;
    expect(event?.interaction_status).toBe('pending');

    // The tool result told the agent what happened.
    expect(result.blocked_fields).toContain('severity');
    expect(result.applied_fields).toContain('notes');
    expect(result.approval_queued).toBe(true);

    // The result carries the bridge fields the worker forwards into a live
    // chat approval card (parity with manage_agents' pending_approval).
    expect(result.approval_run_id).toBe(Number(run.id));
    expect(result.approval_fields?.severity).toBe('critical');
    expect(result.approval_current?.severity).toBe('high');
    expect(result.approval_attribution).toBe('agent');
  });

  it('writes unowned fields without producing an approval', async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;

    const result = await manageEntityUpdate(agentCtx(org, user), entity.id, {
      domain: 'agent-set.example',
      category: 'SaaS',
    });

    const [row] = await getTestDb()`SELECT metadata FROM entities WHERE id = ${entity.id}`;
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.domain).toBe('agent-set.example');
    expect(metadata.category).toBe('SaaS');

    expect(result.applied_fields).toEqual(expect.arrayContaining(['domain', 'category']));
    expect(result.blocked_fields ?? []).toEqual([]);

    const approvals = await getTestDb()`
      SELECT id FROM runs
      WHERE organization_id = ${org}
        AND run_type = 'internal'
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    expect(approvals).toHaveLength(0);
    expect(result.approval_queued).toBeFalsy();
  });

  it('attributes the proposal to the automation on the reaction path', async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;
    const {
      entity: reactionEntity,
      automationId,
      runId,
      agentId,
    } = await seedAutomationAndRun(workspace, 'reaction');

    // Human owns the field first.
    await manageEntityUpdate(humanCtx(org, user), reactionEntity.id, {
      severity: 'high',
    });

    // The reaction acts as its OWN automation: the explicit automation_source names an
    // automation owned by this agent, so the tag is honored (an agent can only tag
    // its own automation — a foreign tag is ignored, see resolveActingPrincipal).
    const result = await manageEntityUpdate(
      agentCtx(org, user, agentId),
      reactionEntity.id,
      { severity: 'critical' },
      { automation_source: { automation_id: automationId, run_id: runId } }
    );

    const [row] = await getTestDb()`SELECT metadata FROM entities WHERE id = ${reactionEntity.id}`;
    expect((row.metadata as Record<string, unknown>).severity).toBe('high');

    const [run] = await getTestDb()`
      SELECT action_input FROM runs
      WHERE organization_id = ${org}
        AND run_type = 'internal'
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    expect(run).toBeTruthy();
    expect(Number((run.action_input as { automation_id: number }).automation_id)).toBe(automationId);

    // The card attribution flows through as 'automation' so the SPA labels it
    // "An automation proposes…" instead of "An agent proposes…".
    expect(result.approval_attribution).toBe('automation');
  });

  it("ignores a caller-supplied automation_source that is NOT the acting agent's own automation", async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;
    // An automation owned by a DIFFERENT agent than the one making the call.
    const {
      entity: target,
      automationId,
      runId,
    } = await seedAutomationAndRun(workspace, 'foreign');

    await manageEntityUpdate(humanCtx(org, user), target.id, {
      severity: 'high',
    });

    // A restricted agent tags the foreign automation, trying to escape its own
    // envelope. The tag must be IGNORED → the write is attributed to the agent,
    // not the automation (ownerAgentId can't be nulled out via a foreign tag).
    const result = await manageEntityUpdate(
      agentCtx(org, user, 'restricted-agent'),
      target.id,
      { severity: 'critical' },
      { automation_source: { automation_id: automationId, run_id: runId } }
    );

    expect(result.approval_attribution).toBe('agent');
  });

  it('collapses an identical repeated agent edit into a single pending approval', async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;

    await manageEntityUpdate(humanCtx(org, user), entity.id, {
      severity: 'high',
    });

    await manageEntityUpdate(agentCtx(org, user), entity.id, {
      severity: 'critical',
    });
    await manageEntityUpdate(agentCtx(org, user), entity.id, {
      severity: 'critical',
    });

    const pending = await getTestDb()`
      SELECT id FROM runs
      WHERE organization_id = ${org}
        AND run_type = 'internal'
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    expect(pending).toHaveLength(1);
  });

  it('applies the field change when the queued proposal is approved', async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;

    await manageEntityUpdate(humanCtx(org, user), entity.id, {
      severity: 'high',
    });
    await manageEntityUpdate(agentCtx(org, user), entity.id, {
      severity: 'critical',
    });

    const [pending] = await getTestDb()`
      SELECT id FROM runs
      WHERE organization_id = ${org}
        AND run_type = 'internal'
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    expect(pending).toBeTruthy();

    const approveRes = (await executeTool(
      'manage_operations',
      { action: 'approve', run_id: Number(pending.id) },
      TEST_ENV,
      humanCtx(org, user)
    )) as { approved?: boolean };
    expect(approveRes.approved).toBe(true);

    const [applied] = await getTestDb()`
      SELECT metadata, field_controls FROM entities WHERE id = ${entity.id}
    `;
    expect((applied.metadata as Record<string, unknown>).severity).toBe('critical');
    // Still human-owned — an approved value remains protected.
    expect((applied.field_controls as Record<string, unknown>).severity).toBeTruthy();
  });

  it('rejects affirm_fields from an agent context (an agent cannot claim ownership)', async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;

    await expect(
      manageEntityUpdate(agentCtx(org, user), entity.id, {}, { affirm_fields: ['severity'] })
    ).rejects.toThrow(/affirm_fields/);
  });
});
