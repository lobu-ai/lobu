import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestOAuthClient, createTestOrganization, createTestUser, seedSystemEntityTypes } from '../../setup/test-fixtures';

const migration = readFileSync(new URL(
  '../../../../../../db/migrations/20261011160000_mcp_conversation_workspaces.sql', import.meta.url,
), 'utf8').split('-- migrate:down')[0]!;

describe('MCP conversation workspaces migration', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
  });

  it('attributes recent conversations from their recorded workspace and workspace events', async () => {
    const first = await createTestOrganization({ slug: 'conversation-workspaces-first' });
    const second = await createTestOrganization({ slug: 'conversation-workspaces-second' });
    const user = await createTestUser({ email: 'conversation-workspaces@example.test' });
    const other = await createTestUser({ email: 'conversation-workspaces-other@example.test' });
    const client = (await createTestOAuthClient({ owner_user_id: user.id })).client_id;
    const rollback = new Error('rollback isolated migration fixture');

    await expect(getDb().begin(async tx => {
      // Reconstruct the retired schema only within this rolled-back transaction.
      await tx.unsafe(`
        DROP TABLE mcp_client_conversation_workspaces;
        ALTER TABLE mcp_client_conversations
          ADD COLUMN organization_id text REFERENCES organization(id) ON DELETE CASCADE;
      `);
      async function conversation(actor: string, activity: string, workspace: string | null) {
        await tx`
          INSERT INTO mcp_client_conversations (organization_id, user_id, client_identity,
            client_id, conversation_id, last_action, call_count)
          VALUES (${workspace}, ${actor}, ${client}, ${client}, ${activity}, 'run_sdk', 1)
        `;
      }
      async function event(actor: string | null, workspace: string, activity: string, age = '1 hour') {
        await tx`
          INSERT INTO events (organization_id, created_by, client_id, semantic_type,
            origin_type, metadata, payload_data, created_at)
          VALUES (${workspace}, ${actor}, ${client}, 'audit', 'tool_invocation',
            ${tx.json({ mcp_conversation_id: activity })}, ${tx.json({ tool_name: 'run_sdk' })},
            now() - ${age}::interval)
        `;
      }

      await conversation(user.id, 'bound', first.id);
      await conversation(user.id, 'spans-both', null);
      await event(user.id, first.id, 'spans-both');
      await event(null, second.id, 'spans-both');
      await conversation(user.id, 'account-only', null);
      await conversation(user.id, 'too-old', null);
      await event(user.id, second.id, 'too-old', '30 days');
      // Two users share a client-supplied id: an unattributed event is ambiguous.
      await conversation(user.id, 'shared-id', null);
      await conversation(other.id, 'shared-id', null);
      await event(null, second.id, 'shared-id');
      await event(other.id, first.id, 'shared-id');
      // An ambiguous event must not discard or refresh a known actor's call.
      await event(null, first.id, 'shared-id', '1 minute');
      // Explicit actor evidence remains valid even when both actors used the
      // same client-supplied conversation id in the same workspace.
      await conversation(user.id, 'shared-explicit', null);
      await conversation(other.id, 'shared-explicit', null);
      await event(user.id, first.id, 'shared-explicit');
      await event(other.id, first.id, 'shared-explicit');

      await tx.unsafe(migration);

      const rows = await tx`
        SELECT user_id, conversation_id, organization_id
        FROM mcp_client_conversation_workspaces
      `;
      const sorted = (list: Array<Record<string, string>>) => list
        .map(row => [row.conversation_id, row.user_id, row.organization_id].join(' '))
        .sort();
      expect(sorted(rows.map(row => ({ ...row })))).toEqual(sorted([
        { user_id: user.id, conversation_id: 'bound', organization_id: first.id },
        { user_id: user.id, conversation_id: 'shared-explicit', organization_id: first.id },
        { user_id: other.id, conversation_id: 'shared-explicit', organization_id: first.id },
        { user_id: other.id, conversation_id: 'shared-id', organization_id: first.id },
        { user_id: user.id, conversation_id: 'spans-both', organization_id: first.id },
        { user_id: user.id, conversation_id: 'spans-both', organization_id: second.id },
      ]));
      const [knownActor] = await tx`
        SELECT last_activity_at = now() - interval '1 hour' AS retained_timestamp
        FROM mcp_client_conversation_workspaces
        WHERE user_id = ${other.id} AND client_identity = ${client}
          AND conversation_id = 'shared-id' AND organization_id = ${first.id}
      `;
      expect(knownActor.retained_timestamp).toBe(true);
      const [column] = await tx`
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'mcp_client_conversations' AND column_name = 'organization_id'
      `;
      expect(column).toBeUndefined();

      // Replaying the migration is a no-op.
      await tx.unsafe(migration);
      throw rollback;
    })).rejects.toBe(rollback);
  });
});
