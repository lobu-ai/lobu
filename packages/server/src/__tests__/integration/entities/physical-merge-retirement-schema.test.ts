import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEntity, createTestOrganization } from '../../setup/test-fixtures';

const firstRelease = '20261009020000_retire_physical_entity_merge.sql';
const indexRetirement = '20261009030000_retire_physical_merge_indexes.sql';
const columnRetirement = '20261009030001_drop_physical_entity_redirect.sql';
const migration = (name: string) => readFileSync(resolve(import.meta.dirname, '../../../../../../db/migrations', name), 'utf8');
const up = (name: string) => migration(name).split('-- migrate:down')[0];

async function rollbackFixture(check: (tx: DbClient) => Promise<void>) {
  const rollback = new Error('rollback synthetic upgrade fixture');
  await expect(getTestDb().begin(async tx => {
    await check(tx);
    throw rollback;
  })).rejects.toBe(rollback);
}

async function restoreFirstRelease(tx: DbClient) {
  await tx`ALTER TABLE entities ADD COLUMN merged_into bigint`;
  await tx`ALTER TABLE entities ADD CONSTRAINT entities_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES entities(id)`;
  await tx`CREATE INDEX idx_entities_merged_into ON entities (merged_into) WHERE merged_into IS NOT NULL`;
  await tx.unsafe(up(firstRelease));
}

describe('physical merge schema retirement', () => {
  beforeEach(cleanupTestDatabase);

  it('has no physical redirect storage or executor while retaining provenance and audit constraints', async () => {
    const sql = getTestDb();
    const [schema] = await sql`
      SELECT
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'entities'::regclass AND attname = 'merged_into' AND NOT attisdropped) AS redirect_column,
        to_regclass('idx_entities_merged_into') IS NOT NULL AS redirect_index,
        to_regclass('idx_merge_rejected_members') IS NOT NULL AS rejected_merge_index,
        to_regclass('entity_merge_operations_winner_created') IS NOT NULL AS winner_index,
        to_regprocedure('lobu_resolution_members(jsonb)') IS NOT NULL AS merge_members_function,
        EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'entities'::regclass AND conname IN ('entities_merged_into_fkey', 'entities_physical_merge_retired')) AS redirect_constraints,
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'entity_identities'::regclass AND attname = 'merged_from_entity_id' AND NOT attisdropped) AS provenance_column,
        to_regclass('idx_entity_identities_merged_from') IS NOT NULL AS provenance_index,
        to_regclass('entity_merge_operations_pkey') IS NOT NULL AS audit_primary_key,
        to_regclass('entity_merge_operations_one_active_loser') IS NOT NULL AS audit_uniqueness,
        to_regclass('entity_merge_operations_source_run') IS NOT NULL AS audit_source_fk_index
    `;
    expect(schema).toEqual({
      redirect_column: false, redirect_index: false, rejected_merge_index: false,
      winner_index: false, merge_members_function: false, redirect_constraints: false,
      provenance_column: true, provenance_index: true, audit_primary_key: true,
      audit_uniqueness: true, audit_source_fk_index: true,
    });
    const [guard] = await sql`SELECT prosrc FROM pg_proc WHERE oid = 'lobu_guard_identity_members()'::regprocedure`;
    expect(guard.prosrc).not.toContain('merged_into');
  });

  it.each(['entities', 'runs', 'automations', 'entity_types'])('keeps upgrade preflights compatible with a pre-column %s table', async table => {
    await rollbackFixture(async tx => {
      await tx.unsafe(`ALTER TABLE ${table} RENAME TO synthetic_full_${table}`);
      await tx.unsafe(`CREATE TABLE ${table} (id bigint)`);
      for (const file of [firstRelease, indexRetirement, columnRetirement]) {
        await tx.unsafe(migration(`preconditions/${file}`));
      }
    });
  });

  it('accepts a fresh database before the entities table exists', async () => {
    await rollbackFixture(async tx => {
      await tx`ALTER TABLE entities RENAME TO synthetic_full_entities`;
      await tx.unsafe(migration(`preconditions/${indexRetirement}`));
      await tx.unsafe(migration(`preconditions/${columnRetirement}`));
    });
  });

  it.each([indexRetirement, columnRetirement])('requires the validated first-release fence before %s', async file => {
    await rollbackFixture(async tx => {
      await tx`ALTER TABLE entities ADD COLUMN merged_into bigint`;
      await expect(tx.savepoint(save => save.unsafe(migration(`preconditions/${file}`)))).rejects.toThrow(/first physical-merge retirement release/);
      await tx`ALTER TABLE entities ADD CONSTRAINT entities_physical_merge_retired CHECK (merged_into IS NULL) NOT VALID`;
      await expect(tx.savepoint(save => save.unsafe(migration(`preconditions/${file}`)))).rejects.toThrow(/validated/);
      await tx`ALTER TABLE entities VALIDATE CONSTRAINT entities_physical_merge_retired`;
      await tx.unsafe(migration(`preconditions/${file}`));
    });
  });

  it('refuses a redirect even if a same-named unrelated check exists', async () => {
    const org = await createTestOrganization();
    const entity = await createTestEntity({ name: 'Unretired record', entity_type: 'synthetic-record', organization_id: org.id });
    await rollbackFixture(async tx => {
      await tx`ALTER TABLE entities ADD COLUMN merged_into bigint`;
      await tx`ALTER TABLE entities ADD CONSTRAINT entities_physical_merge_retired CHECK (true)`;
      await tx`UPDATE entities SET merged_into = id WHERE id = ${entity.id}`;
      await expect(tx.savepoint(save => save.unsafe(migration(`preconditions/${columnRetirement}`)))).rejects.toThrow(/redirects remain/);
    });
  });

  it('retains the historical prerequisite checks for active ledgers and rejected approvals', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization();
    const [ledger] = await sql`INSERT INTO entity_merge_operations
      (organization_id, winner_entity_id, loser_entity_id, decision, status, ledger, merged_by)
      VALUES (${org.id}, 101, 102, 'human', 'active', '{}'::jsonb, 'synthetic-operator') RETURNING id`;
    await expect(sql.begin('read only', tx => tx.unsafe(migration(`preconditions/${firstRelease}`)))).rejects.toThrow(/Active physical merge ledgers/);
    await sql`UPDATE entity_merge_operations SET status = 'undone' WHERE id = ${ledger.id}`;
    const [run] = await sql`INSERT INTO runs (organization_id, run_type, action_key, status, approval_status, action_input)
      VALUES (${org.id}, 'internal', 'entity_change', 'cancelled', 'rejected', '{"operation":"merge"}'::jsonb) RETURNING id`;
    await expect(sql.begin('read only', tx => tx.unsafe(migration(`preconditions/${firstRelease}`)))).rejects.toThrow(/approvals or executions remain/);
    await sql`UPDATE runs SET action_input = '{"operation":"link"}'::jsonb WHERE id = ${run.id}`;
    await sql.begin('read only', tx => tx.unsafe(migration(`preconditions/${firstRelease}`)));
  });

  it('preserves records, provenance, and historical ledgers across column removal and replay', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization();
    const survivor = await createTestEntity({ name: 'Retained survivor', entity_type: 'synthetic-record', organization_id: org.id });
    const former = await createTestEntity({ name: 'Former member', entity_type: 'synthetic-record', organization_id: org.id });
    await sql`INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, merged_from_entity_id)
      VALUES (${org.id}, ${survivor.id}, 'synthetic', 'historical-source', ${former.id})`;
    await sql`INSERT INTO entity_merge_operations
      (organization_id, winner_entity_id, loser_entity_id, decision, status, ledger, merged_by)
      VALUES (${org.id}, ${survivor.id}, ${former.id}, 'human', 'undone', '{"history":"retained"}'::jsonb, 'synthetic-operator')`;
    const audit = await sql`SELECT to_jsonb(a) AS row FROM entity_merge_operations a ORDER BY id`;
    const provenance = await sql`SELECT to_jsonb(i) AS row FROM entity_identities i ORDER BY id`;
    const records = await sql`SELECT to_jsonb(e) AS row FROM entities e ORDER BY id`;
    await rollbackFixture(async tx => {
      await restoreFirstRelease(tx);
      await tx.unsafe(up(columnRetirement));
      await tx.unsafe(up(columnRetirement));
      expect(await tx`SELECT to_jsonb(e) AS row FROM entities e ORDER BY id`).toEqual(records);
      expect(await tx`SELECT to_jsonb(a) AS row FROM entity_merge_operations a ORDER BY id`).toEqual(audit);
      expect(await tx`SELECT to_jsonb(i) AS row FROM entity_identities i ORDER BY id`).toEqual(provenance);
      await tx`DELETE FROM entities WHERE id = ${former.id}`;
      expect(await tx`SELECT to_jsonb(a) AS row FROM entity_merge_operations a ORDER BY id`).toEqual(audit);
      expect(await tx`SELECT to_jsonb(i) AS row FROM entity_identities i ORDER BY id`).toEqual(provenance);
    });
  });

  it('refuses unknown dependencies instead of cascading their removal', async () => {
    await rollbackFixture(async tx => {
      await restoreFirstRelease(tx);
      await tx`CREATE VIEW synthetic_redirect_reader AS SELECT merged_into FROM entities`;
      await expect(tx.savepoint(save => save.unsafe(up(columnRetirement)))).rejects.toMatchObject({ code: '2BP01' });
      expect(await tx`SELECT * FROM synthetic_redirect_reader`).toEqual([]);
      const [guard] = await tx`SELECT prosrc FROM pg_proc WHERE oid = 'lobu_guard_identity_members()'::regprocedure`;
      expect(guard.prosrc).toContain('merged_into');
    });
  });

  it('drops the redirect column over 18,001 synthetic rows without a table rewrite', async () => {
    const org = await createTestOrganization();
    const seed = await createTestEntity({ name: 'Scale seed', entity_type: 'synthetic-record', organization_id: org.id });
    await rollbackFixture(async tx => {
      await restoreFirstRelease(tx);
      await tx`INSERT INTO entities (organization_id, entity_type_id, created_by, name, slug)
        SELECT organization_id, entity_type_id, created_by, 'Scale record ' || n, 'scale-record-' || n
        FROM entities CROSS JOIN generate_series(1, 18000) n WHERE id = ${seed.id}`;
      const [before] = await tx`SELECT pg_relation_filenode('entities') AS file, count(*)::int AS rows FROM entities`;
      const started = performance.now();
      await tx.unsafe(up(columnRetirement));
      const elapsed = performance.now() - started;
      const [after] = await tx`SELECT pg_relation_filenode('entities') AS file, count(*)::int AS rows FROM entities`;
      expect(after).toEqual(before);
      expect(after.rows).toBe(18001);
      process.stdout.write(`Redirect column removal: ${elapsed.toFixed(1)}ms over ${after.rows} synthetic rows; no table rewrite\n`);
    });
  }, 60_000);
});
