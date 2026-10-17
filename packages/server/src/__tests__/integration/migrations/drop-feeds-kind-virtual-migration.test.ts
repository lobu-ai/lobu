import { readFileSync } from 'node:fs';
import type { TransactionSql } from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { ensureChannelFeed } from '../../../gateway/channels/channel-feed';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestConnection, createTestOrganization } from '../../setup/test-fixtures';

const name = '20261017120000_drop_feeds_kind_virtual.sql';
const root = new URL('../../../../../../db/migrations/', import.meta.url);
const [up, down] = readFileSync(new URL(name, root), 'utf8').split('-- migrate:down');

const legacyColumns = (sql: TransactionSql | ReturnType<typeof getDb>) => sql`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'feeds' AND column_name IN ('kind', 'virtual')
  ORDER BY column_name`;

/** The rolled-back schema exists only inside this transaction, never between tests. */
async function inRolledBackTx(run: (tx: TransactionSql) => Promise<void>): Promise<void> {
  const rollback = new Error('rollback feeds kind/virtual fixture');
  try {
    await getDb().begin(async (tx) => {
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe('drop feeds.kind and feeds.virtual', () => {
  beforeEach(cleanupTestDatabase);

  it('fresh migrated schema has neither retired discriminator', async () => {
    expect(await legacyColumns(getDb())).toEqual([]);
  });

  it('rolls back to the pre-drop slots and re-drops without touching feed rows', async () => {
    const org = await createTestOrganization();
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test.drop-feeds-kind-virtual',
      createDefaultFeed: true,
    });
    const channelFeedId = await ensureChannelFeed({
      connectionId: connection.id,
      organizationId: org.id,
      channelKey: 'slack:C_DROP',
    });

    await inRolledBackTx(async (tx) => {
      const before = await tx`SELECT to_jsonb(f) AS feed FROM feeds f ORDER BY id`;
      expect(before.length).toBeGreaterThanOrEqual(2);

      await tx.unsafe(down!);
      expect(await legacyColumns(tx)).toEqual([{ column_name: 'kind' }, { column_name: 'virtual' }]);
      const restored = await tx<{ id: number; kind: string; virtual: boolean }[]>`
        SELECT id, kind, virtual FROM feeds ORDER BY id`;
      for (const row of restored) {
        expect(row).toEqual({
          id: row.id,
          kind: Number(row.id) === channelFeedId ? 'streaming' : 'collected',
          virtual: false,
        });
      }
      // A pre-drop binary's channel-feed insert works against the restored schema.
      await tx`INSERT INTO feeds (organization_id, connection_id, feed_key, status, config, kind, virtual)
        VALUES (${org.id}, ${connection.id}, 'slack:C_OLD', 'active',
          ${tx.json({ store: 'channel_messages' })}::jsonb, 'streaming', false)`;
      await expect(
        tx.savepoint((sp) => sp`UPDATE feeds SET kind = 'bogus' WHERE id = ${channelFeedId}`)
      ).rejects.toThrow('feeds_kind_check');
      await tx`DELETE FROM feeds WHERE feed_key = 'slack:C_OLD'`;

      await tx.unsafe(up!);
      expect(await legacyColumns(tx)).toEqual([]);
      expect(await tx`SELECT to_jsonb(f) AS feed FROM feeds f ORDER BY id`).toEqual(before);
      // Retries are harmless in both directions.
      await tx.unsafe(up!);
      await tx.unsafe(down!);
      await tx.unsafe(down!);
      await tx.unsafe(up!);
      expect(await tx`SELECT to_jsonb(f) AS feed FROM feeds f ORDER BY id`).toEqual(before);
    });
  });
});
