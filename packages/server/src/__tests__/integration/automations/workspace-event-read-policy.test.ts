import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import type { AuthContext } from '../../../tools/execute';
import { executeTool } from '../../../tools/execute';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {} as Env;

async function denyRead(args: {
  organizationId: string;
  agentId: string;
  entityType: string;
}): Promise<void> {
  const sql = getTestDb();
  const rows = await sql<{ id: number }>`
    INSERT INTO write_approval_policies
      (organization_id, resource_class, principal_kind, principal_id,
       entity_type_slug)
    VALUES
      (${args.organizationId}, 'entity', 'agent', ${args.agentId},
       ${args.entityType})
    RETURNING id
  `;
  await sql`
    INSERT INTO write_policy_action_effects (policy_id, action, effect)
    VALUES (${rows[0].id}, 'read', 'deny')
  `;
}

describe('workspace-event exact-input read policy', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('infers linked entity types from content_ids and denies the whole exact read', async () => {
    const org = await createTestOrganization({
      name: 'Workspace Event ACL Org',
    });
    const owner = await createTestUser({
      email: 'workspace-event-acl@test.example.com',
    });
    await addUserToOrganization(owner.id, org.id, 'owner');
    const agent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: owner.id,
      agentId: 'workspace-event-consumer',
    });
    const secret = await createTestEntity({
      name: 'Secret account',
      entity_type: 'secret',
      organization_id: org.id,
      created_by: owner.id,
    });
    const event = await createTestEvent({
      organization_id: org.id,
      entity_id: secret.id,
      semantic_type: 'risk_detected',
      content: 'Confidential trigger payload',
    });
    await denyRead({
      organizationId: org.id,
      agentId: agent.agentId,
      entityType: 'secret',
    });

    const ctx: AuthContext = {
      organizationId: org.id,
      tokenOrganizationId: org.id,
      userId: owner.id,
      memberRole: 'owner',
      agentId: agent.agentId,
      requestedAgentId: null,
      isAuthenticated: true,
      clientId: null,
      scopes: ['mcp:read'],
      tokenType: 'oauth',
      requestUrl: `http://localhost/api/${org.id}`,
      baseUrl: 'http://localhost',
      scopedToOrg: true,
      allowCrossOrg: false,
    };

    await expect(
      executeTool(
        'read_knowledge',
        { content_ids: Array.from({ length: 2001 }, (_, index) => index + 1) },
        TEST_ENV,
        ctx
      )
    ).rejects.toThrow(/at most 2000 content_ids/);

    await expect(
      executeTool(
        'read_knowledge',
        { content_ids: [event.id], limit: 1 },
        TEST_ENV,
        ctx
      )
    ).rejects.toThrow(/Policy denies reading entities of type 'secret'/);
  });

  it('places unbound exact inputs under the workspace-wide $member policy', async () => {
    const org = await createTestOrganization({
      name: 'Workspace Event Member ACL Org',
    });
    const owner = await createTestUser({
      email: 'workspace-event-member@test.example.com',
    });
    await addUserToOrganization(owner.id, org.id, 'owner');
    const agent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: owner.id,
      agentId: 'workspace-event-member-consumer',
    });
    const event = await createTestEvent({
      organization_id: org.id,
      semantic_type: 'workspace_notice',
      content: 'Workspace-wide trigger payload',
    });
    await denyRead({
      organizationId: org.id,
      agentId: agent.agentId,
      entityType: '$member',
    });

    const ctx: AuthContext = {
      organizationId: org.id,
      tokenOrganizationId: org.id,
      userId: owner.id,
      memberRole: 'owner',
      agentId: agent.agentId,
      requestedAgentId: null,
      isAuthenticated: true,
      clientId: null,
      scopes: ['mcp:read'],
      tokenType: 'oauth',
      requestUrl: `http://localhost/api/${org.id}`,
      baseUrl: 'http://localhost',
      scopedToOrg: true,
      allowCrossOrg: false,
    };

    await expect(
      executeTool(
        'read_knowledge',
        { content_ids: [event.id], limit: 1 },
        TEST_ENV,
        ctx
      )
    ).rejects.toThrow(/Policy denies reading entities of type '\$member'/);
  });

  it('applies entity-type policy to an exact event, and never returns one another workspace owns', async () => {
    const producerOrg = await createTestOrganization({ name: 'Linked Event Producer Org' });
    const consumerOrg = await createTestOrganization({ name: 'Linked Event Consumer Org' });
    const owner = await createTestUser({ email: 'linked-event-consumer@test.example.com' });
    await addUserToOrganization(owner.id, consumerOrg.id, 'owner');
    const agent = await createTestAgent({
      organizationId: consumerOrg.id,
      ownerUserId: owner.id,
      agentId: 'linked-event-consumer',
    });
    const secret = await createTestEntity({
      name: 'Cross-workspace secret',
      entity_type: 'secret',
      organization_id: consumerOrg.id,
      created_by: owner.id,
    });
    const event = await createTestEvent({
      organization_id: consumerOrg.id,
      entity_id: secret.id,
      semantic_type: 'risk_detected',
      content: 'Confidential trigger payload',
    });
    const foreignEvent = await createTestEvent({
      organization_id: producerOrg.id,
      entity_id: secret.id,
      semantic_type: 'risk_detected',
      content: 'Cross-workspace confidential trigger payload',
    });
    await denyRead({
      organizationId: consumerOrg.id,
      agentId: agent.agentId,
      entityType: 'secret',
    });

    const ctx: AuthContext = {
      organizationId: consumerOrg.id,
      tokenOrganizationId: consumerOrg.id,
      userId: owner.id,
      memberRole: 'owner',
      agentId: agent.agentId,
      requestedAgentId: null,
      isAuthenticated: true,
      clientId: null,
      scopes: ['mcp:read'],
      tokenType: 'oauth',
      requestUrl: `http://localhost/api/${consumerOrg.id}`,
      baseUrl: 'http://localhost',
      scopedToOrg: true,
      allowCrossOrg: false,
    };

    await expect(
      executeTool(
        'read_knowledge',
        { content_ids: [event.id], limit: 1 },
        TEST_ENV,
        ctx
      )
    ).rejects.toThrow(/Policy denies reading entities of type 'secret'/);

    // Tagging this workspace's record does not make a foreign event readable here.
    const foreign = (await executeTool(
      'read_knowledge',
      { content_ids: [foreignEvent.id], limit: 1 },
      TEST_ENV,
      ctx
    )) as { content: unknown[]; total: number };
    expect(foreign.content).toEqual([]);
    expect(foreign.total).toBe(0);
  });
});
