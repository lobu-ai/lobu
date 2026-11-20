/**
 * Property/fuzz regression: searchContentByText (read_knowledge / get_content)
 * must NEVER throw on adversarial query text — it returns matches or an empty
 * list, but a malformed query can't surface a Postgres error to the caller.
 *
 * Origin bug: a leading newline survived Postgres `trim()` (which strips spaces
 * only) and became a leading ' | ' in the constructed tsquery, so
 * `to_tsquery('english', ' | foo')` threw `syntax error in tsquery` → a 400 from
 * read_knowledge. A single hand-picked case wouldn't catch the next variant, so
 * this test generates a cross-product of whitespace / tsquery-operator / unicode
 * / oversized / injection-ish fragments and asserts the whole space is safe.
 *
 * If you add a new way to build the fulltext query, this test is the guard:
 * every (prefix × core × suffix) combination must resolve, not throw.
 *
 * Harness: vitest + embedded Postgres, text-only (no EMBEDDINGS_SERVICE_URL), so
 * the fulltext query branch is exercised on every query.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { searchContentByText } from '../../../utils/content-search';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

// Fragments that have historically broken naive tsquery construction.
const PREFIXES = [
  '',
  '\n',
  '\t',
  '\r\n',
  '   ',
  '\n\n\n',
  '---\n',
  '| ',
  '& ',
  '!(',
  ':: ',
  '*',
];
const CORES = [
  'quarterly revenue',
  'budget & forecast',
  'a:b:c',
  'foo|bar',
  '(unbalanced',
  'wildcard*prefix',
  '<-> phrase op',
  '🎉 emoji 日本語 query',
  "O'Brien's Q3 report",
  "'; DROP TABLE events; --",
  '!!! ??? &&& |||',
  '1234567890',
  'the and of to is', // all stopwords
  '', // empty core
  'x'.repeat(6000), // oversized
];
const SUFFIXES = ['', '\n', ' |', ' &', '   \t', ')', ':*', '\r'];

describe('searchContentByText > fuzz: no query input may throw', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let eventId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'TSQuery Fuzz Org' });
    const user = await createTestUser({ email: 'tsquery-fuzz@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const entity = await createTestEntity({ name: 'Fuzz Entity', organization_id: org.id });
    eventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        content: 'The quarterly revenue review covered forecasts and budgets.',
      })
    ).id;
  });

  it(`survives every (prefix × core × suffix) combination (${PREFIXES.length * CORES.length * SUFFIXES.length} queries)`, async () => {
    const failures: Array<{ query: string; error: string }> = [];
    let ran = 0;
    for (const p of PREFIXES) {
      for (const c of CORES) {
        for (const s of SUFFIXES) {
          const query = p + c + s;
          try {
            const result = await searchContentByText(query, {
              organization_id: org.id,
              limit: 10,
              sort_by: 'score',
            });
            expect(Array.isArray(result.content)).toBe(true);
            ran++;
          } catch (e) {
            failures.push({ query: JSON.stringify(query).slice(0, 80), error: String(e).slice(0, 160) });
          }
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/${ran + failures.length} query combinations threw:\n` +
          failures.slice(0, 10).map((f) => `  ${f.query} -> ${f.error}`).join('\n')
      );
    }
    expect(ran).toBe(PREFIXES.length * CORES.length * SUFFIXES.length);
  });

  it('still finds content when the query is wrapped in whitespace/operators (recall preserved)', async () => {
    for (const q of ['\n  quarterly revenue\t', '| quarterly revenue |', '\n\nquarterly\trevenue\n']) {
      const result = await searchContentByText(q, { organization_id: org.id, limit: 10, sort_by: 'score' });
      expect(result.content.map((c) => c.id)).toContain(eventId);
    }
  });
});
