/**
 * Deleting a `$member` record is how the Lobu web app removes a person from a
 * workspace (Memory, Members → Delete). The Better Auth `member` row is what
 * every request authorizes against, so the delete must remove it in the same
 * transaction; a tombstoned record over a live membership is a removed admin
 * who keeps full access.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureMemberEntity } from '../../../utils/member-entity';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestSession,
  createTestUser,
} from '../../setup/test-fixtures';
import { get, post } from '../../setup/test-helpers';

type Person = { userId: string; memberId: string; entityId: number; cookie: string };

describe('removing a $member record revokes workspace access', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let owner: Person;
  let admin: Person;
  let member: Person;

  async function person(role: 'owner' | 'admin' | 'member', name: string): Promise<Person> {
    const user = await createTestUser({ email: `${name}@removal.example.com` });
    const memberId = await addUserToOrganization(user.id, org.id, role);
    await ensureMemberEntity({ organizationId: org.id, userId: user.id, name, email: user.email, role, status: 'active' });
    const [entity] = await getTestDb()`SELECT entity_id FROM entity_identities WHERE organization_id = ${org.id} AND namespace = 'auth_user_id' AND identifier = ${user.id}`;
    const session = await createTestSession(user.id);
    return { userId: user.id, memberId, entityId: Number(entity.entity_id), cookie: session.cookieHeader };
  }

  beforeEach(async () => {
    await cleanupTestDatabase();
    org = await createTestOrganization({ name: 'Removal test', slug: 'removal-test' });
    owner = await person('owner', 'owner');
    admin = await person('admin', 'admin');
    member = await person('member', 'member');
  });

  const remove = (actor: Person, entityId: number) =>
    post(`/api/${org.slug}/manage_entity`, { cookie: actor.cookie, body: { action: 'delete', entity_id: entityId } });

  async function membership(target: Person) {
    const [row] = await getTestDb()`SELECT role FROM member WHERE id = ${target.memberId}`;
    return row?.role ?? null;
  }

  async function recordDeleted(target: Person) {
    const [row] = await getTestDb()`SELECT deleted_at IS NOT NULL AS deleted FROM entities WHERE id = ${target.entityId}`;
    return row.deleted as boolean;
  }

  it('removes an admin through the web session and the removed admin loses access at once', async () => {
    // Prove the admin is a working member before the removal.
    const before = await post(`/api/${org.slug}/manage_entity`, { cookie: admin.cookie, body: { action: 'list', entity_type: '$member' } });
    expect(before.status).toBe(200);

    const response = await remove(owner, admin.entityId);
    expect(response.status).toBe(200);

    expect(await membership(admin)).toBeNull();
    expect(await recordDeleted(admin)).toBe(true);

    // The removed admin's still-valid session no longer reaches the workspace.
    const after = await post(`/api/${org.slug}/manage_entity`, { cookie: admin.cookie, body: { action: 'list', entity_type: '$member' } });
    expect(after.status).toBe(403);

    const listed = await get(`/api/auth/organization/list-members?organizationId=${org.id}`, { cookie: owner.cookie });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { members: Array<{ userId: string }> };
    expect(body.members.map((m) => m.userId)).not.toContain(admin.userId);

    const audit = await getTestDb()`SELECT created_by, metadata->>'actor_source' AS actor_source FROM events WHERE organization_id = ${org.id} AND origin_type = 'workspace_member_deleted'`;
    expect(audit).toEqual([{ created_by: owner.userId, actor_source: 'ui' }]);
  });

  it('keeps the last owner', async () => {
    const response = await remove(owner, owner.entityId);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('The workspace must retain at least one owner');
    expect(await membership(owner)).toBe('owner');
    expect(await recordDeleted(owner)).toBe(false);
  });

  it('lets an owner remove another owner while one remains', async () => {
    const second = await person('owner', 'second-owner');
    expect((await remove(owner, second.entityId)).status).toBe(200);
    expect(await membership(second)).toBeNull();
  });

  it('serializes two owners leaving at once so one owner remains', async () => {
    const second = await person('owner', 'second-owner');
    const responses = await Promise.all([
      remove(owner, owner.entityId),
      remove(second, second.entityId),
      // A concurrent role edit takes the same workspace lock before any row.
      post(`/api/${org.slug}/manage_entity`, { cookie: owner.cookie, body: { action: 'update', entity_id: member.entityId, metadata: { role: 'admin' } } }),
    ]);
    expect(responses.slice(0, 2).map((r) => r.status).sort()).toEqual([200, 400]);
    // Never a deadlock (500): if the owner left first, the edit is refused.
    expect([200, 403]).toContain(responses[2].status);
    expect(await getTestDb()`SELECT id FROM member WHERE "organizationId" = ${org.id} AND role = 'owner'`).toHaveLength(1);
    for (const target of [owner, second]) {
      expect(await recordDeleted(target)).toBe((await membership(target)) === null);
    }
  });

  it('does not let an admin remove an owner', async () => {
    const response = await remove(admin, owner.entityId);
    expect(response.status).toBe(403);
    expect(await membership(owner)).toBe('owner');
    expect(await recordDeleted(owner)).toBe(false);
  });

  it('does not let an ordinary member remove anyone', async () => {
    // The tool tier gate refuses before the delete runs at all.
    const denied = await remove(member, admin.entityId);
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(await denied.text()).toContain('requires admin or owner access');
    expect(await membership(admin)).toBe('admin');
  });

  it('still requires a person: an mcp:admin token cannot remove a member', async () => {
    const client = await createTestOAuthClient();
    const { token } = await createTestAccessToken(owner.userId, org.id, client.client_id, {
      scope: 'mcp:read mcp:write mcp:admin profile:read',
    });
    const response = await post(`/api/${org.slug}/manage_entity`, { token, body: { action: 'delete', entity_id: admin.entityId } });
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/can only be done by a person in the Lobu web app/);
    expect(await membership(admin)).toBe('admin');
    expect(await recordDeleted(admin)).toBe(false);
  });

  it('cancels a pending invitation when its record is deleted', async () => {
    const invited = await post(`/api/${org.slug}/manage_entity`, {
      cookie: owner.cookie,
      body: { action: 'create', entity_type: '$member', name: 'Invitee', metadata: { email: 'invitee@removal.example.com', role: 'admin' } },
    });
    expect(invited.status).toBe(200);
    const entityId = Number((await invited.json()).entity.id);
    expect((await post(`/api/${org.slug}/manage_entity`, { cookie: owner.cookie, body: { action: 'delete', entity_id: entityId } })).status).toBe(200);
    const rows = await getTestDb()`SELECT status FROM invitation WHERE "organizationId" = ${org.id} AND email = 'invitee@removal.example.com'`;
    expect(rows).toEqual([{ status: 'canceled' }]);
  });

  it('keeps the displayed role in sync with access after a role change, then removes', async () => {
    const promoted = await post(`/api/${org.slug}/manage_entity`, { cookie: owner.cookie, body: { action: 'update', entity_id: member.entityId, metadata: { role: 'admin' } } });
    expect(promoted.status).toBe(200);
    expect(await membership(member)).toBe('admin');
    expect((await remove(owner, member.entityId)).status).toBe(200);
    expect(await membership(member)).toBeNull();
  });

  it('removes a member whose record is deleted as part of a force-deleted tree', async () => {
    const sql = getTestDb();
    const [parent] = await sql`
      INSERT INTO entities (organization_id, entity_type_id, name, slug, created_by)
      SELECT organization_id, entity_type_id, 'Team record', 'team-record', created_by
      FROM entities WHERE id = ${owner.entityId}
      RETURNING id
    `;
    await sql`UPDATE entities SET parent_id = ${parent.id} WHERE id = ${admin.entityId}`;
    const response = await post(`/api/${org.slug}/manage_entity`, {
      cookie: owner.cookie,
      body: { action: 'delete', entity_id: Number(parent.id), force_delete_tree: true },
    });
    expect(response.status).toBe(200);
    expect(await membership(admin)).toBeNull();
  });

  it('refuses to delete a record that is not linked to its sign-in identity while that person is a member', async () => {
    const sql = getTestDb();
    await sql`UPDATE entity_identities SET deleted_at = now() WHERE entity_id = ${admin.entityId} AND namespace = 'auth_user_id'`;
    const response = await remove(owner, admin.entityId);
    expect(response.status).toBe(409);
    expect(await membership(admin)).toBe('admin');
    expect(await recordDeleted(admin)).toBe(false);
  });

  it('rolls back the membership and the record together when the audit insert fails', async () => {
    const sql = getTestDb();
    await sql.unsafe(`CREATE FUNCTION test_reject_removal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.origin_type = 'workspace_member_deleted' THEN RAISE EXCEPTION 'removal audit test failure'; END IF; RETURN NEW; END $$`);
    await sql.unsafe('CREATE TRIGGER test_reject_removal_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION test_reject_removal_audit()');
    try {
      expect((await remove(owner, admin.entityId)).status).toBeGreaterThanOrEqual(400);
      expect(await membership(admin)).toBe('admin');
      expect(await recordDeleted(admin)).toBe(false);
    } finally {
      await sql.unsafe('DROP TRIGGER test_reject_removal_audit ON events');
      await sql.unsafe('DROP FUNCTION test_reject_removal_audit()');
    }
  });
});
