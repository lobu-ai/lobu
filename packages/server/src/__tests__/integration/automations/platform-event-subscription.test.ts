/**
 * Subscribing to platform events, at the surface where it was blocked.
 *
 * The activation path could already deliver a platform audit row to a
 * subscriber, but `assertAutomationTriggerConnections` rejected the
 * subscription itself: it required the type to appear in some entity type's
 * `event_kinds`, and platform events have no declaring entity type. These
 * tests cover the seam from the caller's side — creating the Automation — plus
 * the collision guard that keeps the two catalogs from merging.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, cleanupTestDatabase } from '../../setup/test-db';
import { createTestAgent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

async function orgWithAgent(name: string) {
  const workspace = await TestWorkspace.create({ name });
  const ownerUserId = workspace.users.owner.id;
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: 'platform-subscription-agent',
  });
  const api = await TestApiClient.for({
    organizationId: workspace.org.id,
    userId: ownerUserId,
    memberRole: 'owner',
  });
  return { workspace, agent, api };
}

function workspaceTrigger(eventTypes: string[], entityType?: string) {
  return [
    {
      kind: 'event',
      source: 'workspace',
      event_types: eventTypes,
      execution: 'window',
      active_run: 'queue',
      ...(entityType ? { entity_type: entityType } : {}),
    },
  ];
}

describe('platform event subscriptions', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('accepts a platform type that no entity type declares', async () => {
    const { agent, api } = await orgWithAgent('Platform Subscribe Org');
    // Nothing is declared anywhere in this organization. Before the computed
    // catalog this threw "Workspace does not declare workspace event".
    const created = (await api.automations.create({
      slug: 'connection-consumer',
      prompt: 'Handle the platform event.',
      triggers: workspaceTrigger(['connection.deleted']),
      managed_agent_id: agent.agentId,
    })) as { automation_id: string };
    expect(Number(created.automation_id)).toBeGreaterThan(0);
  });

  it('rejects a typo instead of accepting a subscription that can never fire', async () => {
    const { agent, api } = await orgWithAgent('Platform Typo Org');
    await expect(
      api.automations.create({
        slug: 'typo-consumer',
        prompt: 'Handle the platform event.',
        triggers: workspaceTrigger(['connection.delted']),
        managed_agent_id: agent.agentId,
      })
    ).rejects.toThrow(/does not declare workspace event/i);
  });

  it('rejects `change`, which names a storage class rather than an event', async () => {
    const { agent, api } = await orgWithAgent('Change Firehose Org');
    // Undeclared, so this fails at validation. The matcher refuses it too —
    // see workspace-event-roots — because an org MAY declare `change` as a
    // content kind, and that must not turn into an audit firehose.
    await expect(
      api.automations.create({
        slug: 'firehose-consumer',
        prompt: 'Handle every write.',
        triggers: workspaceTrigger(['change']),
        managed_agent_id: agent.agentId,
      })
    ).rejects.toThrow(/does not declare workspace event/i);
  });

  it('narrows an entity subscription by entity type', async () => {
    const { agent, api } = await orgWithAgent('Entity Narrow Org');
    await api.entity_schema.createType({
      slug: 'invoice',
      name: 'Invoice',
      metadata_schema: { type: 'object', properties: {} },
    });
    // "When an invoice changes" is the platform `entity.updated` event plus the
    // trigger's existing entity_type filter — no per-entity-type event needed.
    const created = (await api.automations.create({
      slug: 'invoice-consumer',
      prompt: 'Handle the invoice change.',
      triggers: workspaceTrigger(['entity.updated'], 'invoice'),
      managed_agent_id: agent.agentId,
    })) as { automation_id: string };
    expect(Number(created.automation_id)).toBeGreaterThan(0);
  });

  it('rolls an entity update back when its subscribed activation task cannot be persisted', async () => {
    const sql = getTestDb();
    const { agent, api, workspace } = await orgWithAgent('Entity Activation Atomic Org');
    await api.entity_schema.createType({ slug: 'invoice', name: 'Invoice' });
    await api.automations.create({
      slug: 'invoice-atomic-consumer',
      prompt: 'Handle invoice updates.',
      triggers: workspaceTrigger(['entity.updated'], 'invoice'),
      managed_agent_id: agent.agentId,
    });
    const created = (await api.entities.create({
      entity_type: 'invoice',
      name: 'Atomic Invoice',
      metadata: { status: 'draft' },
    })) as { entity: { id: number } };

    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION test_fail_workspace_activation_task() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.run_type = 'task' AND NEW.action_key = 'activate-workspace-event' THEN
          RAISE EXCEPTION 'simulated activation task persistence failure';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_workspace_activation_task_trg
        BEFORE INSERT ON runs
        FOR EACH ROW EXECUTE FUNCTION test_fail_workspace_activation_task();
    `);
    try {
      await expect(
        api.entities.update({
          entity_id: created.entity.id,
          metadata: { status: 'posted' },
        })
      ).rejects.toThrow(/activation task persistence failure/i);
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS test_fail_workspace_activation_task_trg ON runs;
        DROP FUNCTION IF EXISTS test_fail_workspace_activation_task();
      `);
    }

    const [row] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM entities
      WHERE organization_id = ${workspace.org.id} AND id = ${created.entity.id}
    `;
    expect(row.metadata).toEqual({ status: 'draft' });
    const events = await sql`
      SELECT id FROM events
      WHERE organization_id = ${workspace.org.id}
        AND ${created.entity.id} = ANY(entity_ids)
        AND metadata->>'_lobu_event_type' = 'entity.updated'
    `;
    expect(events).toHaveLength(0);
  });

  it('refuses to let an entity type redeclare a platform event type', async () => {
    const { api } = await orgWithAgent('Collision Org');
    // `event_kinds` is what `save_content` validates against, so declaring
    // `connection.deleted` here would make it postable as ordinary content and
    // let a forged row activate real subscribers.
    await expect(
      api.entity_schema.createType({
        slug: 'forged',
        name: 'Forged',
        metadata_schema: { type: 'object', properties: {} },
        event_kinds: { 'connection.deleted': { description: 'forged' } },
      })
    ).rejects.toThrow(/may not redeclare platform event types/i);

    await api.entity_schema.createType({
      slug: 'legit',
      name: 'Legit',
      metadata_schema: { type: 'object', properties: {} },
      event_kinds: { risk_detected: { description: 'fine' } },
    });
    // The same guard runs on update, not only create — otherwise a clean type
    // could be amended into the collision afterwards.
    await expect(
      api.entity_schema.updateType({
        slug: 'legit',
        event_kinds: { 'device.deleted': { description: 'forged' } },
      })
    ).rejects.toThrow(/may not redeclare platform event types/i);
  });

  it('leaves the declared content catalog working alongside the platform one', async () => {
    const sql = getTestDb();
    const { workspace, agent, api } = await orgWithAgent('Union Org');
    await api.entity_schema.createType({
      slug: 'account',
      name: 'Account',
      metadata_schema: { type: 'object', properties: {} },
      event_kinds: { risk_detected: { description: 'A risk was detected' } },
    });
    const created = (await api.automations.create({
      slug: 'union-consumer',
      prompt: 'Handle either.',
      triggers: workspaceTrigger(['risk_detected']),
      managed_agent_id: agent.agentId,
    })) as { automation_id: string };
    expect(Number(created.automation_id)).toBeGreaterThan(0);
    expect(
      await sql`
        SELECT id FROM automations WHERE organization_id = ${workspace.org.id}
      `
    ).toHaveLength(1);
  });
});
