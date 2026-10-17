import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import {
  executeMigrationSection,
  loadMigrationDown,
  loadMigrationUp,
} from '../../../db/migration-loader';
import type { Env } from '../../../index';
import { createSyncRun } from '../../../runs/queue-service';
import { materializeDueFeeds } from '../../../scheduled/check-due-feeds';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
} from '../../setup/test-fixtures';

const MIGRATION = '20260824121000_feed_operations_backfill.sql';
// This replays a historical migration whose input carried feeds.kind/virtual.
// The later contract migration's down/up restores and re-drops those slots.
const DROP_KIND_VIRTUAL = '20261017120000_drop_feeds_kind_virtual.sql';

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

describe('feed operations backfill migration', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    const restore = loadMigrationDown(resolveMigrationsDir(), DROP_KIND_VIRTUAL);
    await executeMigrationSection((statement) => getDb().unsafe(statement), restore);
  });

  afterEach(async () => {
    const drop = loadMigrationUp(resolveMigrationsDir(), DROP_KIND_VIRTUAL);
    await executeMigrationSection((statement) => getDb().unsafe(statement), drop);
  });

  it('converts legacy definition snapshots and keeps scheduled/manual sync runnable', async () => {
    const sql = getDb();
    const org = await createTestOrganization({ name: 'Feed Operations Backfill' });
    const connectorKey = 'test.feed-operations-backfill';
    await createTestConnectorDefinition({
      key: connectorKey,
      name: 'Feed Operations Backfill',
      organization_id: org.id,
      feeds_schema: {
        collected: {},
        live_instance: {},
        live_default: {},
        manual: {},
        explicit: { operations: ['read'] },
      },
    });
    await sql`
      UPDATE connector_definitions
      SET feeds_schema = ${sql.json({
        collected: { key: 'collected' },
        live_instance: { key: 'live_instance' },
        live_default: { key: 'live_default', virtual: true },
        manual: { key: 'manual' },
        explicit: { key: 'explicit', operations: ['read'] },
      })}
      WHERE organization_id = ${org.id} AND key = ${connectorKey}
    `;
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: connectorKey,
      createDefaultFeed: false,
    });
    const feeds = await sql<{ id: number; feed_key: string }[]>`
      INSERT INTO feeds (
        organization_id, connection_id, feed_key, status, kind, virtual,
        schedule, next_run_at, created_at, updated_at
      ) VALUES
        (
          ${org.id}, ${connection.id}, 'collected', 'active', 'collected', false,
          '* * * * *', current_timestamp - interval '1 minute',
          current_timestamp, current_timestamp
        ),
        (
          ${org.id}, ${connection.id}, 'live_instance', 'active', 'virtual', true,
          NULL, NULL, current_timestamp, current_timestamp
        ),
        (
          ${org.id}, ${connection.id}, 'manual', 'active', 'collected', false,
          NULL, NULL, current_timestamp, current_timestamp
        ),
        (
          ${org.id}, ${connection.id}, 'explicit', 'active', 'collected', false,
          '* * * * *', current_timestamp - interval '1 minute',
          current_timestamp, current_timestamp
        )
      RETURNING id, feed_key
    `;

    const up = loadMigrationUp(resolveMigrationsDir(), MIGRATION);
    await executeMigrationSection((statement) => sql.unsafe(statement), up);

    const [definition] = await sql<{ feeds_schema: Record<string, { operations?: string[] }> }[]>`
      SELECT feeds_schema
      FROM connector_definitions
      WHERE organization_id = ${org.id} AND key = ${connectorKey}
    `;
    expect(definition.feeds_schema.collected?.operations).toEqual(['sync']);
    expect(definition.feeds_schema.live_instance?.operations).toEqual(['sync', 'read']);
    expect(definition.feeds_schema.live_default?.operations).toEqual(['sync', 'read']);
    expect(definition.feeds_schema.manual?.operations).toEqual(['sync']);
    expect(definition.feeds_schema.explicit?.operations).toEqual(['read']);

    const materialized = await materializeDueFeeds({} as Env, sql);
    expect(materialized.runsCreated).toBe(1);
    const manualFeedId = Number(feeds.find((feed) => feed.feed_key === 'manual')?.id);
    const manual = await createSyncRun(manualFeedId, {} as Env, sql);
    expect(manual.ok).toBe(true);

    const beforeReplay = definition.feeds_schema;
    await executeMigrationSection((statement) => sql.unsafe(statement), up);
    const [replayed] = await sql<{ feeds_schema: Record<string, unknown> }[]>`
      SELECT feeds_schema
      FROM connector_definitions
      WHERE organization_id = ${org.id} AND key = ${connectorKey}
    `;
    expect(replayed.feeds_schema).toEqual(beforeReplay);

    const down = loadMigrationDown(resolveMigrationsDir(), MIGRATION);
    await executeMigrationSection((statement) => sql.unsafe(statement), down);
    const [rolledBack] = await sql<{ feeds_schema: Record<string, Record<string, unknown>> }[]>`
      SELECT feeds_schema
      FROM connector_definitions
      WHERE organization_id = ${org.id} AND key = ${connectorKey}
    `;
    expect(
      Object.values(rolledBack.feeds_schema).every(
        (feedDefinition) => !Object.hasOwn(feedDefinition, 'operations'),
      ),
    ).toBe(true);
    expect(rolledBack.feeds_schema.explicit?.virtual).toBe(true);

    const [rolledBackReadOnlyFeed] = await sql<
      {
        kind: string;
        virtual: boolean;
        schedule: string | null;
        timezone: string | null;
        next_run_at: Date | null;
        checkpoint: unknown;
      }[]
    >`
      SELECT kind, virtual, schedule, timezone, next_run_at, checkpoint
      FROM feeds
      WHERE organization_id = ${org.id} AND feed_key = 'explicit'
    `;
    expect(rolledBackReadOnlyFeed).toMatchObject({
      kind: 'virtual',
      virtual: true,
      schedule: null,
      timezone: null,
      next_run_at: null,
      checkpoint: null,
    });
  });
});
