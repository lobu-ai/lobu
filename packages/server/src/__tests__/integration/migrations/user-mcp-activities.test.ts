import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestOrganization, createTestUser, createTestOAuthClient } from '../../setup/test-fixtures';

describe('user MCP activity ownership migration', () => {
  beforeAll(cleanupTestDatabase);

  it('splits mixed-user summaries, preserves event links, and safely replays', async () => {
    const sql = getDb();
    const org = await createTestOrganization({ slug: 'history-migration-workspace' });
    const owner = await createTestUser({ email: 'history-migration-owner@example.test' });
    const other = await createTestUser({ email: 'history-migration-other@example.test' });
    const clientId = (await createTestOAuthClient({ owner_user_id: owner.id })).client_id;
    const migration = readFileSync(new URL('../../../../../../db/migrations/20260907150000_user_mcp_activities.sql', import.meta.url), 'utf8').split('-- migrate:down')[0]!;
    await sql.begin(async (tx) => {
      // The historical schema exists only inside this migration fixture.
      await tx.unsafe(`CREATE TABLE mcp_client_conversations (
        organization_id text, client_identity text, conversation_id text,
        transport_session_ids jsonb, client_id text, user_id text, title text, client_software_id text
      )`);
      for (const [userId, activity] of [[owner.id, 'shared-activity'], [other.id, 'shared-activity'], [owner.id, 'owned-activity']]) {
        const transportId = activity === 'owned-activity' ? activity : 'early-transport';
        await tx`
          INSERT INTO user_tool_invocations (user_id, client_id, activity_id,
            tool_name, success, duration_ms, payload_data, metadata)
          VALUES (${userId}, ${clientId}, ${activity}, 'query_sdk', true, 1,
            '{}'::jsonb, ${tx.json({ mcp_conversation_id: activity, mcp_session_id: transportId })})
        `;
        await tx`
          INSERT INTO mcp_client_conversations
            (organization_id, client_identity, conversation_id, transport_session_ids, client_id, user_id, title, client_software_id)
          VALUES (${org.id}, ${clientId}, ${activity}, ${tx.json([transportId])},
            ${clientId}, ${userId}, ${activity === 'shared-activity' ? 'Mixed private title' : 'Owned title'}, 'lobu-cli')
        `;
      }
      const [event] = await tx`
        INSERT INTO events (organization_id, origin_id, origin_type, payload_type, payload_data, client_id, metadata)
        VALUES (${org.id}, 'history-migration-event', 'notification', 'empty', '{}'::jsonb,
          ${clientId}, '{"mcp_session_id":"early-transport"}'::jsonb)
        RETURNING id, metadata
      `;
      await tx`DELETE FROM oauth_clients WHERE id = ${clientId}`;
      await tx.unsafe(migration);
      await tx.unsafe(migration);
      const archived = await tx`SELECT client_software_id FROM user_mcp_activities WHERE client_identity = ${clientId}`;
      expect(archived.every(row => row.client_software_id === 'lobu-cli')).toBe(true);
      const rows = await tx`
        SELECT user_id, activity_id, activity_kind, title, call_count::integer
        FROM user_mcp_activities WHERE client_identity = ${clientId}
      `;
      expect(rows).toHaveLength(3);
      expect(rows.filter(row => row.activity_id === 'shared-activity')).toEqual(expect.arrayContaining([
        { user_id: owner.id, activity_id: 'shared-activity', activity_kind: 'conversation', title: null, call_count: 1 },
        { user_id: other.id, activity_id: 'shared-activity', activity_kind: 'conversation', title: null, call_count: 1 },
      ]));
      expect(rows.find(row => row.activity_id === 'owned-activity')).toMatchObject({
        activity_kind: 'session', title: 'Owned title',
      });
      const [scope] = await tx`
        SELECT transport_session_ids FROM mcp_activity_event_scopes
        WHERE organization_id = ${org.id} AND client_identity = ${clientId}
          AND activity_id = 'shared-activity'
      `;
      expect(scope.transport_session_ids).toEqual(['early-transport']);
      const [unchanged] = await tx`SELECT metadata FROM events WHERE id = ${event.id}`;
      expect(unchanged.metadata).toEqual(event.metadata);
      const [retired] = await tx`SELECT to_regclass('public.mcp_client_conversations') AS name`;
      expect(retired.name).toBeNull();
    });
  });
});
