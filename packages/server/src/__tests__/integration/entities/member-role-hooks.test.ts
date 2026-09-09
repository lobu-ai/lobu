import { createAuth } from '../../../auth';
import { readFileSync } from 'node:fs';
import { applyEntityFieldChangeProposal } from '../../../tools/admin/entity-field-approval';
import { TestApiClient } from '../../setup/test-mcp-client';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureMemberEntity } from '../../../utils/member-entity';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { addUserToOrganization, createTestAccessToken, createTestOAuthClient, createTestOrganization, createTestSession, createTestUser } from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

describe('member roles through generic entity edits', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let owner: { userId: string; memberId: string; entityId: number; cookie: string };
  let member: typeof owner;
  async function person(role: 'owner' | 'admin' | 'member', name: string) {
    const user = await createTestUser({ email: `${name}@roles.example.com` });
    const memberId = await addUserToOrganization(user.id, org.id, role);
    await ensureMemberEntity({ organizationId: org.id, userId: user.id, name, email: user.email, role, status: 'active' });
    const sql = getTestDb();
    const [entity] = await sql`SELECT entity_id FROM entity_identities WHERE organization_id = ${org.id} AND namespace = 'auth_user_id' AND identifier = ${user.id}`;
    return { userId: user.id, memberId, entityId: Number(entity.entity_id), cookie: (await createTestSession(user.id)).cookieHeader };
  }
  beforeEach(async () => {
    await cleanupTestDatabase();
    org = await createTestOrganization({ name: 'Role hook test' });
    owner = await person('owner', 'owner');
    member = await person('member', 'member');
  });
  async function edit(actor: typeof owner, entityId: number, role: unknown) {
    return post(`/api/${org.slug}/manage_entity`, { cookie: actor.cookie, body: { action: 'update', entity_id: entityId, metadata: { role } } });
  }
  async function roles(target: typeof owner) {
    const sql = getTestDb();
    const [row] = await sql`SELECT m.role, e.metadata->>'role' AS displayed FROM member m, entities e WHERE m.id = ${target.memberId} AND e.id = ${target.entityId}`;
    return row;
  }
  it('renders the role as an enum in new and existing schemas', async () => {
    const sql = getTestDb();
    await sql`UPDATE entity_types SET metadata_schema = jsonb_set(metadata_schema, '{properties,role}', '{"type":"string"}') WHERE organization_id = ${org.id} AND slug = '$member'`;
    await ensureMemberEntityType(org.id);
    const [row] = await sql`SELECT metadata_schema FROM entity_types WHERE organization_id = ${org.id} AND slug = '$member'`;
    expect(row.metadata_schema.properties.role.enum).toEqual(['owner', 'admin', 'member']);
  });
  it('promotes and demotes actual access through the generic form endpoint', async () => {
    expect((await edit(owner, member.entityId, 'admin')).status).toBe(200);
    expect(await roles(member)).toMatchObject({ role: 'admin', displayed: 'admin' });
    expect((await edit(owner, member.entityId, 'member')).status).toBe(200);
    expect(await roles(member)).toMatchObject({ role: 'member', displayed: 'member' });
  });
  it('rejects self promotion, invalid roles, and last owner demotion without changing metadata', async () => {
    expect((await edit(member, member.entityId, 'admin')).status).toBeGreaterThanOrEqual(400);
    expect((await edit(owner, member.entityId, 'superadmin')).status).toBeGreaterThanOrEqual(400);
    expect((await edit(owner, owner.entityId, 'member')).status).toBeGreaterThanOrEqual(400);
    expect(await roles(owner)).toMatchObject({ role: 'owner', displayed: 'owner' });
    expect(await roles(member)).toMatchObject({ role: 'member', displayed: 'member' });
  });
  it('honors selected invitation roles and later edits', async () => {
    const response = await post(`/api/${org.slug}/manage_entity`, { cookie: owner.cookie, body: { action: 'create', entity_type: '$member', name: 'Invited', metadata: { email: 'invited@roles.example.com', role: 'admin' } } });
    expect(response.status).toBe(200);
    const body = await response.json();
    const sql = getTestDb();
    const pending = async () => (await sql`SELECT role FROM invitation WHERE "organizationId" = ${org.id} AND email = 'invited@roles.example.com' AND status = 'pending'`)[0].role;
    expect(await pending()).toBe('admin');
    expect((await edit(owner, Number(body.entity.id), 'member')).status).toBe(200);
    expect(await pending()).toBe('member');
  });
  it('keeps the existing auth API and displayed role consistent', async () => {
    const response = await post('/api/auth/organization/update-member-role', { cookie: owner.cookie, body: { organizationId: org.id, memberId: member.memberId, role: 'admin' } });
    expect(response.status).toBe(200);
    expect(await roles(member)).toMatchObject({ role: 'admin', displayed: 'admin' });
  });
  it('enforces ownership restrictions for admins', async () => {
    const admin = await person('admin', 'admin');
    expect((await edit(admin, member.entityId, 'admin')).status).toBe(200);
    expect((await edit(admin, member.entityId, 'owner')).status).toBe(403);
    expect((await edit(admin, owner.entityId, 'admin')).status).toBe(403);
  });
  it('serializes simultaneous owner demotions across entity and auth endpoints', async () => {
    const otherOwner = await person('owner', 'other-owner');
    const responses = await Promise.all([
      edit(owner, owner.entityId, 'member'),
      post('/api/auth/organization/update-member-role', { cookie: otherOwner.cookie, body: { organizationId: org.id, memberId: otherOwner.memberId, role: 'member' } }),
    ]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 400]);
    const sql = getTestDb();
    expect(await sql`SELECT id FROM member WHERE "organizationId" = ${org.id} AND role = 'owner'`).toHaveLength(1);
    for (const target of [owner, otherOwner]) {
      const row = await roles(target);
      expect(row.displayed).toBe(row.role);
    }
  });
  it('does not let an edited email retarget a role change', async () => {
    const result = await post(`/api/${org.slug}/manage_entity`, { cookie: owner.cookie, body: { action: 'update', entity_id: member.entityId, metadata: { email: 'owner@roles.example.com', role: 'admin' } } });
    expect(result.status).toBe(400);
    expect(await roles(owner)).toMatchObject({ role: 'owner', displayed: 'owner' });
    expect(await roles(member)).toMatchObject({ role: 'member', displayed: 'member' });
  });
  it('rejects cross-workspace targets through both entrypoints', async () => {
    const foreign = await createTestOrganization({ name: 'Foreign role org' });
    const response = await post('/api/auth/organization/update-member-role', { cookie: owner.cookie, body: { organizationId: foreign.id, memberId: member.memberId, role: 'admin' } });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await post(`/api/${foreign.slug}/manage_entity`, { cookie: owner.cookie, body: { action: 'update', entity_id: member.entityId, metadata: { role: 'admin' } } })).status).toBeGreaterThanOrEqual(400);
    expect(await roles(member)).toMatchObject({ role: 'member', displayed: 'member' });
  });
  it('applies approved role edits through the same lifecycle', async () => {
    await applyEntityFieldChangeProposal({ entity_id: member.entityId, fields: { role: 'admin' }, current: { role: 'member' } }, owner.userId);
    expect(await roles(member)).toMatchObject({ role: 'admin', displayed: 'admin' });
  });
  it('updates roles through the SDK', async () => {
    const client = await TestApiClient.for({ organizationId: org.id, userId: owner.userId, memberRole: 'owner' });
    await client.entities.update({ entity_id: member.entityId, metadata: { role: 'admin' } });
    expect(await roles(member)).toMatchObject({ role: 'admin', displayed: 'admin' });
  });
  it('rolls back permission and metadata when the audit insert fails', async () => {
    const sql = getTestDb();
    await sql.unsafe(`CREATE FUNCTION test_reject_role_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.origin_type = 'workspace_member_updated' THEN RAISE EXCEPTION 'role audit test failure'; END IF; RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER test_reject_role_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION test_reject_role_audit()`);
    try {
      expect((await edit(owner, member.entityId, 'admin')).status).toBeGreaterThanOrEqual(400);
      expect(await roles(member)).toMatchObject({ role: 'member', displayed: 'member' });
      const response = await post('/api/auth/organization/update-member-role', { cookie: owner.cookie, body: { organizationId: org.id, memberId: member.memberId, role: 'admin' } });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await roles(member)).toMatchObject({ role: 'member', displayed: 'member' });
    } finally {
      await sql.unsafe('DROP TRIGGER test_reject_role_audit ON events');
      await sql.unsafe('DROP FUNCTION test_reject_role_audit()');
    }
  });
  it('reconciles old display-only roles from auth during migration', async () => {
    const sql = getTestDb();
    await sql`UPDATE entities SET metadata = metadata || '{"role":"admin"}'::jsonb WHERE id = ${member.entityId}`;
    const migration = readFileSync('../../db/migrations/20260909143000_member_permission_roles.sql', 'utf8').split('-- migrate:down')[0];
    await sql.unsafe(migration);
    expect(await roles(member)).toMatchObject({ role: 'member', displayed: 'member' });
  });

  it('requires admin scope even when the token belongs to an owner', async () => {
    const client = await createTestOAuthClient();
    const { token } = await createTestAccessToken(owner.userId, org.id, client.client_id, { scope: 'mcp:write profile:read' });
    const response = await post(`/api/${org.slug}/manage_entity`, { token, body: { action: 'update', entity_id: member.entityId, metadata: { role: 'admin' } } });
    expect(response.status).toBe(403);
    expect(await roles(member)).toMatchObject({ role: 'member', displayed: 'member' });
  });
  it('accepts an invitation with the edited role', async () => {
    const invited = await createTestUser({ email: 'accept@roles.example.com' });
    const response = await post(`/api/${org.slug}/manage_entity`, { cookie: owner.cookie, body: { action: 'create', entity_type: '$member', name: 'Accept', metadata: { email: invited.email } } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect((await edit(owner, Number(body.entity.id), 'admin')).status).toBe(200);
    const sql = getTestDb();
    const [invitation] = await sql`SELECT id FROM invitation WHERE "organizationId" = ${org.id} AND email = ${invited.email} AND status = 'pending'`;
    const accepted = await post('/api/auth/organization/accept-invitation', { cookie: (await createTestSession(invited.id)).cookieHeader, body: { invitationId: invitation.id } });
    expect(accepted.status).toBe(200);
    const [membership] = await sql`SELECT role FROM member WHERE "organizationId" = ${org.id} AND "userId" = ${invited.id}`;
    expect(membership.role).toBe('admin');
  });

  it('preserves email-only profile edits and targets later role changes by auth identity', async () => {
    const response = await post(`/api/${org.slug}/manage_entity`, { cookie: owner.cookie, body: { action: 'update', entity_id: member.entityId, metadata: { email: 'corrected@roles.example.com' } } });
    expect(response.status).toBe(200);
    const changed = await post('/api/auth/organization/update-member-role', { cookie: owner.cookie, body: { organizationId: org.id, memberId: member.memberId, role: 'admin' } });
    expect(changed.status).toBe(200);
    expect(await roles(member)).toMatchObject({ role: 'admin', displayed: 'admin' });
  });
  it('rejects untrusted origins on the existing auth endpoint', async () => {
    const auth = await createAuth({ ENVIRONMENT: 'test', BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only' });
    const context = await auth.$context;
    // Better Auth disables Origin checks under NODE_ENV=test. Exercise the
    // production check explicitly instead of asserting against that bypass.
    const previous = context.skipOriginCheck;
    context.skipOriginCheck = false;
    try {
      const response = await post('/api/auth/organization/update-member-role', { cookie: owner.cookie, headers: { Origin: 'https://untrusted.roles.example.com' }, body: { organizationId: org.id, memberId: member.memberId, role: 'admin' } });
      expect(response.status).toBe(403);
      expect(await roles(member)).toMatchObject({ role: 'member', displayed: 'member' });
    } finally {
      context.skipOriginCheck = previous;
    }
  });
  it('can edit an expired pending invitation without renewing its expiry', async () => {
    const response = await post(`/api/${org.slug}/manage_entity`, { cookie: owner.cookie, body: { action: 'create', entity_type: '$member', name: 'Expired', metadata: { email: 'expired@roles.example.com' } } });
    expect(response.status).toBe(200);
    const body = await response.json();
    const sql = getTestDb();
    await sql`UPDATE invitation SET "expiresAt" = now() - interval '1 day' WHERE "organizationId" = ${org.id} AND email = 'expired@roles.example.com'`;
    expect((await edit(owner, Number(body.entity.id), 'admin')).status).toBe(200);
    const [row] = await sql`SELECT role, "expiresAt" < now() AS expired FROM invitation WHERE "organizationId" = ${org.id} AND email = 'expired@roles.example.com'`;
    expect(row).toMatchObject({ role: 'admin', expired: true });
  });
  it('requires admin scope for invitations and records API attribution', async () => {
    const client = await createTestOAuthClient();
    const { token: writeToken } = await createTestAccessToken(owner.userId, org.id, client.client_id, { scope: 'mcp:write profile:read' });
    const { token: adminToken } = await createTestAccessToken(owner.userId, org.id, client.client_id, { scope: 'mcp:admin profile:read' });
    const body = { action: 'create', entity_type: '$member', name: 'API invited', metadata: { email: 'api@roles.example.com', role: 'admin' } };
    expect((await post(`/api/${org.slug}/manage_entity`, { token: writeToken, body })).status).toBe(403);
    expect((await post(`/api/${org.slug}/manage_entity`, { token: adminToken, body })).status).toBe(200);
    expect((await post(`/api/${org.slug}/manage_entity`, { token: adminToken, body: { action: 'update', entity_id: member.entityId, metadata: { role: 'admin' } } })).status).toBe(200);
    const sql = getTestDb();
    const rows = await sql`SELECT metadata->>'actor_source' AS actor_source, created_by FROM events WHERE organization_id = ${org.id} AND origin_type IN ('workspace_member_updated', 'workspace_invitation_created')`;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ actor_source: 'api', created_by: owner.userId });
  });

});
