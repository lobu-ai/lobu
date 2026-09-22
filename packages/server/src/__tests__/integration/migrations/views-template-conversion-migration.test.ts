/**
 * The conversion half of the views cutover (`20260917000000_views.sql`).
 *
 * The migration drops `view_template_versions` in the same transaction that
 * converts it, so a row that fails to land is authored content destroyed with
 * no backup path inside the deploy. The cases below pin the two ways the
 * derived key can lose a row:
 *
 *  - Two different source rows that NORMALIZE to the same key. Resource ids are
 *    free text (`Acme Corp`, `acme/corp`, `ACME-CORP` all fold to `acme-corp`),
 *    and the versioned-key suffix folds a second set together, so collisions
 *    are the ordinary case for any org that named two resources similarly.
 *  - A key long enough that truncation collides. `LEFT(key, 64 - len(suffix))
 *    || suffix` can reproduce ANOTHER candidate's key exactly, so a suffix
 *    meant to disambiguate is itself a collision source.
 *
 * `ON CONFLICT DO NOTHING` turns either into a silent row loss. Every case here
 * asserts on the SOURCE row count: N template versions in must be N views rows
 * out, with distinct keys, before the source table is dropped.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import {
  executeMigrationSection,
  loadMigrationDown,
  loadMigrationUp,
  type MigrationSection,
} from '../../../db/migration-loader';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

const VIEWS_MIGRATION = '20260917000000_views.sql';
/** The views table CHECK: lowercase alnum + dashes, 1-64 chars. */
const VIEW_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function resolveMigrationsDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'db/migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate db/migrations from the test directory');
}

async function executeSection(section: MigrationSection): Promise<void> {
  await executeMigrationSection(
    (statement) => getDb().unsafe(statement),
    section
  );
}

/**
 * Recreate the retired template schema so `up` has a source table to convert.
 * The `down` section of the migration under test is exactly that DDL, which
 * keeps this harness honest: it cannot drift from what the migration expects.
 */
async function seedTemplateSchema(down: MigrationSection): Promise<void> {
  await executeSection(down);
}

async function seedVersion(opts: {
  orgId: string;
  resourceType: 'entity_type' | 'entity';
  resourceId: string;
  version: number;
  tabName?: string | null;
  jsonTemplate?: Record<string, unknown>;
}): Promise<string> {
  const sql = getDb();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO view_template_versions
      (resource_type, resource_id, organization_id, version, tab_name,
       json_template, created_by)
    VALUES (${opts.resourceType}, ${opts.resourceId}, ${opts.orgId},
            ${opts.version}, ${opts.tabName ?? null},
            ${sql.json(opts.jsonTemplate ?? { blocks: [] })}, 'seed-user')
    RETURNING id::text AS id
  `;
  return rows[0].id;
}

async function viewKeys(orgId: string): Promise<string[]> {
  const sql = getDb();
  const rows = await sql<{ key: string }[]>`
    SELECT key FROM views WHERE organization_id = ${orgId} ORDER BY key ASC
  `;
  return rows.map((r) => r.key);
}

async function sourceCount(orgId: string): Promise<number> {
  const sql = getDb();
  const rows = await sql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM view_template_versions
    WHERE organization_id = ${orgId}
  `;
  return Number(rows[0].n);
}

describe('views template-conversion migration', () => {
  let up: MigrationSection;
  let down: MigrationSection;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    const dir = resolveMigrationsDir();
    up = loadMigrationUp(dir, VIEWS_MIGRATION);
    down = loadMigrationDown(dir, VIEWS_MIGRATION);
  });

  /**
   * Leave the schema exactly as the suite found it.
   *
   * Cycling this migration's `down` DROPS `public.views`, and that takes the
   * follow-up migration's `idx_views_attach` GIN index with it — the index is
   * created by `20260917000001`, which is NOT replayed here. Every suite in
   * this run shares one database, so stopping after the final `down` would
   * leave the next suite a `views` table with a missing index (and an
   * already-migrated ledger that will never rebuild it), which surfaces as an
   * unrelated `42P07` somewhere else entirely.
   */
  afterAll(async () => {
    await executeSection(up);
    const sql = getDb();
    await sql.unsafe(
      'CREATE INDEX IF NOT EXISTS idx_views_attach ON public.views USING gin (attach)'
    );
    await cleanupTestDatabase();
  });

  beforeEach(async () => {
    // Every case starts from the pre-cutover schema: template tables present,
    // `views` absent. `down` restores exactly that.
    await seedTemplateSchema(down);
  });

  it('converts every row when two resource ids normalize to one key', async () => {
    const org = await createTestOrganization({ name: 'Views normalize' });
    // Three distinct resources, one normalized key: `...-acme-corp`.
    for (const resourceId of ['Acme Corp', 'acme/corp', 'ACME...CORP']) {
      await seedVersion({
        orgId: org.id,
        resourceType: 'entity_type',
        resourceId,
        version: 1,
      });
    }
    const before = await sourceCount(org.id);
    expect(before).toBe(3);

    await executeSection(up);

    const keys = await viewKeys(org.id);
    // No row may be dropped: conversion is the only copy, the source table is
    // dropped in the same transaction.
    expect(keys).toHaveLength(before);
    expect(new Set(keys).size).toBe(before);
    for (const key of keys) expect(key).toMatch(VIEW_KEY_RE);
  });

  it('converts every row when a generated suffix collides with a real key', async () => {
    const org = await createTestOrganization({ name: 'Views suffix collide' });
    // The load-bearing case. The disambiguating suffix is generated by a
    // window function partitioned on the NORMALIZED key, so it cannot see a
    // candidate sitting in a different partition whose own key already equals
    // the suffixed one:
    //   'deal'      -> partition 'default-entity-type-deal',      rn 1 -> ...-deal
    //   'deal!'     -> partition 'default-entity-type-deal',      rn 2 -> ...-deal-dup2
    //   'deal-dup2' -> partition 'default-entity-type-deal-dup2', rn 1 -> ...-deal-dup2
    // The last two are the SAME key from different partitions, so the suffix
    // meant to disambiguate is itself the collision. With ON CONFLICT DO
    // NOTHING one of those rows is silently dropped, and the source table is
    // dropped in the same transaction, so that content is gone.
    const ids = ['deal', 'deal!', 'deal-dup2', 'deal?'];
    for (const resourceId of ids) {
      await seedVersion({
        orgId: org.id,
        resourceType: 'entity_type',
        resourceId,
        version: 1,
      });
    }
    const before = await sourceCount(org.id);
    expect(before).toBe(ids.length);

    await executeSection(up);

    const keys = await viewKeys(org.id);
    expect(keys).toHaveLength(before);
    expect(new Set(keys).size).toBe(before);
    for (const key of keys) expect(key).toMatch(VIEW_KEY_RE);
  });

  it('converts every row when truncation folds long keys together', async () => {
    const org = await createTestOrganization({ name: 'Views truncate' });
    // Keys longer than the 64-char grammar are truncated, so ids that differ
    // only past the cut arrive as one key — and the suffix is appended to an
    // already-truncated base, shortening it further.
    const long = 'a'.repeat(60);
    const ids = [`${long}-one`, `${long}-two`, `${long}-three`, `${long}-four`];
    for (const resourceId of ids) {
      await seedVersion({
        orgId: org.id,
        resourceType: 'entity_type',
        resourceId,
        version: 1,
      });
    }
    const before = await sourceCount(org.id);

    await executeSection(up);

    const keys = await viewKeys(org.id);
    expect(keys).toHaveLength(before);
    expect(new Set(keys).size).toBe(before);
    for (const key of keys) expect(key).toMatch(VIEW_KEY_RE);
  });

  it('converts every version of one resource, active and superseded alike', async () => {
    const org = await createTestOrganization({ name: 'Views versions' });
    for (const version of [1, 2, 3]) {
      await seedVersion({
        orgId: org.id,
        resourceType: 'entity_type',
        resourceId: 'deal',
        version,
      });
    }
    // A superseded version whose `-v<n>` key normalizes onto another row's
    // plain key: `deal-v2` as a resource id collides with version 2's key.
    await seedVersion({
      orgId: org.id,
      resourceType: 'entity_type',
      resourceId: 'deal-v2',
      version: 1,
    });
    const before = await sourceCount(org.id);

    await executeSection(up);

    const keys = await viewKeys(org.id);
    expect(keys).toHaveLength(before);
    expect(new Set(keys).size).toBe(before);
  });

  it('preserves each row\'s own template payload, not just its key', async () => {
    const org = await createTestOrganization({ name: 'Views payload' });
    await seedVersion({
      orgId: org.id,
      resourceType: 'entity_type',
      resourceId: 'Acme Corp',
      version: 1,
      jsonTemplate: { marker: 'first-row' },
    });
    await seedVersion({
      orgId: org.id,
      resourceType: 'entity_type',
      resourceId: 'acme/corp',
      version: 1,
      jsonTemplate: { marker: 'second-row' },
    });

    await executeSection(up);

    const sql = getDb();
    const rows = await sql<{ source_code: string }[]>`
      SELECT source_code FROM views WHERE organization_id = ${org.id}
    `;
    const sources = rows.map((r) => r.source_code).join('\n');
    // Both payloads survive: a collision that kept one key but dropped the
    // other row's content would still lose authored work.
    expect(sources).toContain('first-row');
    expect(sources).toContain('second-row');
  });

  it('keeps distinct orgs independent', async () => {
    const a = await createTestOrganization({ name: 'Views org a' });
    const b = await createTestOrganization({ name: 'Views org b' });
    await seedVersion({
      orgId: a.id,
      resourceType: 'entity_type',
      resourceId: 'shared',
      version: 1,
    });
    await seedVersion({
      orgId: b.id,
      resourceType: 'entity_type',
      resourceId: 'shared',
      version: 1,
    });

    await executeSection(up);

    expect(await viewKeys(a.id)).toHaveLength(1);
    expect(await viewKeys(b.id)).toHaveLength(1);
  });

  it('skips conversion when the source tables are already gone', async () => {
    // Replay after a completed cutover: no source table, no conversion, and
    // the `views` table still ends up present and empty rather than erroring.
    const org = await createTestOrganization({ name: 'Views replay' });
    await executeSection(up);
    const first = await viewKeys(org.id);

    await executeSection(up);

    expect(await viewKeys(org.id)).toEqual(first);
  });
});
