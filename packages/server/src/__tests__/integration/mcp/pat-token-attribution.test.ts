import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import { type AuthContext, executeTool } from '../../../tools/execute';
import { buildContentItems } from '../../../tools/get_content/render';
import type { ContentRow } from '../../../tools/get_content/types';
import logger from '../../../utils/logger';
import { SCOPE_CHECK_NOT_APPLICABLE } from '../../../auth/tool-access';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../../setup/test-fixtures';
import { mcpToolsCall, post } from '../../setup/test-helpers';

const TOKEN_NAME = 'ci-nightly-export';

interface AuditRow {
  id: string;
  client_id: string | null;
  metadata: Record<string, unknown>;
}

async function auditRowFor(orgId: string, sqlText: string): Promise<AuditRow> {
  const rows = await getDb()<AuditRow[]>`
    SELECT id::text, client_id, metadata
    FROM events
    WHERE organization_id = ${orgId}
      AND semantic_type = 'audit'
      AND origin_type = 'tool_invocation'
      AND payload_data->>'tool_name' = 'query_sql'
      AND payload_data->'request'->>'sql' = ${sqlText}
    ORDER BY id DESC
    LIMIT 1
  `;
  if (!rows[0]) throw new Error(`no audit row for ${sqlText}`);
  return rows[0];
}

describe('PAT calls name their token in the feed', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let ownerId: string;
  let memberId: string;
  let patToken: string;
  let oauthToken: string;
  let oauthClientId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    org = await createTestOrganization({ name: 'PAT Attribution Org', slug: 'pat-attribution-org' });
    const owner = await createTestUser({ email: 'pat-owner@test.example.com' });
    const member = await createTestUser({ email: 'pat-member@test.example.com' });
    ownerId = owner.id;
    memberId = member.id;
    await addUserToOrganization(owner.id, org.id, 'owner');
    await addUserToOrganization(member.id, org.id, 'member');
    patToken = (
      await createTestPAT(owner.id, org.id, { scope: 'mcp:read mcp:write', name: TOKEN_NAME })
    ).token;
    const client = await createTestOAuthClient();
    oauthClientId = client.client_id;
    oauthToken = (
      await createTestAccessToken(owner.id, org.id, client.client_id, { scope: 'mcp:read mcp:write' })
    ).token;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function readerCtx(userId: string, memberRole: string): AuthContext {
    return {
      organizationId: org.id,
      tokenOrganizationId: null,
      userId,
      memberRole,
      agentId: null,
      requestedAgentId: null,
      isAuthenticated: true,
      clientId: null,
      scopes: [...SCOPE_CHECK_NOT_APPLICABLE],
      tokenType: 'session',
      requestUrl: 'http://localhost/api/pat-attribution-org/read_knowledge',
      baseUrl: 'http://localhost',
      scopedToOrg: true,
      allowCrossOrg: false,
      grantedOrganizationIds: null,
      directSearchFederation: false,
    };
  }

  async function readAs(eventId: string, ctx: AuthContext) {
    const result = (await executeTool(
      'read_knowledge',
      { content_ids: [Number(eventId)], limit: 1 },
      {} as Env,
      ctx
    )) as { content: Array<{ client_name: string | null; metadata: Record<string, unknown> }> };
    return result.content[0];
  }

  it('records the token name and no synthetic client id on a REST query_sql audit row', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const sqlText = 'SELECT 1 AS pat_probe';
    const response = await post(`/api/${org.slug}/query_sql`, {
      token: patToken,
      body: { sql: sqlText },
    });
    expect(response.status).toBe(200);

    const row = await auditRowFor(org.id, sqlText);
    expect(row.metadata.token_type).toBe('pat');
    expect(row.metadata.token_name).toBe(TOKEN_NAME);
    expect(row.client_id).toBeNull();
    // The audit insert no longer trips events_client_id_fkey and retries.
    expect(
      warn.mock.calls.some((call) =>
        call.some((part) => typeof part === 'string' && part.includes('retrying insert with client_id NULL'))
      )
    ).toBe(false);
  });

  it('names the token to workspace members and hides it from non-member reads', async () => {
    const sqlText = 'SELECT 1 AS visibility_probe';
    const response = await post(`/api/${org.slug}/query_sql`, {
      token: patToken,
      body: { sql: sqlText },
    });
    expect(response.status).toBe(200);
    const row = await auditRowFor(org.id, sqlText);

    const asOwner = await readAs(row.id, readerCtx(ownerId, 'owner'));
    expect(asOwner.client_name).toBe(TOKEN_NAME);
    const asMember = await readAs(row.id, readerCtx(memberId, 'member'));
    expect(asMember.client_name).toBe(TOKEN_NAME);

    // A non-member read (public workspace) gets no private attribution.
    const [raw] = await getDb()<ContentRow[]>`SELECT * FROM events WHERE id = ${row.id}`;
    const [publicItem] = await buildContentItems({
      sql: getDb(),
      rawContent: [raw],
      organizationId: org.id,
      ownerSlug: org.slug,
      baseUrl: undefined,
      includePrivateAttribution: false,
    });
    expect(publicItem.client_name).toBeNull();
    expect(publicItem.metadata).not.toHaveProperty('token_name');
  });

  it('refreshes the token name on an established MCP session after a rename', async () => {
    const { token } = await createTestPAT(ownerId, org.id, {
      scope: 'mcp:read mcp:write',
      name: 'before-rename',
    });
    const options = { token, orgSlug: org.slug };
    const firstSql = 'SELECT 1 AS before_rename';
    await mcpToolsCall('query_sql', { sql: firstSql }, options);
    const before = await auditRowFor(org.id, firstSql);
    expect(before.metadata.token_name).toBe('before-rename');

    await getDb()`
      UPDATE personal_access_tokens SET name = 'after-rename'
      WHERE user_id = ${ownerId} AND organization_id = ${org.id} AND name = 'before-rename'
    `;

    const secondSql = 'SELECT 1 AS after_rename';
    await mcpToolsCall('query_sql', { sql: secondSql }, options);
    const after = await auditRowFor(org.id, secondSql);
    expect(after.metadata.token_name).toBe('after-rename');
    expect(after.client_id).toBeNull();
    expect(before.metadata.mcp_session_id).toEqual(expect.any(String));
    expect(after.metadata.mcp_session_id).toBe(before.metadata.mcp_session_id);
    expect((await auditRowFor(org.id, firstSql)).metadata.token_name).toBe('before-rename');
  });

  it('leaves OAuth audit rows on their registered client', async () => {
    const sqlText = 'SELECT 1 AS oauth_probe';
    const response = await post(`/api/${org.slug}/query_sql`, {
      token: oauthToken,
      body: { sql: sqlText },
    });
    expect(response.status).toBe(200);

    const row = await auditRowFor(org.id, sqlText);
    expect(row.client_id).toBe(oauthClientId);
    expect(row.metadata).not.toHaveProperty('token_name');
    const asMember = await readAs(row.id, readerCtx(memberId, 'member'));
    expect(asMember.client_name).toBe('Test Client');
  });
});
