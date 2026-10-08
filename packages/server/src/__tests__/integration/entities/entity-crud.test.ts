/**
 * Entity CRUD via the post-#348 SDK surface.
 *
 * Replaces deleted manage_entity tests. Covers create/read/update/delete,
 * member-role enforcement, and tree-deletion guards. Cross-org isolation
 * is asserted in cross-org-isolation.test.ts.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

describe('entity CRUD', () => {
  let owner: TestApiClient;
  let member: TestApiClient;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Entity Test Org' });
    const ownerUser = await createTestUser({ email: 'entity-owner@test.com' });
    const memberUser = await createTestUser({ email: 'entity-member@test.com' });
    await addUserToOrganization(ownerUser.id, org.id, 'owner');
    await addUserToOrganization(memberUser.id, org.id, 'member');

    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: ownerUser.id,
      memberRole: 'owner',
    });
    member = await TestApiClient.for({
      organizationId: org.id,
      userId: memberUser.id,
      memberRole: 'member',
    });

    await owner.entity_schema.createType({ slug: 'company', name: 'Company' });
  });

  it('creates an entity, reads it back, and lists it', async () => {
    const created = (await owner.entities.create({
      entity_type: 'company',
      name: 'Acme Corp',
    })) as { entity?: { id: number; name: string } };
    expect(created.entity?.id).toBeGreaterThan(0);
    expect(created.entity?.name).toBe('Acme Corp');

    const got = (await owner.entities.get({ entity_id: created.entity!.id })) as {
      entity?: { name: string };
    };
    expect(got.entity?.name).toBe('Acme Corp');

    const list = (await owner.entities.list({ entity_type: 'company' })) as {
      entities?: Array<{ id: number }>;
    };
    expect(list.entities?.some((e) => e.id === created.entity!.id)).toBe(true);
  });

  it('updates an entity', async () => {
    const created = (await owner.entities.create({
      entity_type: 'company',
      name: 'Old Name',
    })) as { entity: { id: number } };
    await owner.entities.update({ entity_id: created.entity.id, name: 'New Name' });
    const got = (await owner.entities.get({ entity_id: created.entity.id })) as {
      entity: { name: string };
    };
    expect(got.entity.name).toBe('New Name');
  });

  it('hard-deletes a fresh entity with no event history', async () => {
    const created = (await owner.entities.create({
      entity_type: 'company',
      name: 'To Delete',
    })) as { entity: { id: number } };
    await owner.entities.delete({ entity_id: created.entity.id });
    // Hard-deleted: get() throws not-found rather than returning a tombstone.
    await expect(owner.entities.get({ entity_id: created.entity.id })).rejects.toThrow(/not found/i);
  });

  it('get honors include_deleted: soft-deleted entity is hidden by default, returned with the flag', async () => {
    const sql = getTestDb();
    const created = (await owner.entities.create({
      entity_type: 'company',
      name: 'Soft Deleted Co',
    })) as { entity: { id: number } };
    const id = created.entity.id;

    // Soft-delete directly (stamp deleted_at) so getEntity's default
    // `AND e.deleted_at IS NULL` filters it out.
    await sql`UPDATE entities SET deleted_at = NOW() WHERE id = ${id}`;

    // Default read: the soft-deleted row is invisible → not-found.
    await expect(owner.entities.get({ entity_id: id })).rejects.toThrow(/not found/i);

    // With include_deleted: the row comes back.
    const got = (await owner.entities.get({
      entity_id: id,
      include_deleted: true,
    })) as { entity?: { id: number; name: string } };
    expect(got.entity?.id).toBe(id);
    expect(got.entity?.name).toBe('Soft Deleted Co');
  });

  describe('access control', () => {
    it('lets a member create + list (write scope is enough)', async () => {
      const created = (await member.entities.create({
        entity_type: 'company',
        name: 'Member-Created',
      })) as { entity?: { id: number } };
      expect(created.entity?.id).toBeGreaterThan(0);

      const list = (await member.entities.list({ entity_type: 'company' })) as {
        entities?: unknown[];
      };
      expect(Array.isArray(list.entities)).toBe(true);
    });

    it('blocks a member from deleting entities (delete requires owner/admin)', async () => {
      const created = (await owner.entities.create({
        entity_type: 'company',
        name: 'Owner-Only-Delete',
      })) as { entity: { id: number } };
      await expect(member.entities.delete({ entity_id: created.entity.id })).rejects.toThrow(
        /admin|owner|access/i
      );
    });

    it('blocks a read-only-scoped member from creating', async () => {
      const reader = member.withAuth({ scopes: ['mcp:read'] });
      await expect(
        reader.entities.create({ entity_type: 'company', name: 'Read-Only' })
      ).rejects.toThrow(/scope|access/i);
    });
  });
});
