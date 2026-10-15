import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEntity, createTestOrganization } from '../../setup/test-fixtures';

const retirement = '20261009015900_retire_remaining_physical_merges.sql';
const firstRelease = '20261009020000_retire_physical_entity_merge.sql';
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

/** The 21.2.1 redirect storage, without any retirement migration applied. */
async function restoreRedirectColumn(tx: DbClient) {
  await tx`ALTER TABLE entities ADD COLUMN merged_into bigint`;
  await tx`ALTER TABLE entities ADD CONSTRAINT entities_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES entities(id)`;
  await tx`CREATE INDEX idx_entities_merged_into ON entities (merged_into) WHERE merged_into IS NOT NULL`;
}

async function restoreFirstRelease(tx: DbClient) {
  await restoreRedirectColumn(tx);
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

  it.each(['entities', 'runs', 'automations', 'entity_types'])('keeps the upgrade preflight compatible with a pre-column %s table', async table => {
    await rollbackFixture(async tx => {
      await tx.unsafe(`ALTER TABLE ${table} RENAME TO synthetic_full_${table}`);
      await tx.unsafe(`CREATE TABLE ${table} (id bigint)`);
      await tx.unsafe(migration(`preconditions/${firstRelease}`));
    });
  });

  it('asserts only the two human conditions and names the SQL that lists each', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization();
    const survivor = await createTestEntity({ name: 'Survivor record', entity_type: 'synthetic-record', organization_id: org.id });
    const preflight = () => sql.begin('read only', tx => tx.unsafe(migration(`preconditions/${firstRelease}`)));
    // Redirects, active ledgers and auto_merge rules are repaired by the
    // retirement migration, so they no longer refuse the upgrade.
    await sql`INSERT INTO entity_merge_operations
      (organization_id, winner_entity_id, loser_entity_id, decision, status, ledger, merged_by)
      VALUES (${org.id}, ${survivor.id}, 102, 'human', 'active', '{}'::jsonb, 'synthetic-operator')`;
    await sql`UPDATE entity_types SET metadata_schema = '{"x-lobu-resolution":{"rules":[{"fields":["email"],"normalizer":"email","onMatch":"auto_merge"}]}}'::jsonb
      WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${survivor.id})`;
    await preflight();
    const [run] = await sql`INSERT INTO runs (organization_id, run_type, action_key, status, approval_status, action_input)
      VALUES (${org.id}, 'internal', 'entity_change', 'cancelled', 'rejected', '{"operation":"merge"}'::jsonb) RETURNING id`;
    await expect(preflight()).rejects.toThrow(/approvals or executions remain.*List them with: SELECT id, organization_id, status, approval_status/s);
    await sql`UPDATE runs SET action_input = '{"operation":"link"}'::jsonb WHERE id = ${run.id}`;
    await preflight();
    const [caller] = await sql`INSERT INTO automations (organization_id, created_by, automation_group_id, name, reaction_script)
      SELECT organization_id, created_by, 1, 'Saved caller', 'await entities.merge(a, b)' FROM entities WHERE id = ${survivor.id} RETURNING id`;
    await expect(preflight()).rejects.toThrow(/retired entity methods.*List them with: SELECT id, organization_id, name FROM automations/s);
    await sql`UPDATE automations SET reaction_script = 'await entities.link(a, b)' WHERE id = ${caller.id}`;
    await preflight();
  });

  it('retires a stored redirect onto its survivor and lets the following migrations fence and drop the column', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization();
    const survivor = await createTestEntity({ name: 'Canonical record', entity_type: 'synthetic-record', organization_id: org.id });
    const loser = await createTestEntity({ name: 'Duplicate record', entity_type: 'synthetic-record', organization_id: org.id });
    const bystander = await createTestEntity({ name: 'Unrelated record', entity_type: 'synthetic-record', organization_id: org.id });
    await sql`INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, merged_from_entity_id)
      VALUES (${org.id}, ${survivor.id}, 'synthetic', 'moved-at-merge', ${loser.id})`;
    await sql`INSERT INTO entity_merge_operations
      (organization_id, winner_entity_id, loser_entity_id, decision, status, ledger, merged_by) VALUES
      (${org.id}, ${survivor.id}, ${loser.id}, 'human', 'active', '{}'::jsonb, 'synthetic-operator'),
      (${org.id}, ${survivor.id}, ${loser.id}, 'human', 'undone', '{"history":"retained"}'::jsonb, 'synthetic-operator')`;
    await sql`INSERT INTO events (organization_id, created_by, semantic_type, origin_type, metadata, payload_data, occurred_at, entity_ids)
      SELECT ${org.id}, created_by, 'audit', 'synthetic', '{}'::jsonb, payload, now(), ids FROM entities,
        (VALUES ('{"n":1}'::jsonb, ARRAY[${loser.id}, ${bystander.id}, ${survivor.id}]::bigint[]),
                ('{"n":2}'::jsonb, ARRAY[${loser.id}]::bigint[]),
                ('{"n":3}'::jsonb, ARRAY[${survivor.id}, ${loser.id}, ${loser.id}]::bigint[])) AS seed(payload, ids)
      WHERE id = ${survivor.id}`;
    await sql`UPDATE entity_types SET metadata_schema = '{"x-lobu-resolution":{"rules":[{"fields":["email"],"normalizer":"email","onMatch":"auto_merge"}]}}'::jsonb
      WHERE id = ${(await sql`SELECT entity_type_id FROM entities WHERE id = ${survivor.id}`)[0].entity_type_id}`;
    // The server client returns bigint arrays as text; compare that form.
    const snapshot = async (tx: DbClient) => ({
      events: (await tx`SELECT entity_ids::text AS ids FROM events WHERE organization_id = ${org.id} ORDER BY (payload_data->>'n')::int`).map(row => row.ids),
      entities: (await tx`SELECT id FROM entities WHERE organization_id = ${org.id} ORDER BY id`).map(row => Number(row.id)),
      provenance: Array.from(await tx`SELECT entity_id, identifier, merged_from_entity_id FROM entity_identities WHERE organization_id = ${org.id} ORDER BY id`),
      ledgers: Array.from(await tx`SELECT status, ledger FROM entity_merge_operations ORDER BY id`),
      rules: (await tx`SELECT metadata_schema->'x-lobu-resolution'->'rules' AS rules FROM entity_types WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${survivor.id})`)[0].rules,
    });
    await rollbackFixture(async tx => {
      await restoreRedirectColumn(tx);
      await tx`UPDATE entities SET deleted_at = now(), merged_into = ${survivor.id} WHERE id = ${loser.id}`;
      const [authorizationType] = await tx`INSERT INTO entity_relationship_types
        (organization_id, slug, name, purpose)
        VALUES (${org.id}, 'synthetic-access', 'Synthetic access', 'authorization') RETURNING id`;
      await tx`SELECT set_config('lobu.acl_write', 'on', true)`;
      await tx`INSERT INTO entity_relationships
        (organization_id, from_entity_id, to_entity_id, relationship_type_id, deleted_at) VALUES
        (${org.id}, ${loser.id}, ${survivor.id}, ${authorizationType.id}, now()),
        (${org.id}, ${loser.id}, ${bystander.id}, ${authorizationType.id}, NULL)`;
      await tx`SELECT set_config('lobu.acl_write', 'off', true)`;
      // Even tombstoned ACL edges reject an unprivileged parent cascade.
      await expect(tx.savepoint(save => save`DELETE FROM entities WHERE id = ${loser.id}`)).rejects.toThrow(/authorization-bearing/);
      await tx.unsafe(up(retirement));
      expect(await tx`SELECT id FROM entity_relationships WHERE relationship_type_id = ${authorizationType.id}`).toEqual([]);
      expect((await tx`SELECT current_setting('lobu.acl_write') AS value`)[0].value).toBe('off');
      const retired = await snapshot(tx);
      expect(retired).toEqual({
        events: [`{${survivor.id},${bystander.id}}`, `{${survivor.id}}`, `{${survivor.id}}`],
        entities: [survivor.id, bystander.id],
        provenance: [{ entity_id: survivor.id, identifier: 'moved-at-merge', merged_from_entity_id: loser.id }],
        ledgers: [{ status: 'undone', ledger: { history: 'retained' } }],
        rules: [{ fields: ['email'], normalizer: 'email', onMatch: 'auto_link' }],
      });
      await tx.unsafe(up(retirement));
      expect(await snapshot(tx)).toEqual(retired);
      await tx.unsafe(up(firstRelease));
      await tx.unsafe(up(columnRetirement));
      expect(await snapshot(tx)).toEqual(retired);
      expect(await tx`SELECT 1 FROM pg_attribute WHERE attrelid = 'entities'::regclass AND attname = 'merged_into' AND NOT attisdropped`).toEqual([]);
    });
  });

  it('is a no-op once the redirect column is gone', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization();
    await createTestEntity({ name: 'Retained record', entity_type: 'synthetic-record', organization_id: org.id });
    await sql`UPDATE entity_types SET metadata_schema = '{"x-lobu-resolution":{"rules":[{"fields":["email"],"normalizer":"email","onMatch":"auto_merge"}]}}'::jsonb
      WHERE organization_id = ${org.id}`;
    const before = {
      entities: await sql`SELECT to_jsonb(e) AS row FROM entities e ORDER BY id`,
      types: await sql`SELECT to_jsonb(t) AS row FROM entity_types t ORDER BY id`,
    };
    await sql.unsafe(up(retirement));
    expect(await sql`SELECT to_jsonb(e) AS row FROM entities e ORDER BY id`).toEqual(before.entities);
    expect(await sql`SELECT to_jsonb(t) AS row FROM entity_types t ORDER BY id`).toEqual(before.types);
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
