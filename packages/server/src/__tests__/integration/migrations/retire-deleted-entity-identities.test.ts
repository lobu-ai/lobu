import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { unvalidatedEntityRowPatch } from '../../../authz/entity-row-validation';
import { patchEntityRows } from '../../../utils/entity-management';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEntity, createTestOrganization } from '../../setup/test-fixtures';

const migration = readFileSync(
  new URL('../../../../../../db/migrations/20261019120000_retire_identities_of_deleted_entities.sql', import.meta.url),
  'utf8'
).split('-- migrate:down')[0]!;

describe('retiring identities of deleted entities', () => {
  beforeEach(cleanupTestDatabase);

  it('retires only live claims of deleted entities and is idempotent', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Identity cleanup' });
    const deleted = await createTestEntity({ name: 'Deleted record', organization_id: org.id });
    const live = await createTestEntity({ name: 'Live record', organization_id: org.id });
    const deletedAt = new Date('2026-01-02T00:00:00Z');
    const retiredAt = new Date('2026-01-01T00:00:00Z');
    await sql`UPDATE entities SET deleted_at = ${deletedAt} WHERE id = ${deleted.id}`;
    await sql`
      INSERT INTO entity_identities
        (organization_id, entity_id, namespace, identifier, scope_key, deleted_at)
      VALUES
        (${org.id}, ${deleted.id}, 'test_id', 'shared', NULL, NULL),
        (${org.id}, ${deleted.id}, 'test_id', 'scoped', 'test:tenant', NULL),
        (${org.id}, ${deleted.id}, 'test_id', 'retired', NULL, ${retiredAt}),
        (${org.id}, ${live.id}, 'test_id', 'live', NULL, NULL)
    `;

    await sql.unsafe(migration);
    const first = await sql`
      SELECT entity_id, identifier, scope_key, deleted_at, updated_at
      FROM entity_identities WHERE organization_id = ${org.id} ORDER BY identifier
    `;
    expect(first).toHaveLength(4);
    expect(first.find((row) => row.identifier === 'shared')).toMatchObject({
      entity_id: deleted.id, deleted_at: deletedAt,
    });
    expect(first.find((row) => row.identifier === 'scoped')).toMatchObject({
      entity_id: deleted.id, scope_key: 'test:tenant', deleted_at: deletedAt,
    });
    expect(first.find((row) => row.identifier === 'retired')?.deleted_at).toEqual(retiredAt);
    expect(first.find((row) => row.identifier === 'live')?.deleted_at).toBeNull();

    await sql.unsafe(migration);
    const second = await sql`
      SELECT entity_id, identifier, scope_key, deleted_at, updated_at
      FROM entity_identities WHERE organization_id = ${org.id} ORDER BY identifier
    `;
    expect(second).toEqual(first);
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
      VALUES (${org.id}, ${live.id}, 'test_id', 'shared')
    `;
  });

  it('rolls back entity and scoped identity tombstones together', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Identity rollback' });
    const entity = await createTestEntity({ name: 'Rollback record', organization_id: org.id });
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, scope_key)
      VALUES (${org.id}, ${entity.id}, 'test_id', 'rollback', 'test:tenant')
    `;

    await expect(sql.begin(async (tx) => {
      await patchEntityRows({
        tx,
        ids: [entity.id],
        patch: unvalidatedEntityRowPatch({
          patch: { softDelete: true },
          reason: 'test entity and identity rollback',
        }),
      });
      const [claim] = await tx`SELECT deleted_at FROM entity_identities WHERE entity_id = ${entity.id}`;
      expect(claim.deleted_at).not.toBeNull();
      throw new Error('rollback sentinel');
    })).rejects.toThrow('rollback sentinel');

    const [entityRow] = await sql`SELECT deleted_at FROM entities WHERE id = ${entity.id}`;
    const [identity] = await sql`SELECT deleted_at FROM entity_identities WHERE entity_id = ${entity.id}`;
    expect(entityRow.deleted_at).toBeNull();
    expect(identity.deleted_at).toBeNull();
  });
});
