/**
 * `client.feeds.trigger({ feed_id, dry_run: true })` reaches the dry path.
 *
 * The declared SDK input type is no runtime guarantee: sandbox scripts are
 * transpiled by esbuild, which strips types without checking them, and
 * `feeds.trigger` just forwards its input through `createActionCaller` to the
 * `trigger_feed` action. So these tests exercise the real chain — namespace →
 * action caller → manage_feeds → TriggerFeedAction → createSyncRun — and read
 * the persisted `runs` row rather than trusting the returned payload.
 *
 * The non-dry control is what gives the dry assertions meaning: without it, a
 * build that hardcoded `dry_run = true` on every triggered run would pass.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { buildFeedsNamespace } from '../../sandbox/namespaces/feeds';
import { manageFeeds } from '../../tools/admin/manage_feeds';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  seedOwnerContext,
} from '../setup/test-fixtures';

async function seedFeed(
  slug: string,
  status: 'active' | 'paused' = 'active',
  opts: { orgScopedDefinition?: boolean; operations?: Array<'sync' | 'read'> } = {},
): Promise<{
  feedId: number;
  ctx: Awaited<ReturnType<typeof seedOwnerContext>>['ctx'];
}> {
  const sql = getTestDb();
  const { org, ctx } = await seedOwnerContext();

  // Org-scoped, not the global catalog row: `resolveActiveConnectorVersion`
  // resolves on (connector_key, org), and a global-only definition makes
  // createSyncRun soft-delete the feed as an orphan and return null — which the
  // handler then reports as "Sync already pending or running". The skip-reason
  // cases opt into the global-only definition on purpose.
  await createTestConnectorDefinition({
    key: 'rss',
    name: 'RSS',
    ...(opts.orgScopedDefinition === false ? {} : { organization_id: org.id }),
    feeds_schema: { items: opts.operations ? { operations: opts.operations } : {} },
  });
  const conn = await createTestConnection({
    organization_id: org.id,
    connector_key: 'rss',
    slug,
  });

  const feed = (await sql`
    INSERT INTO feeds
      (organization_id, connection_id, feed_key, status, checkpoint,
       created_at, updated_at)
    VALUES
      (${org.id}, ${conn.id}, 'items', ${status}, ${sql.json({ cursor: 'c0' })},
       NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;

  return { feedId: Number(feed[0].id), ctx };
}

describe('client.feeds.trigger dry_run', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('marks the queued run dry when the SDK caller asks for it', async () => {
    const sql = getTestDb();
    const { feedId, ctx } = await seedFeed('rss-sdk-dry');

    const feeds = buildFeedsNamespace(ctx, {} as Env);
    await feeds.trigger({ feed_id: feedId, dry_run: true });

    const runs = (await sql`
      SELECT dry_run FROM runs WHERE feed_id = ${feedId}
    `) as Array<{ dry_run: boolean }>;

    expect(runs).toHaveLength(1);
    expect(runs[0].dry_run).toBe(true);
  });

  it('allows a dry run while the feed stays paused with its checkpoint intact', async () => {
    const sql = getTestDb();
    const { feedId, ctx } = await seedFeed('rss-sdk-paused-dry', 'paused');

    const feeds = buildFeedsNamespace(ctx, {} as Env);
    await feeds.trigger({ feed_id: feedId, dry_run: true });

    const runs = (await sql`
      SELECT dry_run FROM runs WHERE feed_id = ${feedId}
    `) as Array<{ dry_run: boolean }>;
    const feed = (await sql`
      SELECT status, checkpoint FROM feeds WHERE id = ${feedId}
    `) as Array<{ status: string; checkpoint: { cursor: string } }>;

    expect(runs).toEqual([{ dry_run: true }]);
    expect(feed).toEqual([{ status: 'paused', checkpoint: { cursor: 'c0' } }]);
  });

  it('still rejects a persistent trigger while the feed is paused', async () => {
    const sql = getTestDb();
    const { feedId, ctx } = await seedFeed('rss-sdk-paused-wet', 'paused');

    const feeds = buildFeedsNamespace(ctx, {} as Env);
    await expect(feeds.trigger({ feed_id: feedId })).rejects.toThrow(
      'Feed is paused, must be active to trigger sync',
    );

    const runs = await sql`SELECT id FROM runs WHERE feed_id = ${feedId}`;
    expect(runs).toHaveLength(0);
  });

  it('leaves the run persistent when dry_run is omitted', async () => {
    const sql = getTestDb();
    const { feedId, ctx } = await seedFeed('rss-sdk-wet');

    const feeds = buildFeedsNamespace(ctx, {} as Env);
    await feeds.trigger({ feed_id: feedId });

    const runs = (await sql`
      SELECT dry_run FROM runs WHERE feed_id = ${feedId}
    `) as Array<{ dry_run: boolean }>;

    expect(runs).toHaveLength(1);
    expect(runs[0].dry_run).toBe(false);
  });

  it('does not let a caller-supplied action key redirect the dry flag', async () => {
    // `createActionCaller` strips a caller `action` before forcing the real
    // one. Asserted here because the dry flag rides the same payload: if that
    // strip regressed, `dry_run` could arrive at a handler that ignores it and
    // the caller would get a persistent run while being told it was dry.
    const sql = getTestDb();
    const { feedId, ctx } = await seedFeed('rss-sdk-spoof');

    const feeds = buildFeedsNamespace(ctx, {} as Env);
    await feeds.trigger({
      feed_id: feedId,
      dry_run: true,
      action: 'delete_feed',
    } as { feed_id: number; dry_run?: boolean });

    const runs = (await sql`
      SELECT dry_run FROM runs WHERE feed_id = ${feedId}
    `) as Array<{ dry_run: boolean }>;

    expect(runs).toHaveLength(1);
    expect(runs[0].dry_run).toBe(true);

    const feed = (await sql`
      SELECT status FROM feeds WHERE id = ${feedId}
    `) as Array<{ status: string }>;
    expect(feed[0].status).toBe('active');
  });
});

/**
 * `createSyncRun` declines for several reasons, and the handler used to render
 * every one of them as "Sync already pending or running", sending operators to
 * wait for a run that would never exist. The skip must name its real cause and
 * be readable as a skip (`triggered: false`) without parsing the sentence.
 */
describe('trigger_feed skip reasons', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  type TriggerResult = { message?: string; triggered?: boolean; reason?: string; error?: string };
  const trigger = (feedId: number, ctx: Awaited<ReturnType<typeof seedOwnerContext>>['ctx']) =>
    manageFeeds({ action: 'trigger_feed', feed_id: feedId }, {} as Env, ctx) as Promise<TriggerResult>;

  it('does not claim a sync is pending when the connector is uninstalled', async () => {
    // A global-only definition is invisible to resolveActiveConnectorVersion,
    // which retires the feed as an orphan and declines.
    const { feedId, ctx } = await seedFeed('rss-skip-orphan', 'active', { orgScopedDefinition: false });
    const res = await trigger(feedId, ctx);
    expect(res.triggered).toBe(false);
    expect(res.reason).toBeTruthy();
    expect(res.message).toContain('no longer installed');
    expect(res.message).not.toContain('already pending');
  });

  it('still reports a genuine duplicate as already pending', async () => {
    const { feedId, ctx } = await seedFeed('rss-skip-dup');
    expect((await trigger(feedId, ctx)).triggered).toBe(true);

    const second = await trigger(feedId, ctx);
    expect(second.triggered).toBe(false);
    expect(second.reason).toBeTruthy();
    expect(second.message).toContain('already pending or running');
  });

  it('reports that a read-only feed does not support sync without retiring it', async () => {
    const { feedId, ctx } = await seedFeed('rss-skip-read', 'active', { operations: ['read'] });
    const res = await trigger(feedId, ctx);
    // The ERROR variant carries no `triggered` at all.
    expect(res.triggered).toBeUndefined();
    expect(res.error).toContain('does not support sync');

    const [feed] = await getTestDb()<Array<{ deleted_at: Date | null }>>`
      SELECT deleted_at FROM feeds WHERE id = ${feedId}
    `;
    expect(feed?.deleted_at).toBeNull();
  });
});
