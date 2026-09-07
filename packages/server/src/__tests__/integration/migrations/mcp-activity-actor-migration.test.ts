import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestOAuthClient, createTestOrganization, createTestUser, seedSystemEntityTypes } from '../../setup/test-fixtures';

const migration = readFileSync(new URL(
  '../../../../../../db/migrations/20260907183000_mcp_activity_actor_identity.sql', import.meta.url,
), 'utf8').split('-- migrate:down')[0]!;

describe('MCP activity actor migration', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
  });

  it('rebuilds recent activity by actual actor, preserves proven titles and leaves events unchanged on replay', async () => {
    const first = await createTestOrganization({ slug: 'migration-activity-first' });
    const second = await createTestOrganization({ slug: 'migration-activity-second' });
    const user = await createTestUser({ email: 'migration-activity-owner@example.test' });
    const other = await createTestUser({ email: 'migration-activity-other@example.test' });
    const client = (await createTestOAuthClient({ owner_user_id: user.id })).client_id;
    const rollback = new Error('rollback isolated migration fixture');

    await expect(getDb().begin(async tx => {
      // Reconstruct the retired schema only within this rolled-back transaction.
      await tx`DELETE FROM mcp_client_conversations`;
      await tx.unsafe(`
        ALTER TABLE mcp_client_conversations DROP CONSTRAINT mcp_client_conversations_actor_pkey;
        ALTER TABLE mcp_client_conversations ALTER COLUMN user_id DROP NOT NULL;
        ALTER TABLE mcp_client_conversations ALTER COLUMN organization_id SET NOT NULL;
        ALTER TABLE mcp_client_conversations ADD CONSTRAINT mcp_client_conversations_pkey
          PRIMARY KEY (organization_id, client_identity, conversation_id);
        DROP INDEX mcp_activity_actor_recent;
        DROP INDEX mcp_activity_actor_client_recent;
        CREATE INDEX mcp_client_conversations_recent ON mcp_client_conversations (organization_id, last_activity_at DESC);
        CREATE INDEX mcp_activity_scope_client_recent ON mcp_client_conversations (organization_id, client_id, activity_kind, last_activity_at DESC);
      `);

      async function call(actor: string | null, workspace: string | null, activity: string, failed = false, old = false) {
        await tx`
          INSERT INTO events (organization_id, created_by, client_id, semantic_type,
            origin_type, metadata, payload_data, occurred_at)
          VALUES (${workspace}, ${actor}, ${client}, 'audit', 'tool_invocation',
            ${tx.json({ mcp_conversation_id: activity, mcp_session_id: `${activity}-${actor}-${workspace}` })},
            ${tx.json({ tool_name: failed ? 'run_sdk' : 'list_organizations', success: !failed })},
            now() - ${old ? '30 days' : '1 hour'}::interval)
        `;
      }
      async function legacy(actor: string | null, workspace: string, activity: string, title: string, count: number) {
        await tx`
          INSERT INTO mcp_client_conversations (organization_id, user_id, client_identity,
            client_id, conversation_id, title, last_action, call_count, first_activity_at)
          VALUES (${workspace}, ${actor}, ${client}, ${client}, ${activity}, ${title},
            'list_organizations', ${count}, now() - interval '2 hours')
        `;
      }

      await call(user.id, first.id, 'mixed');
      await call(other.id, first.id, 'mixed', true);
      await legacy(other.id, first.id, 'mixed', 'Ambiguous legacy title', 2);
      await call(user.id, first.id, 'safe-title');
      await legacy(user.id, first.id, 'safe-title', 'Preserved title', 1);
      await call(user.id, first.id, 'two-workspaces');
      await call(user.id, second.id, 'two-workspaces');
      await legacy(user.id, first.id, 'two-workspaces', 'Earlier target', 1);
      await legacy(user.id, second.id, 'two-workspaces', 'Later target', 1);
      await call(user.id, null, 'unbound');
      await call(null, first.id, 'unattributed');
      await legacy(null, first.id, 'unattributed', 'No known actor', 1);
      await call(user.id, first.id, 'old', false, true);
      await legacy(user.id, first.id, 'old', 'Outside Recent window', 1);
      const before = await tx`SELECT id, organization_id, created_by, metadata, payload_data, occurred_at
        FROM events WHERE client_id = ${client} ORDER BY id`;

      await tx.unsafe(migration);
      const rows = await tx`SELECT user_id, conversation_id, organization_id, title, call_count,
        failed_count, transport_session_ids, activity_kind FROM mcp_client_conversations
        WHERE client_identity = ${client} ORDER BY conversation_id, user_id`;
      expect(rows).toHaveLength(5);
      const mixed = rows.filter(row => row.conversation_id === 'mixed');
      expect(mixed).toHaveLength(2);
      expect(mixed.every(row => row.title === null && Number(row.call_count) === 1)).toBe(true);
      expect(mixed.find(row => row.user_id === other.id)?.failed_count).toBe(1);
      expect(rows.find(row => row.conversation_id === 'safe-title')?.title).toBe('Preserved title');
      expect(rows.find(row => row.conversation_id === 'two-workspaces')).toMatchObject({ organization_id: null, call_count: 2 });
      expect(rows.find(row => row.conversation_id === 'unbound')).toMatchObject({ organization_id: null, call_count: 1 });
      expect(rows.some(row => row.conversation_id === 'unattributed' || row.conversation_id === 'old')).toBe(false);

      // A replay must not rebuild again and erase new projection-only state.
      await tx`UPDATE mcp_client_conversations SET title = 'Title after cutover', call_count = call_count + 1
        WHERE user_id = ${user.id} AND conversation_id = 'safe-title'`;
      await tx.unsafe(migration);
      const [replayed] = await tx`SELECT title, call_count FROM mcp_client_conversations
        WHERE user_id = ${user.id} AND conversation_id = 'safe-title'`;
      expect(replayed).toMatchObject({ title: 'Title after cutover', call_count: 2 });
      expect(await tx`SELECT id, organization_id, created_by, metadata, payload_data, occurred_at
        FROM events WHERE client_id = ${client} ORDER BY id`).toEqual(before);
      const indexes = await tx`SELECT indexname FROM pg_indexes WHERE tablename = 'mcp_client_conversations'`;
      expect(indexes.map(row => row.indexname)).toEqual(expect.arrayContaining([
        'mcp_client_conversations_actor_pkey', 'mcp_activity_actor_recent', 'mcp_activity_actor_client_recent',
      ]));
      expect(indexes.map(row => row.indexname)).not.toContain('mcp_client_conversations_recent');
      // Demonstrate that actor-scoped Recent reads back through an ordered
      // replacement index rather than scanning and sorting the projection.
      // One busy actor: the primary key alone would still need a sort.
      await tx`INSERT INTO mcp_client_conversations (user_id, client_identity, client_id, conversation_id,
          last_action, call_count, last_activity_at)
        SELECT ${user.id}, ${client}, ${client}, 'index-activity-' || n, 'run_sdk', 1,
          now() - make_interval(mins => n)
        FROM generate_series(1, 5000) AS n`;
      await tx`ANALYZE mcp_client_conversations`;
      const plan = await tx`EXPLAIN (FORMAT JSON, COSTS OFF) SELECT conversation_id
        FROM mcp_client_conversations WHERE user_id = ${user.id} AND client_id = ${client}
          AND activity_kind = 'conversation' AND call_count > 0
          AND last_activity_at > now() - interval '14 days'
        ORDER BY last_activity_at DESC LIMIT 20`;
      const planText = JSON.stringify(plan);
      expect(planText).toMatch(/mcp_activity_actor_(client_)?recent/);
      expect(planText).not.toMatch(/Seq Scan|"Node Type":"Sort"/);
      throw rollback;
    })).rejects.toBe(rollback);
  });
});
