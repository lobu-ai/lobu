import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mutationPrincipalId, upsertEntityApprovalPolicy } from '../../../authz/entity-policy';
import type { Env } from '../../../index';
import { createAutomationRun } from '../../../runs/queue-service';
import { handleApprove } from '../../../tools/admin/manage_operations/handlers/approvals';
import { handleExecute } from '../../../tools/admin/manage_operations/handlers/execute';
import type { ToolContext } from '../../../tools/registry';
import { activatePageRun } from '../../../worker-api/page-activation';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAgent, createTestConnection, createTestConnectorDefinition, seedOwnerContext,
} from '../../setup/test-fixtures';

describe('headless Automation approval and page ownership', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    await initWorkspaceProvider();
  });
  afterAll(cleanupTestDatabase);

  it('keeps the Automation creator as page owner through Ask, approval, and an exact page visit', async () => {
    const sql = getTestDb();
    const { org, user, ctx: ownerContext } = await seedOwnerContext();
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    const [automation] = await sql<{ id: number }>`
      WITH next_id AS (SELECT nextval('automations_id_seq')::integer AS id)
      INSERT INTO automations (id, automation_group_id, organization_id, managed_agent_id, created_by, name, slug)
      SELECT id, id, ${org.id}, ${agent.agentId}, ${user.id}, 'Draft approval fixture', 'draft-approval-fixture'
      FROM next_id RETURNING id
    `;
    const sourceRun = await createAutomationRun({
      organizationId: org.id, automationId: Number(automation.id), agentId: agent.agentId,
      windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-09-01T01:00:00.000Z', dispatchSource: 'manual',
    }, sql);
    const connectorKey = 'automation-page-owner-fixture';
    await createTestConnectorDefinition({ key: connectorKey, name: 'Page owner fixture', organization_id: org.id });
    await sql`UPDATE connector_definitions SET actions_schema = ${sql.json({
      stage_draft: { name: 'Stage draft', kind: 'write' },
    })} WHERE organization_id = ${org.id} AND key = ${connectorKey}`;
    const connection = await createTestConnection({
      organization_id: org.id, connector_key: connectorKey, created_by: user.id,
      visibility: 'private', createDefaultFeed: false,
    });
    await upsertEntityApprovalPolicy(org.id, {
      resourceClass: 'connector_action', connectorKey, effects: { execute: 'approval' },
    });
    const automationContext: ToolContext = {
      ...ownerContext, userId: null, memberRole: null, agentId: null, tokenType: 'session',
      actingAutomationId: Number(automation.id), actingRunId: sourceRun.runId,
      sourceContext: { source: 'automation-run' }, baseUrl: 'https://gateway.example.test/lobu',
    };
    const targetUrl = 'https://example.test/draft?id=123';
    const queued = await handleExecute({
      action: 'execute', connection_id: connection.id, operation_key: 'stage_draft', input: { text: 'Draft only' },
      activation: { kind: 'page_visit', urls: [targetUrl], expires_in_seconds: 300 },
    }, automationContext, {} as Env) as { status: string; run_id: number };
    expect(queued.status).toBe('pending_approval');
    const load = async () => (await sql`
      SELECT status, approval_status, created_by_user_id, policy_principal_kind, policy_principal_id,
        activated_at, activation_tab_id FROM runs WHERE id = ${queued.run_id}
    `)[0];
    expect(await load()).toMatchObject({
      status: 'pending', approval_status: 'pending', created_by_user_id: user.id,
      policy_principal_kind: 'automation',
      policy_principal_id: mutationPrincipalId({ automationId: Number(automation.id) }),
      activated_at: null,
    });
    const workerId = 'automation-page-owner-browser';
    await sql`INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id, app_version)
      VALUES (${user.id}, ${workerId}, 'chrome-extension', '[]'::jsonb, ${org.id}, '0.6.1')`;
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      c.set('workerAuthMode', 'user'); c.set('workerUserId', user.id); c.set('workerOrgIds', [org.id]);
      await next();
    });
    app.post('/activate', activatePageRun);
    const visit = (url = targetUrl) => app.request('/activate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker_id: workerId, run_id: queued.run_id, tab_id: 23, url }),
    });
    expect(await (await visit()).json()).toEqual({ status: 'unavailable' });
    const approved = await handleApprove({ action: 'approve', run_id: queued.run_id }, {
      ...ownerContext, tokenType: 'session', baseUrl: 'https://gateway.example.test/lobu',
    }, {} as Env);
    expect(approved).toMatchObject({ approved: true, run_id: queued.run_id });
    expect(await load()).toMatchObject({ status: 'pending', approval_status: 'approved', activated_at: null });
    expect(await (await visit('https://example.test/draft?id=456')).json()).toEqual({ status: 'unavailable' });
    expect(await (await visit()).json()).toEqual({ status: 'activated' });
    expect(await load()).toMatchObject({
      status: 'pending', approval_status: 'approved', created_by_user_id: user.id, activation_tab_id: 23,
    });
  });
});
