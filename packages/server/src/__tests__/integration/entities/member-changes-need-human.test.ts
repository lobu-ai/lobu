/**
 * Inviting members, changing roles and removing members are human-only, by
 * the same rule as run approvals. An OAuth/MCP session, a PAT or run_sdk acts
 * with a user's authority but is not that user: a prompt injection reaching an agent with
 * mcp:admin must not be able to invite an outsider as owner and hand the
 * workspace off. The Lobu web app (a signed-in session) keeps working.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { proposeEntityCreate } from '../../../tools/admin/entity-field-approval';
import type { ToolContext } from '../../../tools/registry';
import { ensureMemberEntity } from '../../../utils/member-entity';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestSession,
  createTestUser,
} from '../../setup/test-fixtures';
import { mcpRequest, mcpToolsCall, post } from '../../setup/test-helpers';

const OUTSIDER_EMAIL = 'outsider@human-only.example.com';
const HUMAN_ONLY = /Inviting members, changing roles and removing members can only be done by a person in the Lobu web app/;

describe('member changes need a human', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let owner: { userId: string; cookie: string };
  let member: { userId: string; memberId: string; entityId: number };
  let adminToken: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    org = await createTestOrganization({ name: 'Human only org', slug: 'human-only-org' });
    const ownerUser = await createTestUser({ email: 'owner@human-only.example.com' });
    await addUserToOrganization(ownerUser.id, org.id, 'owner');
    await ensureMemberEntity({ organizationId: org.id, userId: ownerUser.id, name: 'Owner', email: ownerUser.email, role: 'owner', status: 'active' });
    owner = { userId: ownerUser.id, cookie: (await createTestSession(ownerUser.id)).cookieHeader };

    const memberUser = await createTestUser({ email: 'member@human-only.example.com' });
    const memberId = await addUserToOrganization(memberUser.id, org.id, 'member');
    await ensureMemberEntity({ organizationId: org.id, userId: memberUser.id, name: 'Member', email: memberUser.email, role: 'member', status: 'active' });
    const [entity] = await getTestDb()`SELECT entity_id FROM entity_identities WHERE organization_id = ${org.id} AND namespace = 'auth_user_id' AND identifier = ${memberUser.id}`;
    member = { userId: memberUser.id, memberId, entityId: Number(entity.entity_id) };

    const client = await createTestOAuthClient();
    ({ token: adminToken } = await createTestAccessToken(ownerUser.id, org.id, client.client_id, {
      scope: 'mcp:read mcp:write mcp:admin profile:read',
    }));
  });

  const inviteOutsiderAsOwner = {
    action: 'create',
    entity_type: '$member',
    name: 'Outsider',
    metadata: { email: OUTSIDER_EMAIL, role: 'owner' },
  };

  async function pendingInvitations() {
    return getTestDb()`SELECT role, status FROM invitation WHERE "organizationId" = ${org.id} AND email = ${OUTSIDER_EMAIL}`;
  }

  async function memberRole() {
    const [row] = await getTestDb()`SELECT role FROM member WHERE id = ${member.memberId}`;
    return row.role as string;
  }

  async function mcpManageEntity(args: Record<string, unknown>) {
    const response = await mcpRequest<any>(
      'tools/call',
      { name: 'manage_entity', arguments: args },
      { token: adminToken, orgSlug: org.slug }
    );
    const result = response.result as any;
    return {
      isError: result?.isError === true,
      text: (result?.content ?? []).map((c: any) => c.text ?? '').join('\n'),
    };
  }

  it('denies an owner MCP session with mcp:admin inviting an outsider as owner', async () => {
    const result = await mcpManageEntity(inviteOutsiderAsOwner);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(HUMAN_ONLY);
    expect(await pendingInvitations()).toHaveLength(0);
  });

  it('denies an owner MCP session changing a member role', async () => {
    const result = await mcpManageEntity({ action: 'update', entity_id: member.entityId, metadata: { role: 'owner' } });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(HUMAN_ONLY);
    expect(await memberRole()).toBe('member');
  });

  it('denies an owner MCP session removing a member record', async () => {
    // Seed a pending invitation through the web app, then try to revoke it.
    const invited = await post(`/api/${org.slug}/manage_entity`, { cookie: owner.cookie, body: inviteOutsiderAsOwner });
    expect(invited.status).toBe(200);
    const entityId = Number((await invited.json()).entity.id);

    const result = await mcpManageEntity({ action: 'delete', entity_id: entityId });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(HUMAN_ONLY);
    expect(await pendingInvitations()).toEqual([{ role: 'owner', status: 'pending' }]);
  });

  it('denies an mcp:admin OAuth token and a PAT over REST with a typed 403', async () => {
    const { token: pat } = await createTestPAT(owner.userId, org.id, { scope: 'mcp:read mcp:write mcp:admin' });
    for (const token of [adminToken, pat]) {
      const response = await post(`/api/${org.slug}/manage_entity`, { token, body: inviteOutsiderAsOwner });
      expect(response.status).toBe(403);
      expect(await response.text()).toMatch(HUMAN_ONLY);
      const roleChange = await post(`/api/${org.slug}/manage_entity`, {
        token,
        body: { action: 'update', entity_id: member.entityId, metadata: { role: 'admin' } },
      });
      expect(roleChange.status).toBe(403);
    }
    expect(await pendingInvitations()).toHaveLength(0);
    expect(await memberRole()).toBe('member');
  });

  it('denies run_sdk from an owner MCP session with mcp:admin', async () => {
    const result = await mcpToolsCall<{ success: boolean; error?: { message?: string } }>(
      'run_sdk',
      {
        script: `export default async (_ctx, client) => client.entities.update({ entity_id: ${member.entityId}, metadata: { role: 'owner' } });`,
      },
      { token: adminToken, orgSlug: org.slug }
    );
    expect(result.success).toBe(false);
    expect(result.error?.message ?? '').toMatch(HUMAN_ONLY);
    expect(await memberRole()).toBe('member');
  });

  it('applies an agent-proposed invitation an owner approves from the MCP App card', async () => {
    const agentCtx = {
      organizationId: org.id,
      userId: null,
      memberRole: null,
      agentId: 'member-invite-agent',
      isAuthenticated: true,
      clientId: null,
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      tokenType: 'oauth',
      scopedToOrg: true,
      allowCrossOrg: false,
    } as unknown as ToolContext;
    const { runId } = await proposeEntityCreate(agentCtx, {
      entity_data: {
        entity_type: '$member',
        name: 'Outsider',
        organization_id: org.id,
        created_by: owner.userId,
        metadata: { email: OUTSIDER_EMAIL, role: 'member' },
      },
      proposal: { entity_type: '$member', name: 'Outsider' },
      attribution: 'agent',
    });
    expect(await pendingInvitations()).toHaveLength(0);

    // The same owner, same mcp:admin OAuth connection: the capability-bound
    // card is a human decision, like any other run approval.
    const view = await mcpRequest<any>(
      'tools/call',
      { name: 'get_approval', arguments: { run_id: runId } },
      { token: adminToken, orgSlug: org.slug }
    );
    const capability = view.result?._meta?.['lobu/approval-capability'];
    expect(typeof capability).toBe('string');
    const resolved = await mcpRequest<any>(
      'tools/call',
      {
        name: 'resolve_approval',
        arguments: { run_id: runId, decision: 'approve', _meta: { 'lobu/approval-capability': capability } },
      },
      { token: adminToken, orgSlug: org.slug }
    );
    expect(resolved.result?.isError).not.toBe(true);
    expect(await pendingInvitations()).toEqual([{ role: 'member', status: 'pending' }]);

    // A direct call on that same connection is still an agent acting.
    const direct = await mcpManageEntity({
      action: 'create',
      entity_type: '$member',
      name: 'Second outsider',
      metadata: { email: 'second-outsider@human-only.example.com', role: 'owner' },
    });
    expect(direct.isError).toBe(true);
    expect(direct.text).toMatch(HUMAN_ONLY);
  });

  it('still lets an owner in the web app invite, change roles and remove', async () => {
    const invited = await post(`/api/${org.slug}/manage_entity`, { cookie: owner.cookie, body: inviteOutsiderAsOwner });
    expect(invited.status).toBe(200);
    expect(await pendingInvitations()).toEqual([{ role: 'owner', status: 'pending' }]);

    const promoted = await post(`/api/${org.slug}/manage_entity`, {
      cookie: owner.cookie,
      body: { action: 'update', entity_id: member.entityId, metadata: { role: 'admin' } },
    });
    expect(promoted.status).toBe(200);
    expect(await memberRole()).toBe('admin');

    const removed = await post(`/api/${org.slug}/manage_entity`, {
      cookie: owner.cookie,
      body: { action: 'delete', entity_id: Number((await invited.json()).entity.id) },
    });
    expect(removed.status).toBe(200);
    expect(await pendingInvitations()).toEqual([{ role: 'owner', status: 'canceled' }]);
  });
});
