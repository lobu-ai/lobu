import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { previewMergeRetirement, applyMergeRetirement } from '../../../../../../scripts/retire-physical-merges';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEntity, createTestEvent, createTestOrganization } from '../../setup/test-fixtures';
import { pgBigintArray } from '../../../db/client';

const migration = (name: string) => readFileSync(resolve(import.meta.dirname, '../../../../../../db/migrations', name), 'utf8');
const memberGuard = (source: string) => source.slice(source.indexOf('CREATE OR REPLACE FUNCTION lobu_guard_identity_members()'), source.indexOf('CREATE OR REPLACE TRIGGER lobu_guard_identity_members'));
const historicalMigration = migration('20261007010000_identity_association_guards.sql');
const cutoverMigration = migration('20261009020000_retire_physical_entity_merge.sql');
// These maintenance fixtures model an installation BEFORE the guarded cutover.
// Restore the production guard after each case; the script runs before upgrade.
const cutoverGuard = cutoverMigration.slice(cutoverMigration.indexOf('CREATE OR REPLACE FUNCTION lobu_guard_identity_members()'), cutoverMigration.indexOf('-- migrate:down'));

async function fixture() {
  const sql = getTestDb();
  const org = await createTestOrganization();
  const winner = await createTestEntity({ name: 'Survivor', entity_type: 'synthetic-record', organization_id: org.id });
  const loser = await createTestEntity({ name: 'Obsolete', entity_type: 'synthetic-record', organization_id: org.id });
  const other = await createTestEntity({ name: 'Unrelated', entity_type: 'synthetic-record', organization_id: org.id });
  const event = await createTestEvent({ entity_id: loser.id, content: 'Preserved source content', origin_id: 'synthetic-retirement-source' });
  await sql`UPDATE events SET entity_ids = ${pgBigintArray([loser.id, winner.id, other.id])}::bigint[] WHERE id = ${event.id}`;
  await sql`UPDATE entities SET deleted_at = current_timestamp, merged_into = ${winner.id} WHERE id = ${loser.id}`;
  await sql`INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, merged_from_entity_id)
    VALUES (${org.id}, ${winner.id}, 'synthetic', 'original-source', ${loser.id})`;
  await sql`INSERT INTO entity_merge_operations (organization_id, winner_entity_id, loser_entity_id, decision, ledger, merged_by)
    VALUES (${org.id}, ${winner.id}, ${loser.id}, 'human', '{"original":"preserved"}'::jsonb, 'synthetic-operator')`;
  return { sql, org, winner, loser, other, event };
}

describe('physical merge retirement maintenance', () => {
  beforeEach(async () => { await cleanupTestDatabase(); await getTestDb()`ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_physical_merge_retired`; await getTestDb().unsafe(memberGuard(historicalMigration)); });
  afterEach(async () => {
    await cleanupTestDatabase();
    await getTestDb().unsafe(cutoverGuard);
    await getTestDb()`ALTER TABLE entities ADD CONSTRAINT entities_physical_merge_retired CHECK (merged_into IS NULL) NOT VALID`;
    await getTestDb()`ALTER TABLE entities VALIDATE CONSTRAINT entities_physical_merge_retired`;
  });

  it.each(['entities', 'runs', 'automations', 'entity_types'])('accepts a pre-column %s table during upgrade preflight', async table => {
    const sql = getTestDb();
    const marker = new Error('rollback synthetic old schema');
    const precondition = migration('preconditions/20261009020000_retire_physical_entity_merge.sql');
    await expect(sql.begin(async tx => {
      await tx.unsafe(`ALTER TABLE ${table} RENAME TO synthetic_full_${table}`);
      await tx.unsafe(`CREATE TABLE ${table} (id bigint)`);
      await tx.unsafe(precondition);
      throw marker;
    })).rejects.toBe(marker);
  });

  it('can reapply the cutover without replacing the physical-writer fence', async () => {
    const marker = new Error('rollback repeated cutover');
    const up = cutoverMigration.split('-- migrate:down')[0];
    await expect(getTestDb().begin(async tx => {
      await tx.unsafe(up);
      await tx.unsafe(up);
      const [constraint] = await tx`SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'public.entities'::regclass AND conname = 'entities_physical_merge_retired'`;
      expect(constraint.convalidated).toBe(true);
      throw marker;
    })).rejects.toBe(marker);
  });

  it('guards upgrades until redirects, decisions and current callers are retired', async () => {
    const { sql, org } = await fixture();
    const precondition = migration('preconditions/20261009020000_retire_physical_entity_merge.sql');
    await expect(sql.begin('read only', tx => tx.unsafe(precondition))).rejects.toThrow(/redirects remain/);
    await applyMergeRetirement(sql, await previewMergeRetirement(sql, org.id), async () => {});
    await sql.begin('read only', tx => tx.unsafe(precondition));
    const [run] = await sql`INSERT INTO runs (organization_id, run_type, action_key, status, approval_status, action_input)
      VALUES (${org.id}, 'internal', 'entity_change', 'cancelled', 'rejected', '{"operation":"merge"}'::jsonb) RETURNING id`;
    await expect(sql.begin('read only', tx => tx.unsafe(precondition))).rejects.toThrow(/approvals or executions remain/);
    await sql`UPDATE runs SET action_input = '{"operation":"link"}'::jsonb WHERE id = ${run.id}`;
    await sql.begin('read only', tx => tx.unsafe(precondition));
  });

  it('preserves audit ledgers when unrelated former members are hard deleted', async () => {
    const { sql, org, winner, other } = await fixture();
    await applyMergeRetirement(sql, await previewMergeRetirement(sql, org.id), async () => {});
    const [audit] = await sql`INSERT INTO entity_merge_operations
      (organization_id, winner_entity_id, loser_entity_id, decision, status, ledger, merged_by)
      VALUES (${org.id}, ${winner.id}, ${other.id}, 'human', 'undone', '{"history":"retained"}'::jsonb, 'synthetic-operator') RETURNING id`;
    await sql`DELETE FROM entities WHERE id = ${other.id}`;
    expect(await sql`SELECT ledger FROM entity_merge_operations WHERE id = ${audit.id}`).toEqual([{ ledger: { history: 'retained' } }]);
  });

  it('previews without changing records, history, provenance, or ledgers', async () => {
    const { sql, org } = await fixture();
    const before = await sql`SELECT to_jsonb(e) AS row FROM entities e ORDER BY id`;
    const manifest = await previewMergeRetirement(sql, org.id);
    expect(manifest.losers).toHaveLength(1);
    expect(manifest.survivors).toHaveLength(1);
    expect(manifest.events).toHaveLength(1);
    expect(manifest.provenance).toHaveLength(1);
    expect(manifest.ledgers).toHaveLength(1);
    expect(manifest.blockers).toEqual([]);
    expect(await sql`SELECT to_jsonb(e) AS row FROM entities e ORDER BY id`).toEqual(before);
  });

  it.each([false, true])('preserves survivors and all event bytes except canonical reference arrays (deleted survivor: %s)', async deleted => {
    const { sql, org, winner, loser, other, event } = await fixture();
    if (deleted) await sql`UPDATE entities SET deleted_at = current_timestamp WHERE id = ${winner.id}`;
    const manifest = await previewMergeRetirement(sql, org.id);
    let archived: unknown;
    await applyMergeRetirement(sql, manifest, async value => { archived = structuredClone(value); });
    expect(archived).toEqual(manifest);
    expect(await sql`SELECT id FROM entities WHERE id = ${loser.id}`).toHaveLength(0);
    const [survivor] = await sql`SELECT to_jsonb(e) AS row FROM entities e WHERE id = ${winner.id}`;
    expect(survivor.row).toEqual(JSON.parse(manifest.survivors[0].json));
    const [storedEvent] = await sql`SELECT to_jsonb(e) AS row FROM events e WHERE id = ${event.id}`;
    expect(storedEvent.row).toEqual({ ...JSON.parse(manifest.events[0].json), entity_ids: [winner.id, other.id] });
    expect((await sql`SELECT to_jsonb(i) AS row FROM entity_identities i WHERE entity_id = ${winner.id}`).map(r => r.row)).toEqual(manifest.provenance.map(row => JSON.parse(row.json)));
    expect(await sql`SELECT id FROM entity_merge_operations WHERE loser_entity_id = ${loser.id}`).toHaveLength(0);
    expect((await previewMergeRetirement(sql, org.id)).losers).toHaveLength(0);
    await expect(applyMergeRetirement(sql, manifest, async () => {})).rejects.toThrow(/stale/);
  });

  it('aborts atomically when the reviewed survivor changes', async () => {
    const { sql, org, winner, loser } = await fixture();
    const manifest = await previewMergeRetirement(sql, org.id);
    await sql`UPDATE entities SET name = 'Later edit' WHERE id = ${winner.id}`;
    await expect(applyMergeRetirement(sql, manifest, async () => { throw new Error('Must not archive stale state'); })).rejects.toThrow(/stale/);
    expect(await sql`SELECT id FROM entities WHERE id = ${loser.id}`).toHaveLength(1);
    expect(await sql`SELECT id FROM entity_merge_operations WHERE loser_entity_id = ${loser.id}`).toHaveLength(1);
  });

  it('never deletes when the archive cannot be written', async () => {
    const { sql, org, loser } = await fixture();
    const manifest = await previewMergeRetirement(sql, org.id);
    await expect(applyMergeRetirement(sql, manifest, async () => { throw new Error('Archive unavailable'); })).rejects.toThrow('Archive unavailable');
    expect(await sql`SELECT id FROM entities WHERE id = ${loser.id}`).toHaveLength(1);
    expect(await previewMergeRetirement(sql, org.id)).toEqual(manifest);
  });

  it('refuses unreviewed dependencies instead of allowing FK cascades', async () => {
    const { sql, org, loser } = await fixture();
    await sql`INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, deleted_at)
      VALUES (${org.id}, ${loser.id}, 'synthetic', 'deleted-claim', current_timestamp)`;
    const manifest = await previewMergeRetirement(sql, org.id);
    expect(manifest.blockers).toContain('entity_identities.entity_id');
    await expect(applyMergeRetirement(sql, manifest, async () => {})).rejects.toThrow(/dependencies/);
    expect(await sql`SELECT id FROM entities WHERE id = ${loser.id}`).toHaveLength(1);
  });

  it('preserves raw high-precision JSON and detects changes that JavaScript would round away', async () => {
    const { sql, org, loser } = await fixture();
    await sql`UPDATE entities SET metadata = '{"precise":9007199254740992}'::jsonb WHERE id = ${loser.id}`;
    const manifest = await previewMergeRetirement(sql, org.id);
    expect(manifest.losers[0].json).toContain('9007199254740992');
    await sql`UPDATE entities SET metadata = '{"precise":9007199254740993}'::jsonb WHERE id = ${loser.id}`;
    await expect(applyMergeRetirement(sql, manifest, async () => {})).rejects.toThrow(/stale/);
    const current = await previewMergeRetirement(sql, org.id);
    expect(current.losers[0].json).toContain('9007199254740993');
    let backup = '';
    await applyMergeRetirement(sql, current, async value => { backup = JSON.stringify(value); });
    expect(backup).toContain('9007199254740993');
  });

  it('maps every historical version without coercing unrelated bigint or null references', async () => {
    const { sql, org, winner, loser, event } = await fixture();
    const next = await createTestEvent({ entity_id: loser.id, content: 'Later preserved version', origin_id: 'synthetic-retirement-source' });
    await sql`UPDATE events SET supersedes_event_id = ${event.id} WHERE id = ${next.id}`;
    await sql`UPDATE events SET entity_ids = ARRAY[${loser.id}::bigint, 9007199254740993::bigint, NULL::bigint],
      metadata = '{"precise":9007199254740993}'::jsonb WHERE id IN (${event.id}, ${next.id})`;
    const manifest = await previewMergeRetirement(sql, org.id);
    expect(manifest.events).toHaveLength(2);
    await applyMergeRetirement(sql, manifest, async () => {});
    const rows = await sql`SELECT id, entity_ids::text AS ids, metadata::text AS metadata, supersedes_event_id
      FROM events WHERE id IN (${event.id}, ${next.id}) ORDER BY id`;
    expect(rows.every(row => row.ids === `{${winner.id},9007199254740993,NULL}`)).toBe(true);
    expect(rows.every(row => row.metadata.includes('9007199254740993'))).toBe(true);
    expect(Number(rows[1].supersedes_event_id)).toBe(event.id);
  });

  it('discovers integer foreign keys even when their column has no entity name', async () => {
    const { sql, org, loser } = await fixture();
    await sql`CREATE TABLE synthetic_retirement_fk (id integer PRIMARY KEY, record_ref integer REFERENCES entities(id) ON DELETE CASCADE)`;
    try {
      await sql`INSERT INTO synthetic_retirement_fk VALUES (1, ${loser.id})`;
      const manifest = await previewMergeRetirement(sql, org.id);
      expect(manifest.blockers).toContain('synthetic_retirement_fk.record_ref');
      await expect(applyMergeRetirement(sql, manifest, async () => {})).rejects.toThrow(/dependencies/);
      expect(await sql`SELECT id FROM synthetic_retirement_fk`).toHaveLength(1);
    } finally { await sql`DROP TABLE synthetic_retirement_fk`; }
  });

  it('can restore the original rows and event references from the lossless archive locally', async () => {
    const { sql, org, loser } = await fixture();
    await sql`UPDATE entities SET metadata = '{"precise":9007199254740993}'::jsonb WHERE id = ${loser.id}`;
    const manifest = await previewMergeRetirement(sql, org.id);
    await applyMergeRetirement(sql, manifest, async () => {});
    for (const [table, rows] of [['entities', manifest.losers], ['entity_merge_operations', manifest.ledgers]] as const) {
      const columns = await sql`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} AND is_generated = 'NEVER' ORDER BY ordinal_position`;
      const names = columns.map(row => `"${String(row.column_name).replaceAll('"', '""')}"`).join(', ');
      for (const row of rows) await sql.unsafe(`INSERT INTO ${table} (${names}) SELECT ${names}
        FROM jsonb_populate_record(NULL::${table}, $1::text::jsonb)`, [row.json]);
    }
    for (const event of manifest.events) await sql`UPDATE events SET entity_ids =
      (SELECT entity_ids FROM jsonb_populate_record(NULL::events, ${event.json}::text::jsonb)) WHERE id = ${event.id}`;
    expect(await previewMergeRetirement(sql, org.id)).toEqual(manifest);
  });
});
