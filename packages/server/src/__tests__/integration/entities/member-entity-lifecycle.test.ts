import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteMemberEntity,
  ensureMemberEntity,
  updateMemberEntityAccess,
  updateMemberEntityStatus,
} from '../../../utils/member-entity';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization, createTestUser } from '../../setup/test-fixtures';

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
  });

});
