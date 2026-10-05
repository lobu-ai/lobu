/**
 * End-to-end capability contract for a hybrid Postgres feed.
 *
 * One feed row is both scheduler-eligible (`sync`) and directly queryable
 * (`read`). Source reads persist no events, and the ordinary connection ACL and
 * lifecycle gates apply before connector code runs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthzScope } from '../../../authz/scope';
import type { Env } from '../../../index';
import { readSourceFeed } from '../../../lib/connector-pushdown';
import { materializeDueFeeds } from '../../../scheduled/check-due-feeds';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { addUserToOrganization, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const SOURCE_SQL = 'SELECT id, name, amount FROM source_feed_ext';

describe('hybrid feed capability contract', () => {
  let orgId: string;
  let ownerId: string;
  let connectionId: number;
  let hybridFeedId: number;
  let privateFeedId: number;
  let syncOnlyFeedId: number;

  const ownerScope = (): AuthzScope => ({ organizationId: orgId, principal: ownerId });
  const memberScope = (): AuthzScope => ({ organizationId: orgId, principal: 'member-x' });

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'HybridFeed' });
    orgId = org.id;
    const owner = await createTestUser({ email: 'hybrid-feed@test.com' });
    ownerId = owner.id;
    await addUserToOrganization(owner.id, org.id, 'owner');

    const db = getTestDb();
    await db`DROP TABLE IF EXISTS source_feed_ext`;
    await db`CREATE TABLE source_feed_ext (id bigserial primary key, name text, amount numeric)`;
    await db`INSERT INTO source_feed_ext (name, amount) VALUES ('apple', 10), ('banana', 5), ('apricot', 7)`;

    const profile = await createAuthProfile({
      organizationId: orgId,
      connectorKey: 'postgres',
      displayName: 'source db',
      profileKind: 'env',
      authData: { DATABASE_URL: process.env.DATABASE_URL as string },
    });

    await db`
      INSERT INTO connector_definitions
        (key, name, version, feeds_schema, auth_schema, organization_id, status, created_at, updated_at)
      VALUES (
        'postgres', 'PostgreSQL', '1.0.1',
        ${db.json({
          query: { key: 'query', operations: ['sync', 'read'] },
          sync_only: { key: 'sync_only', operations: ['sync'] },
        })},
        ${db.json({})}, ${orgId}, 'active', NOW(), NOW()
      )
    `;
    await db`
      INSERT INTO connector_versions (connector_key, version, compiled_code, source_path, created_at)
      VALUES ('postgres', '1.0.1', NULL, NULL, NOW())
      ON CONFLICT DO NOTHING
    `;

    const [connection] = await db`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, auth_profile_id,
         visibility, created_by, created_at, updated_at)
      VALUES
        (${orgId}, 'postgres', 'hybrid-source-db', 'Hybrid source DB', 'active',
         ${profile.id}, 'org', ${ownerId}, NOW(), NOW())
      RETURNING id
    `;
    connectionId = Number((connection as { id: number }).id);

    const feedConfig = { query: SOURCE_SQL, primary_key: 'id', cursor_column: 'id' };
    const [hybrid] = await db`
      INSERT INTO feeds
        (organization_id, connection_id, feed_key, status, config, schedule,
         next_run_at, created_at, updated_at)
      VALUES
        (${orgId}, ${connectionId}, 'query', 'active', ${db.json(feedConfig)},
         '*/5 * * * *', NOW() - INTERVAL '1 minute', NOW(), NOW())
      RETURNING id
    `;
    hybridFeedId = Number((hybrid as { id: number }).id);

    const [syncOnly] = await db`
      INSERT INTO feeds
        (organization_id, connection_id, feed_key, status, config, created_at, updated_at)
      VALUES (${orgId}, ${connectionId}, 'sync_only', 'active', ${db.json(feedConfig)}, NOW(), NOW())
      RETURNING id
    `;
    syncOnlyFeedId = Number((syncOnly as { id: number }).id);

    const [privateConnection] = await db`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, auth_profile_id,
         visibility, created_by, created_at, updated_at)
      VALUES
        (${orgId}, 'postgres', 'private-source-db', 'Private source DB', 'active',
         ${profile.id}, 'private', ${ownerId}, NOW(), NOW())
      RETURNING id
    `;
    const [privateFeed] = await db`
      INSERT INTO feeds
        (organization_id, connection_id, feed_key, status, config, created_at, updated_at)
      VALUES
        (${orgId}, ${Number((privateConnection as { id: number }).id)}, 'query',
         'active', ${db.json(feedConfig)}, NOW(), NOW())
      RETURNING id
    `;
    privateFeedId = Number((privateFeed as { id: number }).id);
  }, 120_000);

  afterAll(async () => {
    await getTestDb()`DROP TABLE IF EXISTS source_feed_ext`;
  });

  it('schedules and source-reads the same feed row', async () => {
    await materializeDueFeeds({} as Env, getTestDb());

    const [runCount] = await getTestDb()`
      SELECT count(*)::int AS n FROM runs
      WHERE feed_id = ${hybridFeedId} AND run_type = 'sync'
    `;
    expect(Number((runCount as { n: number }).n)).toBeGreaterThan(0);

    const result = await readSourceFeed({
      deadlineAt: Date.now() + 30_000,
      scope: ownerScope(),
      feedId: hybridFeedId,
      query: 'ap',
      limit: 10,
    });
    expect(result.rows.map((row) => row.name).sort()).toEqual(['apple', 'apricot']);
    expect(result.total).toBe(2);

    const [eventCount] = await getTestDb()`
      SELECT count(*)::int AS n FROM events WHERE connection_id = ${connectionId}
    `;
    expect(Number((eventCount as { n: number }).n)).toBe(0);
  }, 60_000);

  it('fails closed when the selected feed definition lacks read', async () => {
    await expect(
      readSourceFeed({ deadlineAt: Date.now() + 30_000, scope: ownerScope(), feedId: syncOnlyFeedId }),
    ).rejects.toThrow(/does not support source reads/i);
  });

  it('enforces connection visibility and feed lifecycle before source access', async () => {
    await expect(
      readSourceFeed({ deadlineAt: Date.now() + 30_000, scope: memberScope(), feedId: privateFeedId }),
    ).rejects.toThrow(/not found or not accessible/i);

    const ownerResult = await readSourceFeed({ deadlineAt: Date.now() + 30_000, scope: ownerScope(), feedId: privateFeedId });
    expect(ownerResult.rows).toHaveLength(3);

    await getTestDb()`UPDATE feeds SET status = 'paused' WHERE id = ${privateFeedId}`;
    await expect(
      readSourceFeed({ deadlineAt: Date.now() + 30_000, scope: ownerScope(), feedId: privateFeedId }),
    ).rejects.toThrow(/not found or not accessible/i);
  }, 60_000);
});
