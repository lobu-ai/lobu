/**
 * 20260928120000 strips the retired label vectors (`embedding`,
 * `embedding_model`) from every classifier value and nothing else. The suite's
 * own migration run happens before any data exists, so these tests seed the
 * pre-migration shape and run the real statement out of the migration file.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { executeMigrationSection, loadMigrationUp } from '../../../db/migration-loader';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

const MIGRATION = '20260928120000_classification_consolidation.sql';

function resolveMigrationsDir(): string {
  let dir = __dirname;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, 'db/migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate db/migrations from the test directory');
}

async function seed(organizationId: string, slug: string, values: unknown): Promise<number> {
  const sql = getTestDb();
  const [row] = (await sql`
    INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status, created_by, attribute_values)
    VALUES (${organizationId}, ${slug}, ${slug}, ${slug}, 'active', 'system', ${sql.json(values as never)})
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function attributeValues(id: number): Promise<unknown> {
  const sql = getTestDb();
  const [row] = (await sql`
    SELECT attribute_values FROM classify_facet WHERE id = ${id}
  `) as unknown as Array<{ attribute_values: unknown }>;
  return row.attribute_values;
}

describe('classification consolidation migration', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('strips label vectors and keeps every other key', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Strip Org' });
    const withVectors = await seed(org.id, 'sentiment', {
      positive: {
        description: 'Positive',
        examples: ['great'],
        embedding: [0.1, 0.2],
        embedding_model: 'synthetic-model',
      },
      negative: { description: 'Negative', examples: ['awful'], embedding: [0.3, 0.4] },
      child: { description: 'Child', examples: [], parent: { sentiment: 'positive' } },
      scalar: 'plain entry',
    });
    const clean = await seed(org.id, 'clean', { a: { description: 'A', examples: ['x'] } });
    const arrayRoot = await seed(org.id, 'legacy-array', [{ embedding: [0.5] }]);

    const up = loadMigrationUp(resolveMigrationsDir(), MIGRATION);
    await executeMigrationSection((statement) => sql.unsafe(statement), up);

    expect(await attributeValues(withVectors)).toEqual({
      positive: { description: 'Positive', examples: ['great'] },
      negative: { description: 'Negative', examples: ['awful'] },
      child: { description: 'Child', examples: [], parent: { sentiment: 'positive' } },
      scalar: 'plain entry',
    });
    expect(await attributeValues(clean)).toEqual({ a: { description: 'A', examples: ['x'] } });
    // A non-object root is left for the read guard to report, not rewritten.
    expect(await attributeValues(arrayRoot)).toEqual([{ embedding: [0.5] }]);

    // Idempotent: a second run changes nothing.
    await executeMigrationSection((statement) => sql.unsafe(statement), up);
    expect(await attributeValues(withVectors)).toEqual({
      positive: { description: 'Positive', examples: ['great'] },
      negative: { description: 'Negative', examples: ['awful'] },
      child: { description: 'Child', examples: [], parent: { sentiment: 'positive' } },
      scalar: 'plain entry',
    });
  });
});
