/**
 * Integration smoke for the `query_sdk` / `run_sdk` / memory tool surface.
 * Read-only Proxy semantics live in the sandbox unit
 * tests; this file guards the MCP surface annotations and the public-org
 * visitor read-only filter.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { get, mcpListTools, mcpRequest, mcpToolsCall, post } from '../../setup/test-helpers';

interface QuerySqlResult {
  title?: string;
  rows: Array<Record<string, unknown>>;
  columns: Array<{ name: string; type: string }>;
  total_count: number;
  has_more: boolean;
}

describe('MCP query_sdk / run_sdk tool surface', () => {
  let token: string;
  let ownerUserId: string;
  let oauthClientId: string;
  let ownerOrgId: string;
  let ownerSlug: string;
  let publicSlug: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Query Tool Org', slug: 'query-tool-org' });
    ownerOrgId = org.id;
    ownerSlug = org.slug;
    const owner = await createTestUser({ email: 'query-tool@test.example.com' });
    ownerUserId = owner.id;
    await addUserToOrganization(owner.id, org.id, 'owner');
    const oauthClient = await createTestOAuthClient();
    oauthClientId = oauthClient.client_id;
    token = (await createTestAccessToken(owner.id, org.id, oauthClient.client_id, { scope: 'mcp:read mcp:write mcp:admin' })).token;
    const publicOrg = await createTestOrganization({
      name: 'Query Tool Public',
      slug: 'query-tool-public',
      visibility: 'public',
    });
    publicSlug = publicOrg.slug;
  });

  it('exposes explicit SDK and memory tools with the expected annotations', async () => {
    const result = await mcpListTools({ token, orgSlug: ownerSlug });
    const byName = new Map<string, any>(result.tools.map((t: any) => [t.name, t]));
    expect(byName.has('execute')).toBe(false);

    const expectedSafetyHints = {
      // The retrieval tools mutate nothing in the workspace or in an external
      // system, so they ARE `readOnlyHint`. The audit/activity record each
      // invocation appends is server bookkeeping, not a change to the caller's
      // environment. Read ACCESS is pinned separately by `authorizationReadOnly`
      // (see tool-registry-split.test.ts).
      search_memory: [true, false, false],
      search_sdk: [true, false, false],
      query_sdk: [true, false, false],
      query_sql: [true, false, false],
      save_memory: [false, false, false],
      run_sdk: [false, true, true],
      get_approval: [true, false, false],
    } as const;

    for (const [toolName, [readOnlyHint, openWorldHint, destructiveHint]] of Object.entries(
      expectedSafetyHints
    )) {
      const annotations = byName.get(toolName)?.annotations;
      expect(annotations?.readOnlyHint, `${toolName}.readOnlyHint`).toBe(readOnlyHint);
      expect(annotations?.openWorldHint, `${toolName}.openWorldHint`).toBe(openWorldHint);
      expect(annotations?.destructiveHint, `${toolName}.destructiveHint`).toBe(
        destructiveHint
      );
    }

    for (const name of [
      'search_memory',
      'search_sdk',
      'query_sdk',
      'query_sql',
      'get_approval',
    ]) {
      expect(byName.get(name)?.annotations?.idempotentHint, `${name}.idempotentHint`).toBe(
        false
      );
    }
    expect(byName.get('run_sdk')?.inputSchema?.properties?.dry_run).toBeTruthy();
    expect(byName.has('search_knowledge')).toBe(false);
    expect(byName.has('save_knowledge')).toBe(false);
    expect(byName.has('search')).toBe(false);
    expect(byName.has('query')).toBe(false);
    expect(byName.has('run')).toBe(false);
  });

  // Authorization is explicitly pinned separately from host-facing safety
  // hints. This prevents a future annotation refactor from silently hiding an
  // audited retrieval tool from a read-only client.
  it('keeps audited-read tools reachable with only mcp:read', async () => {
    const readOnly = await createTestAccessToken(ownerUserId, ownerOrgId, oauthClientId, {
      scope: 'mcp:read',
    });
    const result = await mcpListTools({ token: readOnly.token, orgSlug: ownerSlug });
    const names = new Set(result.tools.map((t) => t.name));

    for (const name of [
      'search_memory',
      'search_sdk',
      'query_sdk',
      'query_sql',
      'get_approval',
    ]) {
      expect(names.has(name), `${name} must list for an mcp:read token`).toBe(true);
    }
    // Proves the read-only filter actually ran: write tools are withheld.
    expect(names.has('run_sdk')).toBe(false);
    expect(names.has('save_memory')).toBe(false);
  });

  it('does not advertise the retired legacy ChatGPT plugin manifest', async () => {
    const response = await get('/.well-known/ai-plugin.json');
    expect(response.status).toBe(404);
  });

  it('surfaces outputSchema on structured tools', async () => {
    const result = await mcpListTools({ token, orgSlug: ownerSlug });
    const byName = new Map<string, any>(result.tools.map((t: any) => [t.name, t]));

    // Tools that declare an outputSchema carry it through to the listing...
    expect(byName.get('search_sdk')?.outputSchema?.type).toBe('object');
    expect(byName.get('search_memory')?.outputSchema?.type).toBe('object');
    expect(byName.get('save_memory')?.outputSchema?.type).toBe('object');
    expect(byName.get('query_sql')?.outputSchema?.type).toBe('object');
    // ...including union-result tools: the MCP spec requires outputSchema to be
    // an OBJECT schema, so even a discriminated `Type.Union` result must carry
    // top-level `type: "object"` (a bare `anyOf` — TypeBox's default union
    // serialization — is what a validating host rejects). The variants stay in
    // `anyOf` so the client can still tell which one applied.
    const querySdkOut = byName.get('query_sdk')?.outputSchema;
    expect(querySdkOut?.type).toBe('object');
  });

  it('records query_sql audit rows in the append-only events ledger', async () => {
    await mcpToolsCall(
      'query_sql',
      { sql: 'SELECT id, organization_id FROM events', sort_by: 'id', limit: 1 },
      { token, orgSlug: ownerSlug }
    );

    const sql = getDb();
    const rows = await sql<
      Array<{
        semantic_type: string;
        origin_type: string | null;
        payload_type: string;
        payload_data: Record<string, unknown>;
        metadata: Record<string, unknown>;
      }>
    >`
      SELECT semantic_type, origin_type, payload_type, payload_data, metadata
      FROM events
      WHERE organization_id = ${ownerOrgId}
        AND semantic_type = 'audit'
        AND origin_type = 'tool_invocation'
        AND payload_data->>'tool_name' = 'query_sql'
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload_type).toBe('empty');
    expect(rows[0].metadata.category).toBe('audit');
    expect(rows[0].payload_data.success).toBe(true);
    expect(rows[0].payload_data.sql_sha256).toEqual(expect.any(String));
    expect(rows[0].payload_data.sql_preview_redacted).toContain('SELECT id');
    expect(rows[0].payload_data).not.toHaveProperty('rows');
  });

  it('executes tableless SQL with sorting and pagination through MCP', async () => {
    const result = await mcpToolsCall<QuerySqlResult>(
      'query_sql',
      {
        title: '  Recent rows  ',
        sql: 'SELECT generate_series(1, 25) AS row_number',
        sort_by: 'row_number',
        sort_order: 'desc',
        limit: 5,
        offset: 5,
      },
      { token, orgSlug: ownerSlug }
    );

    expect(result.rows.map((row) => row.row_number)).toEqual([20, 19, 18, 17, 16]);
    expect(result.columns).toEqual([{ name: 'row_number', type: 'integer' }]);
    expect(result.total_count).toBe(25);
    expect(result.has_more).toBe(true);
    expect(result.title).toBe('Recent rows');
  });

  it('preserves query_sql titles without viewer-role metadata on structured errors', async () => {
    const response = await mcpRequest<any>(
      'tools/call',
      {
        name: 'query_sql',
        arguments: {
          title: '  Invalid query  ',
          sql: 'SELECT 1 AS row_number',
          sort_by: 'not-valid',
        },
      },
      { token, orgSlug: ownerSlug }
    );

    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent?.title).toBe('Invalid query');
    expect(response.result?._meta?.['lobu/member-role']).toBeUndefined();
  });

  it('preserves search_memory titles when no entity is found', async () => {
    const response = await mcpRequest<any>(
      'tools/call',
      {
        name: 'search_memory',
        arguments: {
          title: '  Missing company  ',
          entity_id: 2_147_483_647,
        },
      },
      { token, orgSlug: ownerSlug }
    );

    expect(response.result?.structuredContent?.title).toBe('Missing company');
  });

  it('executes searched tableless CTEs without shifting parameter indexes', async () => {
    const result = await mcpToolsCall<QuerySqlResult>(
      'query_sql',
      {
        sql: "WITH labels(label) AS (VALUES ('Alpha'), ('Beta'), ('Gamma')) SELECT label FROM labels",
        search_term: 'et',
        search_columns: ['label'],
      },
      { token, orgSlug: ownerSlug }
    );

    expect(result.rows).toEqual([{ label: 'Beta' }]);
    expect(result.columns).toEqual([{ name: 'label', type: 'text' }]);
    expect(result.total_count).toBe(1);
    expect(result.has_more).toBe(false);
  });

  it('hides write tools from anonymous visitors on a public /mcp/{slug}', async () => {
    // Initialize an anonymous session against the scoped public-org URL.
    const initRes = await post(`/mcp/${publicSlug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'public-visitor', version: '1.0' },
        },
      },
    });
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const listRes = await post(`/mcp/${publicSlug}`, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      headers: { 'mcp-session-id': sessionId! },
    });
    const body = await listRes.json();
    const names = (body.result?.tools as Array<{ name: string }>).map((t) => t.name);

    // Public-readable tools survive: search_memory and search_sdk (SDK discovery).
    expect(names).toContain('search_memory');
    expect(names).toContain('search_sdk');
    // Write surface and admin-tier reads must be filtered out for anonymous
    // visitors — including `query_sdk`, `run_sdk`, `query_sql`.
    expect(names).not.toContain('save_memory');
    expect(names).not.toContain('save_knowledge');
    expect(names).not.toContain('run_sdk');
    expect(names).not.toContain('query_sdk');
    expect(names).not.toContain('query_sql');

    // The public path builds its own listing (publicOnly + read tier), so it
    // needs its own annotation assertion: a regression here is invisible to the
    // authenticated case above and reaches unauthenticated clients directly.
    const publicTools = body.result?.tools as Array<{
      name: string;
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    }>;
    for (const name of ['search_memory', 'search_sdk']) {
      const annotations = publicTools.find((t) => t.name === name)?.annotations;
      expect(annotations?.readOnlyHint, `public ${name}.readOnlyHint`).toBe(true);
      expect(annotations?.destructiveHint, `public ${name}.destructiveHint`).toBe(false);
    }
  });
});
