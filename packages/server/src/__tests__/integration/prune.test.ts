/**
 * Prune — server-side gate.
 *
 * `defineConfig({ prune: true })` makes `lobu apply` delete definitions absent
 * from the config (see packages/cli/.../apply/diff.ts computeDiff({ prune })).
 * This suite verifies the destructive half the CLI depends on, against a real
 * Postgres:
 *   - definition deletes work (entity/relationship type, automation);
 *   - an entity-type / relationship-type delete REFUSES while instances exist,
 *     so prune can never cascade into data (data is exempt).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../setup/test-fixtures';
import { freshSchemaEditor, TestApiClient } from '../setup/test-mcp-client';

describe('prune (server gate)', () => {
  let owner: TestApiClient;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Prune Test Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'prune-owner@test.com' });
    userId = user.id;
    await addUserToOrganization(userId, orgId, 'owner');
    owner = await TestApiClient.for({
      organizationId: orgId,
      userId,
      memberRole: 'owner',
    });
  });

  describe('definition deletes (prune targets)', () => {
    it('deletes an entity type with no instances', async () => {
      await owner.entity_schema.createType({
        slug: 'prune-empty',
        name: 'Empty',
      });
      await freshSchemaEditor(owner.entity_schema).deleteType({ slug: 'prune-empty' });
      const got = (await owner.entity_schema.getType('prune-empty')) as {
        entity_type: unknown;
      };
      expect(got.entity_type).toBeNull();
    });

    it('refuses to delete an entity type while instances exist (data is exempt)', async () => {
      await owner.entity_schema.createType({
        slug: 'prune-busy',
        name: 'Busy',
      });
      await createTestEntity({
        name: 'A live instance',
        entity_type: 'prune-busy',
        organization_id: orgId,
      });
      await expect(freshSchemaEditor(owner.entity_schema).deleteType({ slug: 'prune-busy' })).rejects.toThrow(
        /entities of this type exist|cannot delete/i
      );
    });

    it('deletes a relationship type with no instances', async () => {
      await owner.entity_schema.createRelType({
        slug: 'prune-rel',
        name: 'Rel',
      });
      await freshSchemaEditor(owner.entity_schema).deleteRelType({ slug: 'prune-rel' });
      const list = (await owner.entity_schema.listTypes()) as {
        relationship_types?: Array<{ slug: string }>;
      };
      expect((list.relationship_types ?? []).some((r) => r.slug === 'prune-rel')).toBe(false);
    });

    it('refuses to delete a relationship type while instances exist (data is exempt)', async () => {
      const sql = getTestDb();
      await owner.entity_schema.createRelType({
        slug: 'prune-rel-busy',
        name: 'Busy Rel',
      });
      const [rt] = await sql<{ id: number }[]>`
        SELECT id FROM entity_relationship_types
        WHERE slug = ${'prune-rel-busy'} AND organization_id = ${orgId}
          AND deleted_at IS NULL
        LIMIT 1
      `;
      const a = await createTestEntity({
        name: 'Rel Source',
        entity_type: 'prune-rel-from',
        organization_id: orgId,
      });
      const b = await createTestEntity({
        name: 'Rel Target',
        entity_type: 'prune-rel-to',
        organization_id: orgId,
      });
      await sql`
        INSERT INTO entity_relationships
          (organization_id, from_entity_id, to_entity_id, relationship_type_id, created_by)
        VALUES (${orgId}, ${a.id}, ${b.id}, ${rt?.id}, ${userId})
      `;
      await expect(freshSchemaEditor(owner.entity_schema).deleteRelType({ slug: 'prune-rel-busy' })).rejects.toThrow(
        /relationships of this type exist|cannot delete/i
      );
    });

    it('a foreign public rel-type with the same slug does not block the org owning/managing its own', async () => {
      const sql = getTestDb();
      // A different org, public, with a relationship type sharing the slug.
      const other = await createTestOrganization({
        name: 'Public Other',
        visibility: 'public',
      });
      await sql`
        INSERT INTO entity_relationship_types (organization_id, slug, name, status, created_at, updated_at)
        VALUES (${other.id}, ${'shared-rel'}, 'Foreign Shared', 'active', NOW(), NOW())
      `;
      // This org can still CREATE its own same-slug type (org-scoped dup check).
      await owner.entity_schema.createRelType({
        slug: 'shared-rel',
        name: 'My Shared',
      });
      // ...and DELETE resolves THIS org's own row (tenant-first), not the
      // foreign public one (which would otherwise raise access-denied).
      await freshSchemaEditor(owner.entity_schema).deleteRelType({ slug: 'shared-rel' });
      // The foreign public row is untouched.
      const [foreign] = await sql<{ deleted_at: string | null }[]>`
        SELECT deleted_at FROM entity_relationship_types
        WHERE organization_id = ${other.id} AND slug = ${'shared-rel'}
      `;
      expect(foreign?.deleted_at).toBeNull();
    });

    it('update/delete returns the same conflict for foreign-private and absent slugs (no existence leak)', async () => {
      const sql = getTestDb();
      const other = await createTestOrganization({ name: 'Private Owner Org' });
      await sql`
        INSERT INTO entity_relationship_types (organization_id, slug, name, status, created_at, updated_at)
        VALUES (${other.id}, ${'foreign-only'}, 'Foreign Only', 'active', NOW(), NOW())
      `;
      // A caller-supplied baseline cannot reveal whether the target belongs to
      // another private org or is absent altogether.
      for (const action of ['update', 'delete'] as const) {
        const mutate = (slug: string) => owner.entity_schema.manage({
          schema_type: 'relationship_type', action, slug,
          ...(action === 'update' ? { name: 'x' } : {}),
          expected_revision: 'unseen-original-revision',
        }).catch((error: unknown) => error);
        const foreignError = await mutate('foreign-only');
        const absentError = await mutate('absent-everywhere');
        expect(foreignError).toBeInstanceOf(Error);
        expect(foreignError).toMatchObject({
          httpStatus: 409, code: 'REVISION_CONFLICT', retryable: false,
        });
        expect(absentError).toMatchObject({
          message: (foreignError as Error).message,
          httpStatus: 409, code: 'REVISION_CONFLICT', retryable: false,
        });
      }
      // Foreign row untouched.
      const [foreign] = await sql<{ deleted_at: string | null; name: string }[]>`
        SELECT deleted_at, name FROM entity_relationship_types
        WHERE organization_id = ${other.id} AND slug = ${'foreign-only'}
      `;
      expect(foreign?.deleted_at).toBeNull();
      expect(foreign?.name).toBe('Foreign Only');
    });

    it('deletes an automation', async () => {
      const agent = await createTestAgent({ organizationId: orgId });
      const created = (await owner.automations.create({
        slug: 'prune-automation',
        managed_agent_id: agent.agentId,
        prompt: 'Watch for things.',
      })) as { automation_id: string; revision: string };
      expect(created.automation_id).toBeTruthy();

      await owner.automations.delete({
        automation_ids: [created.automation_id],
        expected_revisions: { [created.automation_id]: created.revision },
      });
      const list = (await owner.automations.list({})) as {
        automations?: Array<{ slug: string }>;
      };
      expect((list.automations ?? []).some((w) => w.slug === 'prune-automation')).toBe(false);
    });

    it('re-creates a relationship type with the same slug after delete (prune → re-add)', async () => {
      // The org/slug uniqueness index is partial on `status = 'active'`, so a
      // delete that only set deleted_at left the tombstone in the index and a
      // re-create of the same slug hit a unique violation. delete now also sets
      // status='archived' to vacate the index — `lobu apply` prune then re-add
      // must round-trip.
      await owner.entity_schema.createRelType({
        slug: 'prune-readd',
        name: 'First',
      });
      await freshSchemaEditor(owner.entity_schema).deleteRelType({ slug: 'prune-readd' });
      await owner.entity_schema.createRelType({
        slug: 'prune-readd',
        name: 'Second',
      });
      const got = (await owner.entity_schema.getRelType('prune-readd')) as {
        relationship_type: { name: string; status: string } | null;
      };
      expect(got.relationship_type?.name).toBe('Second');
      expect(got.relationship_type?.status).toBe('active');
    });
  });

  describe('relationship-type inverse scoping (tenant isolation)', () => {
    it("rejects inverse_type_slug that resolves to another org's PRIVATE type and never mutates it", async () => {
      const sql = getTestDb();
      const other = await createTestOrganization({
        name: 'Private Inverse Org',
      });
      await sql`
        INSERT INTO entity_relationship_types (organization_id, slug, name, status, created_at, updated_at)
        VALUES (${other.id}, ${'foreign-private-inv'}, 'Foreign Private', 'active', NOW(), NOW())
      `;
      // A foreign PRIVATE type is invisible: referencing it as an inverse must
      // fail rather than silently linking across tenants.
      await expect(
        owner.entity_schema.createRelType({
          slug: 'mine-with-priv-inverse',
          name: 'Mine',
          inverse_type_slug: 'foreign-private-inv',
        })
      ).rejects.toThrow(/not found/i);
      // ...and the foreign row's inverse_type_id is untouched.
      const [foreign] = await sql<{ inverse_type_id: number | null }[]>`
        SELECT inverse_type_id FROM entity_relationship_types
        WHERE organization_id = ${other.id} AND slug = ${'foreign-private-inv'}
      `;
      expect(foreign?.inverse_type_id).toBeNull();
    });

    it('references a PUBLIC foreign inverse type but never writes the reciprocal back-link onto it', async () => {
      const sql = getTestDb();
      const other = await createTestOrganization({
        name: 'Public Inverse Org',
        visibility: 'public',
      });
      await sql`
        INSERT INTO entity_relationship_types (organization_id, slug, name, status, created_at, updated_at)
        VALUES (${other.id}, ${'foreign-public-inv'}, 'Foreign Public', 'active', NOW(), NOW())
      `;
      await owner.entity_schema.createRelType({
        slug: 'mine-with-pub-inverse',
        name: 'Mine',
        inverse_type_slug: 'foreign-public-inv',
      });
      // The reciprocal back-link must NOT be written onto the foreign public row
      // (only own-org inverses get the bidirectional link).
      const [foreign] = await sql<{ inverse_type_id: number | null }[]>`
        SELECT inverse_type_id FROM entity_relationship_types
        WHERE organization_id = ${other.id} AND slug = ${'foreign-public-inv'}
      `;
      expect(foreign?.inverse_type_id).toBeNull();
    });
  });
});
