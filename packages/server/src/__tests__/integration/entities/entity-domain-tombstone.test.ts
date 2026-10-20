/**
 * `metadata.domain` is unique per organization among LIVE entities only. A
 * tombstone must release its domain so a new entity can claim it, while a
 * live duplicate keeps failing loudly.
 */

import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  executeMigrationSection,
  loadMigrationDown,
  loadMigrationUp,
} from '../../../db/migration-loader';
import type { Env } from '../../../index';
import { createEntity, deleteEntity } from '../../../utils/entity-management';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEntity, seedOwnerContext } from '../../setup/test-fixtures';

const env = {} as Env;
const migrationsDir = fileURLToPath(new URL('../../../../../../db/migrations/', import.meta.url));
const migrationFile = '20261020120000_entities_live_metadata_domain.sql';

describe('entity domains and tombstones', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('lets a new entity claim a domain only a tombstone holds', async () => {
    const { org, user, ctx } = await seedOwnerContext({ orgName: 'Domain tombstone org' });
    const gone = await createTestEntity({
      name: 'Acme Old',
      domain: 'acme.example',
      organization_id: org.id,
    });
    await deleteEntity(gone.id, false, env, ctx);

    const created = await createEntity({
      entity_type: 'brand',
      name: 'Acme New',
      metadata: { domain: 'acme.example' },
      organization_id: org.id,
      created_by: user.id,
    });
    expect(created.metadata).toMatchObject({ domain: 'acme.example' });
    expect(created.id).not.toBe(gone.id);
    const sql = getTestDb();
    const [tombstone] = await sql`SELECT metadata, deleted_at FROM entities WHERE id = ${gone.id}`;
    expect(tombstone.metadata).toMatchObject({ domain: 'acme.example' });
    expect(tombstone.deleted_at).not.toBeNull();
  });

  it('keeps rejecting a live duplicate domain', async () => {
    const { org, user } = await seedOwnerContext({ orgName: 'Domain live org' });
    await createTestEntity({ name: 'Acme Live', domain: 'acme.example', organization_id: org.id });

    await expect(
      createEntity({
        entity_type: 'brand',
        name: 'Acme Other',
        metadata: { domain: 'acme.example' },
        organization_id: org.id,
        created_by: user.id,
      })
    ).rejects.toThrow('Entity already exists with this name or unique field');
  });

  it('retries rollback without dropping live uniqueness until domain conflicts are resolved', async () => {
    const sql = getTestDb();
    const { org, ctx } = await seedOwnerContext({ orgName: 'Domain rollback org' });
    const gone = await createTestEntity({
      name: 'Rollback Old', domain: 'rollback.example', organization_id: org.id,
    });
    await deleteEntity(gone.id, false, env, ctx);
    await createTestEntity({
      name: 'Rollback New', domain: 'rollback.example', organization_id: org.id,
    });
    const execute = (statement: string) => sql.unsafe(statement);
    const up = loadMigrationUp(migrationsDir, migrationFile);
    const down = loadMigrationDown(migrationsDir, migrationFile);

    try {
      // The first failed build leaves an INVALID old index. Retrying must fail
      // again, rather than skip that index and drop the valid live-only one.
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(executeMigrationSection(execute, down)).rejects.toMatchObject({ code: '23505' });
        const indexes = await sql`
          SELECT c.relname, i.indisvalid
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          WHERE i.indexrelid IN (
            to_regclass('public.idx_entities_metadata_domain'),
            to_regclass('public.idx_entities_live_metadata_domain')
          )
          ORDER BY c.relname
        `;
        expect(indexes).toEqual([
          { relname: 'idx_entities_live_metadata_domain', indisvalid: true },
          { relname: 'idx_entities_metadata_domain', indisvalid: false },
        ]);
      }

      await sql`UPDATE entities SET metadata = metadata - 'domain' WHERE id = ${gone.id}`;
      await executeMigrationSection(execute, down);
      await executeMigrationSection(execute, down);
      const [restored] = await sql`
        SELECT indisvalid FROM pg_index
        WHERE indexrelid = to_regclass('public.idx_entities_metadata_domain')
      `;
      expect(restored?.indisvalid).toBe(true);
      await expect(createTestEntity({
        name: 'Rollback Duplicate', domain: 'rollback.example', organization_id: org.id,
      })).rejects.toMatchObject({ code: '23505' });
    } finally {
      await executeMigrationSection(execute, up);
      await executeMigrationSection(execute, up);
    }
  });
});
