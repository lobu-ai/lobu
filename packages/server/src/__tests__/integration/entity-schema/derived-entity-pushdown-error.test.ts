/**
 * A connector `query()` failure behind a derived ("view") entity type must
 * reach the caller as a READABLE tool error — never on a status whose body the
 * edge in front of the gateway replaces with its own (see `utils/errors.ts`).
 *
 * Both derived read seams are covered, because both only ever handled
 * `querySqlImpl`'s SOFT error shape while the connection-pushdown branch
 * THROWS:
 *   - `manage_entity` list  → `listDerivedEntities`
 *   - `resolve_path`        → `resolveDerivedLeaf`
 *
 * `hackernews` is a bundled connector with no `query` handler, so
 * `ConnectorRuntime.query`'s default throws `"<key> does not support live
 * queries"` — the first production report, reproduced without a fixture
 * connector.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';
import { TestApiClient } from '../../setup/test-mcp-client';

/** Statuses the edge in front of the gateway answers with its own body. */
const CDN_SUBSTITUTED_STATUSES = [502, 504];

describe('derived entity view over a failing connector query', () => {
  let orgSlug: string;
  let token: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Derived Pushdown Error' });
    orgSlug = org.slug;
    const user = await createTestUser({ email: 'derived-pushdown@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const db = getTestDb();
    await db`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, visibility, created_by, created_at, updated_at)
      VALUES
        (${org.id}, 'hackernews', 'no-query-source', 'No query source', 'active', 'org', ${user.id}, NOW(), NOW())
    `;

    const api = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });
    await api.entity_schema.createType({
      slug: 'external-view',
      name: 'External view',
      backing: { sql: 'SELECT 1 AS id, 1 AS slug', connection: 'no-query-source' },
    });

    const oauthClient = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, oauthClient.client_id)).token;
  }, 180_000);

  async function callTool(tool: string, body: Record<string, unknown>) {
    const response = await post(`/api/${orgSlug}/${tool}`, { body, token });
    const text = await response.text();
    let parsed: { error?: unknown; code?: unknown } | undefined;
    try {
      parsed = JSON.parse(text) as { error?: unknown; code?: unknown };
    } catch {
      parsed = undefined;
    }
    return { status: response.status, text, parsed };
  }

  it('surfaces the connector reason on the derived LIST seam', async () => {
    const res = await callTool('manage_entity', {
      action: 'list',
      entity_type: 'external-view',
    });
    expect(CDN_SUBSTITUTED_STATUSES).not.toContain(res.status);
    expect(res.parsed?.error).toEqual(
      expect.stringContaining('hackernews does not support live queries')
    );
    expect(res.parsed?.code).toBeTruthy();
  }, 180_000);

  it('surfaces the connector reason on the derived DETAIL seam', async () => {
    const res = await callTool('resolve_path', {
      path: `/${orgSlug}/external-view/anything`,
    });
    expect(CDN_SUBSTITUTED_STATUSES).not.toContain(res.status);
    expect(res.parsed?.error).toEqual(
      expect.stringContaining('hackernews does not support live queries')
    );
  }, 180_000);
});
