import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteMemberEntity,
  ensureMemberEntity,
  updateMemberEntityAccess,
  updateMemberEntityStatus,
} from '../../../utils/member-entity';
import { provisionMemberAndCoreIdentities } from '../../../auth/subject-identities';
import { resolveMemberOrgsForUser } from '../../../identity/member-orgs';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { addUserToOrganization, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

async function memberRow(organizationId: string, email: string) {
  const sql = getTestDb();
  const rows = await sql<{
    id: number;
    metadata: Record<string, unknown>;
    deleted_at: Date | null;
  }[]>`
    SELECT e.id, e.metadata, e.deleted_at
    FROM entities e
    JOIN entity_types et
      ON et.id = e.entity_type_id
     AND et.organization_id = e.organization_id
    WHERE et.slug = '$member'
      AND e.organization_id = ${organizationId}
      AND e.metadata->>'email' = ${email}
    ORDER BY e.id
  `;
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('$member entity lifecycle projections', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('preserves unrelated metadata across status and access writes', async () => {
    const organization = await createTestOrganization({ name: 'Member projection org' });
    const user = await createTestUser({ email: 'member-projection@test.example.com' });
    await ensureMemberEntity({
      organizationId: organization.id,
      userId: user.id,
      name: 'Projection Member',
      email: user.email,
      role: 'member',
      status: 'invited',
    });

    const sql = getTestDb();
    const original = await memberRow(organization.id, user.email);
    await sql`
      UPDATE entities
      SET metadata = metadata || ${sql.json({ connector_profile: 'keep-me' })}
      WHERE id = ${original.id}
    `;

    await updateMemberEntityStatus(organization.id, user.email, 'active');
    await updateMemberEntityAccess(organization.id, user.id, { role: 'admin' });

    const updated = await memberRow(organization.id, user.email);
    expect(updated.metadata).toMatchObject({
      email: user.email,
      status: 'active',
      role: 'admin',
      connector_profile: 'keep-me',
    });
    expect(updated.deleted_at).toBeNull();
  });

  it('soft-deletes only the matching organization member', async () => {
    const first = await createTestOrganization({ name: 'Member delete first org' });
    const second = await createTestOrganization({ name: 'Member delete second org' });
    const user = await createTestUser({ email: 'shared-member@test.example.com' });

    for (const organization of [first, second]) {
      await ensureMemberEntity({
        organizationId: organization.id,
        userId: user.id,
        name: 'Shared Member',
        email: user.email,
        role: 'member',
        status: 'active',
      });
    }

    await deleteMemberEntity(first.id, user.email);

    expect((await memberRow(first.id, user.email)).deleted_at).not.toBeNull();
    expect((await memberRow(second.id, user.email)).deleted_at).toBeNull();
    const sql = getTestDb();
    const claims = await sql<{ organization_id: string; deleted_at: Date | null }>`
      SELECT organization_id, deleted_at FROM entity_identities
      WHERE namespace = 'auth_user_id' AND identifier = ${user.id}
    `;
    expect(claims).toHaveLength(2);
    expect(claims.find((row) => row.organization_id === first.id)?.deleted_at).not.toBeNull();
    expect(claims.find((row) => row.organization_id === second.id)?.deleted_at).toBeNull();
  });

  it('releases a deleted member\'s identities so the returning user resolves again', async () => {
    const organization = await createTestOrganization({ name: 'Member return org' });
    const user = await createTestUser({ email: 'returning-member@test.example.com' });
    await addUserToOrganization(user.id, organization.id, 'member');
    const subject = { userId: user.id, email: user.email, name: 'Returning Member', role: 'member' };
    const first = await provisionMemberAndCoreIdentities(organization.id, subject);

    await deleteMemberEntity(organization.id, user.email);

    const sql = getTestDb();
    const retired = await sql<{ namespace: string; deleted_at: Date | null }>`
      SELECT namespace, deleted_at FROM entity_identities
      WHERE entity_id = ${first.memberEntityId}
      ORDER BY namespace
    `;
    expect(retired.map((row) => row.namespace)).toEqual(['auth_user_id', 'email']);
    expect(retired.every((row) => row.deleted_at !== null)).toBe(true);

    // The same name again: the tombstone still holds the derived slug.
    const second = await provisionMemberAndCoreIdentities(organization.id, subject);
    expect(second.memberEntityId).not.toBe(first.memberEntityId);
    const resolved = (await resolveMemberOrgsForUser(user.id)).find(
      (org) => org.tenantOrganizationId === organization.id
    );
    expect(resolved?.memberEntityId).toBe(second.memberEntityId);
  });

  it('refuses to provision a member whose login id another entity still holds', async () => {
    const organization = await createTestOrganization({ name: 'Member stranded org' });
    const user = await createTestUser({ email: 'stranded-member@test.example.com' });
    const subject = { userId: user.id, email: user.email, name: 'Stranded Member', role: 'member' };
    const first = await provisionMemberAndCoreIdentities(organization.id, subject);

    // The state deletes left behind before they retired identities: a
    // tombstoned member still holding the live login id.
    const sql = getTestDb();
    await sql`UPDATE entities SET deleted_at = current_timestamp WHERE id = ${first.memberEntityId}`;

    await expect(
      provisionMemberAndCoreIdentities(organization.id, { ...subject, name: 'Stranded Member Again' })
    ).rejects.toThrow(/does not have a trusted login identity/);
  });

  it('rejects a login claim on the right member with an untrusted source', async () => {
    const organization = await createTestOrganization({ name: 'Member claim source org' });
    const user = await createTestUser({ email: 'claim-source@test.example.com' });
    const subject = { userId: user.id, email: user.email, name: 'Claim Source', role: 'member' };
    const first = await provisionMemberAndCoreIdentities(organization.id, subject);
    const sql = getTestDb();
    await sql`
      UPDATE entity_identities SET source_connector = 'test:untrusted'
      WHERE entity_id = ${first.memberEntityId} AND namespace = 'auth_user_id'
    `;

    await expect(provisionMemberAndCoreIdentities(organization.id, subject))
      .rejects.toThrow(/does not have a trusted login identity/);
  });
});
