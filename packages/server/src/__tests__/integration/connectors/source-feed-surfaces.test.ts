/**
 * Explicit source-read contract. Search reports visible source feeds without
 * querying them; feeds.get is metadata-only; feeds.readMany is the one bounded
 * live-read seam.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertEntityApprovalPolicy } from '../../../authz/entity-policy';
import type { AuthzScope } from '../../../authz/scope';
import type { Env } from '../../../index';
import { manageFeeds } from '../../../tools/admin/manage_feeds';
import { QuerySqlSchema } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { gatherLocalRecall, type RecallContext } from '../../../tools/search';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';

const SOURCE_SQL = 'SELECT id, name, amount FROM vfsurf_ext ORDER BY id';

describe('explicit feed source reads', () => {
  let orgId: string;
  let orgSlug: string;
  let ownerId: string;
  let ownerCtx: ToolContext;
  let publicFeedId: number;
  let privateFeedId: number;
  let collectedFeedId: number;

  const recallContext = (): RecallContext => ({
    query: 'apple',
    contentAgentId: undefined,
    contentLimit: 10,
    env: {} as Env,
    workspaceSlug: orgSlug,
  });
  const ownerScope = (): AuthzScope => ({ organizationId: orgId, principal: ownerId });
  const memberScope = (): AuthzScope => ({ organizationId: orgId, principal: 'member-x' });
  const memberCtx = (): ToolContext => ({
    organizationId: orgId,
    userId: 'member-x',
    memberRole: 'member',
    isAuthenticated: true,
    tokenType: 'oauth',
    scopedToOrg: false,
    allowCrossOrg: false,
    scopes: ['mcp:read'],
  });

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'ExplicitFeedReads' });
    orgId = org.id;
    orgSlug = org.slug;
    const user = await createTestUser({ email: 'explicit-feed-read@test.com' });
    ownerId = user.id;
    await addUserToOrganization(user.id, org.id, 'owner');
    ownerCtx = ownerToolContext(orgId, user.id);

    const db = getTestDb();
    await db`DROP TABLE IF EXISTS vfsurf_ext`;
    await db`CREATE TABLE vfsurf_ext (id bigserial primary key, name text, amount numeric)`;
    await db`INSERT INTO vfsurf_ext (name, amount) VALUES ('apple', 10), ('banana', 5), ('apricot', 7)`;

    const profile = await createAuthProfile({
      organizationId: orgId,
      connectorKey: 'postgres',
      displayName: 'external db',
      profileKind: 'env',
      authData: { DATABASE_URL: process.env.DATABASE_URL as string },
    });
    await db`
      INSERT INTO connector_definitions
        (key, name, version, feeds_schema, auth_schema, organization_id, status, created_at, updated_at)
      VALUES ('postgres', 'PostgreSQL', '1.0.1',
        ${db.json({
          query: { key: 'query', operations: ['sync', 'read'] },
          collected: { key: 'collected', operations: ['sync'] },
        })},
        ${db.json({})}, ${orgId}, 'active', NOW(), NOW())
      ON CONFLICT DO NOTHING
    `;
    await db`
      INSERT INTO connector_versions (connector_key, version, compiled_code, source_path, created_at)
      VALUES ('postgres', '1.0.1', NULL, NULL, NOW())
      ON CONFLICT DO NOTHING
    `;
    await db`
      INSERT INTO connector_definitions
        (key, name, version, feeds_schema, auth_schema, organization_id, status, created_at, updated_at)
      VALUES ('postgres', 'PostgreSQL', '1.0.0',
        ${db.json({ query: { key: 'query', operations: ['sync'] } })},
        ${db.json({})}, ${orgId}, 'archived', NOW(), NOW())
    `;

    const createConnection = async (slug: string, visibility: 'org' | 'private') => {
      const [row] = await db`
        INSERT INTO connections
          (organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by, created_at, updated_at)
        VALUES (${orgId}, 'postgres', ${slug}, ${slug}, 'active', ${profile.id}, ${visibility}, ${ownerId}, NOW(), NOW())
        RETURNING id
      `;
      return Number((row as { id: number }).id);
    };
    const publicConnectionId = await createConnection('explicit-public', 'org');
    const privateConnectionId = await createConnection('explicit-private', 'private');
    const pinnedConnectionId = await createConnection('explicit-pinned', 'org');

    const createFeed = async (
      connectionId: number,
      feedKey: string,
      pinnedVersion?: string,
    ) => {
      const [row] = await db`
        INSERT INTO feeds
          (organization_id, connection_id, feed_key, display_name, status, config,
            pinned_version, created_at, updated_at)
        VALUES (${orgId}, ${connectionId}, ${feedKey}, ${feedKey}, 'active',
          ${db.json({ query: SOURCE_SQL, primary_key: 'id', cursor_column: 'id' })},
          ${pinnedVersion ?? null}, NOW(), NOW())
        RETURNING id
      `;
      return Number((row as { id: number }).id);
    };
    publicFeedId = await createFeed(publicConnectionId, 'query');
    privateFeedId = await createFeed(privateConnectionId, 'query');
    collectedFeedId = await createFeed(publicConnectionId, 'collected');
    await createFeed(pinnedConnectionId, 'query', '1.0.0');
  }, 120_000);

  afterAll(async () => {
    await getTestDb()`DROP TABLE IF EXISTS vfsurf_ext`;
  });

  it('search stays local and applies visibility plus pinned-capability fences', async () => {
    const owner = await gatherLocalRecall(ownerScope(), recallContext());
    expect(owner.coverage).toMatchObject({
      source_queried: false,
      source_feed_discovery: 'complete',
    });
    expect(owner.coverage?.source_feeds.map((feed) => feed.feed_id).sort()).toEqual(
      [publicFeedId, privateFeedId].sort()
    );
    expect(owner.coverage?.source_feeds.every((feed) => feed.status === 'not_queried')).toBe(true);

    const member = await gatherLocalRecall(memberScope(), recallContext());
    expect(member.coverage?.source_feeds.map((feed) => feed.feed_id)).toEqual([publicFeedId]);
  });

  it('feeds.get returns metadata and never source rows', async () => {
    const result = await manageFeeds(
      { action: 'read_feed', feed_id: publicFeedId },
      {},
      ownerCtx
    );
    expect(result).toMatchObject({
      action: 'read_feed',
      feed: { operations: ['sync', 'read'], store: 'events' },
    });
    expect(result).not.toHaveProperty('kind');
    expect(result).toHaveProperty('recent_runs');
    expect(result).not.toHaveProperty('rows');
  });

  it('query_sql no longer accepts a feed argument', () => {
    expect(QuerySqlSchema.properties).not.toHaveProperty('feed');
    expect(QuerySqlSchema.required).toContain('sql');
  });

  it('readMany returns partial failures and structured error metadata', async () => {
    const result = await manageFeeds(
      {
        action: 'read_feeds',
        reads: [
          { feed_id: publicFeedId, limit: 2 },
          { feed_id: 999_999_999 },
          { feed_id: collectedFeedId },
        ],
      },
      {},
      ownerCtx
    );
    if (result.action !== 'read_feeds') throw new Error('expected read_feeds result');
    expect(result.failures).toBe(2);
    expect(result.results[0]).toMatchObject({ feed_id: publicFeedId, ok: true });
    expect(result.results[0].rows).toHaveLength(2);
    expect(result.results[1]).toMatchObject({
      ok: false,
      error_code: 'NOT_FOUND',
      retryable: false,
    });
    expect(result.results[2]).toMatchObject({
      ok: false,
      error_code: 'VALIDATION',
      retryable: false,
    });
  }, 60_000);

  it('supports source-native sort and opaque request-bound pagination cursors', async () => {
    const first = await manageFeeds(
      {
        action: 'read_feeds',
        reads: [{ feed_id: publicFeedId, query: 'ap', limit: 1, sort: { column: 'id', order: 'asc' } }],
      },
      {},
      ownerCtx
    );
    if (first.action !== 'read_feeds') throw new Error('expected read_feeds result');
    const firstRead = first.results[0];
    expect(firstRead.rows).toHaveLength(1);
    expect(firstRead.next_cursor).toBeTypeOf('string');

    const second = await manageFeeds(
      {
        action: 'read_feeds',
        reads: [
          {
            feed_id: publicFeedId,
            query: 'ap',
            limit: 1,
            cursor: firstRead.next_cursor,
            sort: { column: 'id', order: 'asc' },
          },
        ],
      },
      {},
      ownerCtx
    );
    if (second.action !== 'read_feeds') throw new Error('expected read_feeds result');
    expect(second.results[0].rows).toHaveLength(1);
    expect(second.results[0].rows?.[0]).not.toEqual(firstRead.rows?.[0]);

    const mismatched = await manageFeeds(
      {
        action: 'read_feeds',
        reads: [
          { feed_id: publicFeedId, query: 'banana', cursor: firstRead.next_cursor },
        ],
      },
      {},
      ownerCtx
    );
    if (mismatched.action !== 'read_feeds') throw new Error('expected read_feeds result');
    expect(mismatched.results[0]).toMatchObject({ ok: false, error_code: 'VALIDATION' });

    const mismatchedSort = await manageFeeds(
      {
        action: 'read_feeds',
        reads: [
          {
            feed_id: publicFeedId,
            query: 'ap',
            cursor: firstRead.next_cursor,
            sort: { column: 'id', order: 'desc' },
          },
        ],
      },
      {},
      ownerCtx
    );
    if (mismatchedSort.action !== 'read_feeds') throw new Error('expected read_feeds result');
    expect(mismatchedSort.results[0]).toMatchObject({ ok: false, error_code: 'VALIDATION' });

    const differentFeed = await manageFeeds(
      {
        action: 'read_feeds',
        reads: [
          {
            feed_id: privateFeedId,
            query: 'ap',
            cursor: firstRead.next_cursor,
            sort: { column: 'id', order: 'asc' },
          },
        ],
      },
      {},
      ownerCtx
    );
    if (differentFeed.action !== 'read_feeds') throw new Error('expected read_feeds result');
    expect(differentFeed.results[0]).toMatchObject({ ok: false, error_code: 'VALIDATION' });
  }, 60_000);

  it('keeps each explicit source read visibility-fenced', async () => {
    const result = await manageFeeds(
      {
        action: 'read_feeds',
        reads: [{ feed_id: publicFeedId }, { feed_id: privateFeedId }],
      },
      {},
      memberCtx()
    );
    if (result.action !== 'read_feeds') throw new Error('expected read_feeds result');
    expect(result.results[0].ok).toBe(true);
    expect(result.results[1]).toMatchObject({ ok: false, error_code: 'NOT_FOUND' });
  }, 60_000);
  it('headless Automation reads use only its durable creators private sources', async () => {
    const db = getTestDb();
    const [{ id }] = await db`SELECT nextval('automations_id_seq') AS id`;
    const automationId = Number(id);
    await db`INSERT INTO automations (id, organization_id, slug, name, status, created_by, automation_group_id)
      VALUES (${automationId}, ${orgId}, 'source-read-owner', 'Source read owner', 'active', ${ownerId}, ${automationId})`;
    const reactionCtx: ToolContext = { ...ownerCtx, userId: null, memberRole: null, actingAutomationId: automationId };
    const read = async (ctx: ToolContext) => {
      const result = await manageFeeds({ action: 'read_feeds', reads: [{ feed_id: privateFeedId, limit: 1 }] }, {}, ctx);
      if (result.action !== 'read_feeds') throw new Error('expected read_feeds');
      return result.results[0];
    };
    expect(await read(reactionCtx)).toMatchObject({ ok: true, rows: [{ name: 'apple' }] });
    for (const effect of ['deny', 'approval'] as const) {
      await upsertEntityApprovalPolicy(orgId, { resourceClass: 'connector_action', connectorKey: 'postgres', operationCategory: 'read', effects: { execute: effect } });
      expect(await read(reactionCtx)).toMatchObject({ ok: false, error_code: 'PERMISSION' });
    }
    await upsertEntityApprovalPolicy(orgId, { resourceClass: 'connector_action', connectorKey: 'postgres', operationCategory: 'read', effects: { execute: 'auto' } });
    // A caller with a real identity cannot adopt the Automation creator's access.
    expect(await read({ ...memberCtx(), actingAutomationId: automationId })).toMatchObject({ ok: false, error_code: 'NOT_FOUND' });
    expect(await read({ ...reactionCtx, actingAutomationId: undefined })).toMatchObject({ ok: false, error_code: 'NOT_FOUND' });
    await db`UPDATE automations SET status = 'archived' WHERE id = ${automationId}`;
    expect(await read(reactionCtx)).toMatchObject({ ok: false, error_code: 'NOT_FOUND' });
    await db`UPDATE automations SET status = 'active' WHERE id = ${automationId}`;
    const other = await createTestUser({ email: 'other-source-owner@test.com' });
    await db`UPDATE automations SET created_by = ${other.id} WHERE id = ${automationId}`;
    expect(await read(reactionCtx)).toMatchObject({ ok: false, error_code: 'NOT_FOUND' });
    const foreign = await createTestOrganization({ name: 'Other source workspace' });
    expect(await read({ ...reactionCtx, organizationId: foreign.id })).toMatchObject({ ok: false, error_code: 'NOT_FOUND' });
    await db`DELETE FROM automations WHERE id = ${automationId}`;
    expect(await read(reactionCtx)).toMatchObject({ ok: false, error_code: 'NOT_FOUND' });
  }, 60_000);

});
