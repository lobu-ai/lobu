/**
 * `search_memory` must never emit a null `platform` for system event rows.
 *
 * Origin bug: `platform` is COALESCE(events.connector_key,
 * connections.connector_key), and rows like "Connection needs authorization"
 * have neither — the raw null flowed into the tool output even though the
 * schema declares a non-nullable string, and the command palette crashed on
 * `.split()`. `fetchContentSnippets` must coalesce to 'lobu', same as
 * `toExactContentSnippet`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../__tests__/setup/test-fixtures';
import { initWorkspaceProvider } from '../../workspace';
import { search } from '../search';

describe('search_memory null platform coalesce', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
    await seedSystemEntityTypes();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it("coalesces a null platform on connectionless system rows to 'lobu'", async () => {
    const org = await createTestOrganization({ name: 'Null Platform Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');

    // Faithful system row: no connector_key, no connection, no author, no URL.
    // createTestEvent cannot express this (it defaults connector_key), so
    // insert directly.
    const sql = getTestDb();
    const [row] = await sql`
      INSERT INTO events (
        organization_id, entity_ids, origin_id, title,
        payload_type, payload_text, connector_key, connection_id,
        author_name, source_url
      ) VALUES (
        ${org.id}, '{}'::bigint[], 'null-platform-probe-origin',
        'Connection needs authorization',
        'text', 'Ziraat null platform probe row',
        NULL, NULL, NULL, NULL
      )
      RETURNING id
    `;

    const result = await search(
      {
        query: 'Ziraat null platform probe',
        include_content: true,
        content_limit: 5,
        min_similarity: 0,
      },
      {} as Parameters<typeof search>[1],
      {
        organizationId: org.id,
        userId: user.id,
      } as Parameters<typeof search>[2]
    );

    const item = (result.content ?? []).find((c) => c.id === Number(row.id));
    expect(item).toBeDefined();
    expect(item?.platform).toBe('lobu');
  });
});
