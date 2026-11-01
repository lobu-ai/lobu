import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import type { ToolContext } from '../../../tools/registry';
import { validateAndScopeQuery } from '../../../utils/execute-data-sources';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { persistAutomationEventOutput } from '../../../utils/persist-automation-event-output';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestConnection, createTestEvent } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

// This pins the proposed private-distillation requirement. Parent provenance
// alone currently does not promise automatic access inheritance.
describe('private source distillation access audit', () => {
  beforeEach(cleanupTestDatabase);

  it('keeps a parent-cited private-source result outside a second member audience', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Synthetic Distillation Audit' });
    await ensureMemberEntityType(workspace.org.id);
    const ownerId = workspace.users.owner.id;
    const connection = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: 'google.gmail',
      created_by: ownerId,
      visibility: 'private',
    });
    const parent = await createTestEvent({
      organization_id: workspace.org.id,
      connection_id: connection.id,
      content: 'synthetic private source detail',
    });
    const visibleIds = async (userId: string) => {
      const scoped = validateAndScopeQuery('SELECT id FROM events', workspace.org.id, { userId });
      const rows = await sql.unsafe(scoped.sql, scoped.params as unknown[]);
      return rows.map(row => Number(row.id));
    };
    expect(await visibleIds(ownerId)).toContain(parent.id);
    expect(await visibleIds(workspace.users.member.id)).not.toContain(parent.id);
    const agent = await createTestAgent({ organizationId: workspace.org.id, ownerUserId: ownerId });
    const automation = await workspace.owner.automations.create({
      slug: 'synthetic-private-distillation',
      prompt: 'Distill selected synthetic source detail.',
      triggers: [],
      outputs: { facts: { event: 'observation' } },
      managed_agent_id: agent.agentId,
    }) as { automation_id: string };
    const automationId = Number(automation.automation_id);
    const [run] = await sql`
      INSERT INTO runs (organization_id, run_type, automation_id, approval_status, status)
      VALUES (${workspace.org.id}, 'automation', ${automationId}, 'auto', 'running')
      RETURNING id
    `;
    const [derived] = await sql.begin(tx => persistAutomationEventOutput({
      tx: tx as unknown as DbClient,
      ctx: { organizationId: workspace.org.id, userId: ownerId, memberRole: 'owner',
        isAuthenticated: true } as ToolContext,
      rows: [{ content: 'synthetic distilled private fact', parent_event_id: parent.id }],
      outputName: 'facts',
      output: { event: 'observation' },
      automationId,
      versionId: null,
      organizationId: workspace.org.id,
      runId: Number(run.id),
      boundEntityIds: [],
      validContentIds: new Set([parent.id]),
      occurredAt: new Date().toISOString(),
      createdBy: ownerId,
    }));
    expect(await visibleIds(ownerId)).toContain(Number(derived.id));
    expect(await visibleIds(workspace.users.member.id)).not.toContain(Number(derived.id));
  });
});
