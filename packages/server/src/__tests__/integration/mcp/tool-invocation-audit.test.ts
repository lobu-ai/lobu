import { createHash } from 'node:crypto';
import type { ContentItem } from '@lobu/connector-sdk';
import { REDACTED_SENTINEL } from '@lobu/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { SCOPE_CHECK_NOT_APPLICABLE } from '../../../auth/tool-access';
import { recordToolInvocationAudit } from '../../../tools/audit';
import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import { type AuthContext, executeTool } from '../../../tools/execute';
import { hydrateToolInvocationRequests } from '../../../tools/get_content/render';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { ensureMcpSession, mcpToolsCall } from '../../setup/test-helpers';

interface AuditRow {
  id: string | number;
  payload_data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

async function latestAuditRow(orgId: string, toolName: string): Promise<AuditRow | null> {
  const sql = getDb();
  const rows = await sql<AuditRow[]>`
    SELECT id, payload_data, metadata
    FROM events
    WHERE organization_id = ${orgId}
      AND semantic_type = 'audit'
      AND origin_type = 'tool_invocation'
      AND payload_data->>'tool_name' = ${toolName}
    ORDER BY id DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function readAuditEvent(eventId: string | number, ctx: AuthContext) {
  const result = (await executeTool(
    'read_knowledge',
    { content_ids: [Number(eventId)], limit: 1 },
    {} as Env,
    ctx
  )) as { content: Array<{ payload_data: Record<string, unknown> }> };
  return result.content[0]?.payload_data ?? {};
}

describe('tool invocation audit coverage', () => {
  let token: string;
  let orgId: string;
  let orgSlug: string;
  let ownerId: string;
  let clientId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({
      name: 'Audit Coverage Org',
      slug: 'audit-coverage-org',
    });
    orgId = org.id;
    orgSlug = org.slug;
    const owner = await createTestUser({ email: 'audit-coverage@test.example.com' });
    ownerId = owner.id;
    await addUserToOrganization(owner.id, org.id, 'owner');
    const oauthClient = await createTestOAuthClient();
    clientId = oauthClient.client_id;
    token = (
      await createTestAccessToken(owner.id, org.id, oauthClient.client_id, {
        scope: 'mcp:read mcp:write mcp:admin',
      })
    ).token;
  });

  function authCtxFor(tokenType: 'oauth' | 'pat' | 'session'): AuthContext {
    return {
      organizationId: orgId,
      tokenOrganizationId: tokenType === 'session' ? null : orgId,
      userId: ownerId,
      memberRole: 'owner',
      agentId: null,
      requestedAgentId: null,
      isAuthenticated: true,
      clientId: tokenType === 'oauth' ? clientId : null,
      scopes:
        tokenType === 'session'
          ? [...SCOPE_CHECK_NOT_APPLICABLE]
          : ['mcp:read', 'mcp:write', 'mcp:admin'],
      tokenType,
      requestUrl: 'http://localhost/lobu/tools/test',
      baseUrl: 'http://localhost',
      scopedToOrg: false,
      allowCrossOrg: tokenType === 'oauth',
      grantedOrganizationIds: tokenType === 'oauth' ? [orgId] : null,
      directSearchFederation: false,
    };
  }

  it('audits a generic OAuth MCP call with its session id', async () => {
    await mcpToolsCall(
      'search_memory',
      { query: 'audit coverage probe', limit: 1 },
      { token, orgSlug }
    );
    const sessionId = await ensureMcpSession({ token, orgSlug });

    const row = await latestAuditRow(orgId, 'search_memory');
    expect(row).not.toBeNull();
    expect(row!.payload_data.success).toBe(true);
    expect(row!.payload_data.args_sha256).toEqual(expect.any(String));
    // The preview keeps the call SHAPE (keys), never free-text values — a
    // search query is user content and could carry a pasted secret.
    expect(row!.payload_data.args_preview_redacted).toContain('"query"');
    expect(row!.payload_data.args_preview_redacted).not.toContain('audit coverage probe');
    expect(row!.payload_data.args_preview_redacted).toContain(REDACTED_SENTINEL);
    expect(row!.payload_data).not.toHaveProperty('content');
    expect(row!.payload_data).not.toHaveProperty('request');
    expect(row!.metadata.mcp_session_id).toBe(sessionId);
  });

  it('records the requested org_slug on query_sql audit rows', async () => {
    const result = (await executeTool(
      'query_sql',
      { sql: 'SELECT id FROM events', sort_by: 'id', limit: 1, org_slug: orgSlug },
      {} as Env,
      authCtxFor('oauth')
    )) as { error?: string };
    expect(result.error).toBeUndefined();

    const row = await latestAuditRow(orgId, 'query_sql');
    expect(row).not.toBeNull();
    expect(row!.payload_data.org_slug).toBe(orgSlug);
    expect(row!.payload_data.request_status).toBe('complete');
    expect(row!.payload_data.request).toEqual({
      sql: 'SELECT id FROM events',
      sort_by: 'id',
      limit: 1,
      org_slug: orgSlug,
    });
    expect(row!.payload_data).not.toHaveProperty('response');
    expect(row!.metadata).toHaveProperty('mcp_session_id', null);

    expect(await readAuditEvent(row!.id, authCtxFor('session'))).toMatchObject({
      request_status: 'complete',
      request: {
        sql: 'SELECT id FROM events',
        sort_by: 'id',
        limit: 1,
        org_slug: orgSlug,
      },
    });
  });

  it('keeps the request on the event but exposes it only through the authorized event read path', async () => {
    const row = await latestAuditRow(orgId, 'query_sql');
    expect(row).not.toBeNull();
    const eventId = String(row!.id);

    const sqlResult = (await executeTool(
      'query_sql',
      {
        sql: `SELECT payload_data FROM events WHERE id = ${eventId}`,
        limit: 1,
      },
      {} as Env,
      authCtxFor('session')
    )) as { rows: Array<{ payload_data: Record<string, unknown> }> };
    expect(sqlResult.rows[0].payload_data).not.toHaveProperty('request');

    const memberPayload = await readAuditEvent(eventId, {
      ...authCtxFor('session'),
      userId: 'another-user',
      memberRole: 'member',
    });
    // A non-author member gets no request and no size — only the retention
    // outcome, which names what the ledger did rather than any part of the call.
    expect(memberPayload).not.toHaveProperty('request');
    expect(memberPayload).not.toHaveProperty('request_bytes');
    expect(memberPayload.request_status).toBe('complete');

    const adminPayload = await readAuditEvent(eventId, {
      ...authCtxFor('session'),
      userId: 'another-user',
      memberRole: 'admin',
    });
    expect(adminPayload.request).toEqual({
      sql: 'SELECT id FROM events',
      sort_by: 'id',
      limit: 1,
      org_slug: orgSlug,
    });
  });

  it('does not inline exact requests into audit list results', async () => {
    const row = await latestAuditRow(orgId, 'query_sql');
    expect(row).not.toBeNull();
    // Guard the guard: the stored row must actually carry a request, or the
    // absence assertions below would pass on a row that never had one.
    expect(row!.payload_data).toHaveProperty('request');

    const result = (await executeTool(
      'read_knowledge',
      { semantic_type: 'audit', sort_by: 'date', sort_order: 'desc', limit: 100 },
      {} as Env,
      authCtxFor('session')
    )) as {
      content: Array<{ id: string | number; payload_data: Record<string, unknown> }>;
    };
    const listed = result.content.find((item) => String(item.id) === String(row!.id));
    expect(listed).toBeDefined();
    expect(listed!.payload_data).not.toHaveProperty('request');
    expect(listed!.payload_data).not.toHaveProperty('request_bytes');
    // `request_status` DOES survive a list read: it is the only signal a card
    // has that a body exists to open, and without it the UI cannot offer any
    // route to the exact-id read that serves one (to the author or an admin).
    expect(listed!.payload_data.request_status).toBe('complete');
  });

  it('restores every copy when an exact read contains duplicate event ids', async () => {
    const row = await latestAuditRow(orgId, 'query_sql');
    expect(row).not.toBeNull();
    const firstPayload = structuredClone(row!.payload_data);
    const secondPayload = structuredClone(row!.payload_data);
    const items = [
      {
        id: Number(row!.id),
        semantic_type: 'audit',
        origin_type: 'tool_invocation',
        payload_data: firstPayload,
      },
      {
        id: Number(row!.id),
        semantic_type: 'audit',
        origin_type: 'tool_invocation',
        payload_data: secondPayload,
      },
    ];

    await hydrateToolInvocationRequests({
      sql: getDb(),
      // Only the four discriminating fields above are read; the rest of
      // ContentItem is irrelevant to the strip/restore index.
      items: items as unknown as ContentItem[],
      organizationId: orgId,
      userId: ownerId,
      memberRole: 'owner',
      restoreRequests: true,
    });

    expect(firstPayload).toHaveProperty('request');
    expect(secondPayload).toHaveProperty('request');
  });

  it('strips `request` from audit rows ONLY, leaving other events untouched', async () => {
    // `payload_data` is caller-shaped everywhere else (connector payloads,
    // save_memory structured data), so the query_sql projection must key off
    // the audit discriminators rather than deleting the name globally.
    const sql = getDb();
    const [own] = await sql<Array<{ id: string }>>`
      INSERT INTO events (organization_id, origin_id, semantic_type, payload_type, payload_data)
      VALUES (${orgId}, ${`audit-strip-scope:${Date.now()}`}, 'note', 'empty',
              ${sql.json({ request: { method: 'GET' } })})
      RETURNING id
    `;

    const result = (await executeTool(
      'query_sql',
      { sql: `SELECT payload_data FROM events WHERE id = ${own.id}`, limit: 1 },
      {} as Env,
      authCtxFor('session')
    )) as { rows: Array<{ payload_data: Record<string, unknown> }> };
    expect(result.rows[0].payload_data).toEqual({ request: { method: 'GET' } });
  });

  it('retains the exact request while the preview keeps its redaction policy', async () => {
    const sql = "SELECT id, secret FROM events WHERE title = 'the token bucket'";
    await recordToolInvocationAudit({
      toolName: 'query_sql',
      args: {
        sql: `${sql}; -- sk_live_ABCDEFGHIJKLMNOP`,
        api_key: 'sk-live-STORED-VERBATIM',
      },
      result: { rows: [] },
      durationMs: 1,
      ctx: authCtxFor('pat') as never,
    });

    const row = await latestAuditRow(orgId, 'query_sql');
    expect(row!.payload_data.request).toEqual({
      sql: `${sql}; -- sk_live_ABCDEFGHIJKLMNOP`,
      api_key: 'sk-live-STORED-VERBATIM',
    });
    const sqlResult = (await executeTool(
      'query_sql',
      { sql: `SELECT payload_data FROM events WHERE id = ${row!.id}`, limit: 1 },
      {} as Env,
      authCtxFor('session')
    )) as { rows: Array<{ payload_data: Record<string, unknown> }> };
    expect(JSON.stringify(sqlResult.rows[0].payload_data)).not.toContain(
      'sk_live_ABCDEFGHIJKLMNOP'
    );
    expect(JSON.stringify(sqlResult.rows[0].payload_data)).not.toContain(
      'sk-live-STORED-VERBATIM'
    );
    expect(await readAuditEvent(row!.id, authCtxFor('pat'))).toMatchObject({
      request: {
        sql: `${sql}; -- sk_live_ABCDEFGHIJKLMNOP`,
        api_key: 'sk-live-STORED-VERBATIM',
      },
    });

    // The DISPLAY preview on the same row is unaffected by that contract: it
    // still drops secret shapes, and still leaves ordinary SQL vocabulary
    // (`secret`, `token`) intact rather than mangling the statement.
    const preview = row!.payload_data.sql_preview_redacted as string;
    expect(preview).toContain(sql);
    expect(preview).not.toContain('sk_live_ABCDEFGHIJKLMNOP');
    expect(preview).toContain('[redacted]');
  });

  it('does NOT write generic audit rows for browser-session tool calls', async () => {
    const before = await latestAuditRow(orgId, 'list_metrics');
    expect(before).toBeNull();

    await executeTool('list_metrics', {}, {} as Env, authCtxFor('session'));

    expect(await latestAuditRow(orgId, 'list_metrics')).toBeNull();
  });

  it('still audits query_sql for browser-session callers (detailed audit is token-type independent)', async () => {
    await executeTool(
      'query_sql',
      { sql: 'SELECT id FROM entities', sort_by: 'id', limit: 1 },
      {} as Env,
      authCtxFor('session')
    );

    const sql = getDb();
    const rows = await sql`
      SELECT id FROM events
      WHERE organization_id = ${orgId}
        AND semantic_type = 'audit'
        AND payload_data->>'tool_name' = 'query_sql'
        AND payload_data->>'sql_preview_redacted' LIKE '%FROM entities%'
    `;
    expect(rows).toHaveLength(1);
  });

  it('retains query_sdk requests for browser-session callers', async () => {
    const script = 'export default async () => ({ answer: 42 });';
    const result = (await executeTool(
      'query_sdk',
      { script },
      {} as Env,
      authCtxFor('session')
    )) as { success: boolean };
    expect(result.success).toBe(true);

    const row = await latestAuditRow(orgId, 'query_sdk');
    expect(row!.payload_data.request).toEqual({ script });
    expect(await readAuditEvent(row!.id, authCtxFor('session'))).toMatchObject({
      request: { script },
    });
  });

  it('audits a failed generic call with the error captured', async () => {
    await expect(
      executeTool(
        'manage_connections',
        { action: 'nope', token: 'must-not-reach-the-audit-log' },
        {} as Env,
        authCtxFor('pat')
      )
    ).rejects.toThrow();

    const row = await latestAuditRow(orgId, 'manage_connections');
    expect(row).not.toBeNull();
    expect(row!.payload_data.success).toBe(false);
    expect(row!.payload_data.error).toBeTruthy();
    expect(row!.payload_data.args_preview_redacted).not.toContain(
      'must-not-reach-the-audit-log'
    );
    expect(row!.payload_data.args_preview_redacted).toContain(REDACTED_SENTINEL);
    // Audit fires on FAILED validation, so `action` here carries a value the
    // schema never declared. Only DECLARED literals survive, so it must not.
    expect(row!.payload_data.args_preview_redacted).not.toContain('nope');
  });

  it('retains the declared action discriminator against the real tool schema', async () => {
    await executeTool('manage_connections', { action: 'list' }, {} as Env, authCtxFor('pat'));

    const row = await latestAuditRow(orgId, 'manage_connections');
    expect(row).not.toBeNull();
    expect(row!.payload_data.success).toBe(true);
    // `action: 'list'` is one of the tool's own compile-time literals, so it
    // carries no caller content and is readable in the ledger.
    expect(row!.payload_data.args_preview_redacted).toContain('"action":"list"');
  });

  it('args_sha256 is computed over SANITIZED args — a secret value cannot be verified against the hash', async () => {
    const argsWithSecretA = { query: 'probe', token: 'candidate-secret-A' };
    const argsWithSecretB = { query: 'probe', token: 'candidate-secret-B' };
    // `token` is not a search_sdk argument: validation rejects both calls, and
    // the audit fires on the catch path with the raw args — the exact moment a
    // raw-args hash would persist a credential-derived verifier.
    await expect(
      executeTool('search_sdk', argsWithSecretA, {} as Env, authCtxFor('pat'))
    ).rejects.toThrow();
    await expect(
      executeTool('search_sdk', argsWithSecretB, {} as Env, authCtxFor('pat'))
    ).rejects.toThrow();

    const sql = getDb();
    const rows = await sql<Array<{ payload_data: Record<string, unknown> }>>`
      SELECT payload_data FROM events
      WHERE organization_id = ${orgId}
        AND semantic_type = 'audit'
        AND payload_data->>'tool_name' = 'search_sdk'
      ORDER BY id DESC
      LIMIT 2
    `;
    expect(rows).toHaveLength(2);
    // Same call shape, different secret value → identical hash. If the raw
    // args fed the hash, the two digests would differ and either could be
    // used as an offline verifier for candidate secrets.
    expect(rows[0].payload_data.args_sha256).toBe(rows[1].payload_data.args_sha256);
    const rawHashA = createHash('sha256')
      .update(JSON.stringify(argsWithSecretA))
      .digest('hex');
    expect(rows[0].payload_data.args_sha256).not.toBe(rawHashA);
  });

  it('sentinels every caller-controlled leaf AND key — PINs, identifier-shaped values, credential-shaped keys', async () => {
    await recordToolInvocationAudit({
      toolName: 'probe_leaf_sanitization',
      args: {
        input: { pin: 123456 },
        kind: 'sk-live-credential-value',
        'sk-live-secret-as-a-key': 1,
        dry_run: true,
      },
      result: { ok: true },
      durationMs: 2,
      ctx: {
        organizationId: orgId,
        userId: ownerId,
        memberRole: 'owner',
        isAuthenticated: true,
        tokenType: 'pat',
        scopedToOrg: false,
        allowCrossOrg: false,
      } as never,
    });

    const row = await latestAuditRow(orgId, 'probe_leaf_sanitization');
    expect(row).not.toBeNull();
    const preview = String(row!.payload_data.args_preview_redacted);
    expect(preview).not.toContain('123456');
    expect(preview).not.toContain('sk-live-credential-value');
    expect(preview).not.toContain('sk-live-secret-as-a-key');
    // This probe tool has no registered schema, so NO key is trusted: the
    // whole preview collapses to sentinel structure with the boolean kept
    // (repeated sentinel keys merge; first key position, last value wins).
    expect(preview).toBe(`{"${REDACTED_SENTINEL}":true}`);
  });

  it.each(['error', 'timeout'] as const)(
    'records a result with status=%s as a failed invocation',
    async (status) => {
      const toolName = `probe_status_${status}`;
      await recordToolInvocationAudit({
        toolName,
        args: { probe: true },
        result: { status, message: `soft ${status} outcome` },
        durationMs: 5,
        ctx: {
          organizationId: orgId,
          userId: ownerId,
          memberRole: 'owner',
          isAuthenticated: true,
          tokenType: 'pat',
          scopedToOrg: false,
          allowCrossOrg: false,
        } as never,
      });

      const row = await latestAuditRow(orgId, toolName);
      expect(row).not.toBeNull();
      expect(row!.payload_data.success).toBe(false);
      // Name only — handler-supplied error text never reaches the ledger.
      expect(row!.payload_data.error).toEqual({ name: 'ToolError' });
    }
  );

  it('bounds large requests directly on their audit event', async () => {
    const script = 'x'.repeat(300 * 1024);
    await recordToolInvocationAudit({
      toolName: 'run_sdk',
      args: { script },
      result: { success: true },
      durationMs: 1,
      ctx: authCtxFor('pat') as never,
    });
    const row = await latestAuditRow(orgId, 'run_sdk');
    expect(row!.payload_data).toMatchObject({
      request_status: 'too_large',
      request_bytes: expect.any(Number),
    });
    // Over the cap the body is dropped, not truncated — a partial script is a
    // misleading reconstruction surface.
    expect(row!.payload_data).not.toHaveProperty('request');
    expect(await readAuditEvent(row!.id, authCtxFor('pat'))).toMatchObject({
      request_status: 'too_large',
      request_bytes: expect.any(Number),
    });
  });

  it('fully redacts secrets embedded in NON-secret string fields (quoted values, Basic auth, comma-delimited)', async () => {
    // deepRedactSecrets only covers denylisted KEYS; secrets pasted into free
    // text (a note, a script arg) rely on the text patterns, which must consume
    // the complete credential — not stop at the first space, comma, or scheme
    // word and leak the remainder into the preview.
    await recordToolInvocationAudit({
      toolName: 'probe_freetext_redaction',
      args: {
        // token= sits BEFORE authorization: the header pattern consumes the
        // rest of the value, so a later position would not prove the
        // comma-delimited assignment branch on its own.
        note: [
          'token=part1,part2',
          'password="my secret value"',
          'authorization: Basic dXNlcjpwYXNz',
          'curl --token sk-live-1234567890',
          'the token is sk-live-abcdef',
        ].join(' | '),
        digest_header:
          'authorization: Digest username="mufasa", realm="testrealm", nonce="dcd98b7102dd", response="6629fae49393"',
        bare_digest: 'Digest username="scar", uri="/dir/index.html", response="abc9f8de77"',
      },
      result: { ok: true },
      durationMs: 3,
      ctx: {
        organizationId: orgId,
        userId: ownerId,
        memberRole: 'owner',
        isAuthenticated: true,
        tokenType: 'pat',
        scopedToOrg: false,
        allowCrossOrg: false,
      } as never,
    });

    const row = await latestAuditRow(orgId, 'probe_freetext_redaction');
    expect(row).not.toBeNull();
    const preview = String(row!.payload_data.args_preview_redacted);
    expect(preview).not.toContain('my secret value');
    expect(preview).not.toContain('secret value');
    expect(preview).not.toContain('dXNlcjpwYXNz');
    expect(preview).not.toContain('part2');
    // Digest parameters are credential material end to end — none of the
    // quoted values may survive, with or without the authorization: prefix.
    for (const fragment of [
      'mufasa',
      'testrealm',
      'dcd98b7102dd',
      '6629fae49393',
      'scar',
      'abc9f8de77',
      'sk-live-1234567890',
      'sk-live-abcdef',
    ]) {
      expect(preview).not.toContain(fragment);
    }
  });

  it('query_sql preview redaction consumes complete credentials (the pattern path the generic sentinel does not cover)', async () => {
    // The generic path sentinels everything before the regexes run; query_sql
    // and run_sdk previews are where pattern redaction still carries the load.
    const sql = [
      "SELECT /* redaction-probe */ 'password=\"my secret value\"',",
      "'authorization: Basic dXNlcjpwYXNz',",
      '\'Digest username="mufasa", realm="testrealm", response="6629fae49393"\',',
      "'token=part1,part2' FROM events",
    ].join(' ');
    await executeTool('query_sql', { sql, limit: 1 }, {} as Env, authCtxFor('oauth'));

    const db = getDb();
    const rows = await db<Array<{ payload_data: Record<string, unknown> }>>`
      SELECT payload_data FROM events
      WHERE organization_id = ${orgId}
        AND semantic_type = 'audit'
        AND payload_data->>'tool_name' = 'query_sql'
        AND payload_data->>'sql_preview_redacted' LIKE '%redaction-probe%'
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(rows).toHaveLength(1);
    const preview = String(rows[0].payload_data.sql_preview_redacted);
    for (const fragment of [
      'my secret value',
      'dXNlcjpwYXNz',
      'mufasa',
      'testrealm',
      '6629fae49393',
      'part2',
    ]) {
      expect(preview).not.toContain(fragment);
    }
  });

  it('audits org-agnostic list_organizations under the bound org (early-return path)', async () => {
    const conversationId = 'list-organizations-only-session';
    await executeTool(
      'list_organizations',
      {},
      {} as Env,
      {
        ...authCtxFor('oauth'),
        mcpSessionId: 'list-organizations-transport',
        mcpConversationId: conversationId,
      }
    );

    const row = await latestAuditRow(orgId, 'list_organizations');
    expect(row).not.toBeNull();
    expect(row!.payload_data.success).toBe(true);

    const db = getDb();
    const conversations = await db<
      Array<{ conversation_id: string; last_action: string; call_count: number }>
    >`
      SELECT conversation_id, last_action, call_count::int AS call_count
      FROM mcp_client_conversations
      WHERE organization_id = ${orgId}
        AND client_identity = ${clientId}
        AND conversation_id = ${conversationId}
    `;
    expect(conversations).toEqual([
      {
        conversation_id: conversationId,
        last_action: 'list_organizations',
        call_count: 1,
      },
    ]);
  });

  it('records resolved tool failures as failed', async () => {
    // A failure the HANDLER resolves, not one the arg validator throws:
    // manage_classifiers' per-action schema now supplies `classifier_id`'s
    // required-ness, so an omitted id raises instead of returning a result.
    const result = (await executeTool(
      'manage_classifiers',
      { action: 'delete', classifier_id: 999999 },
      {} as Env,
      authCtxFor('pat')
    )) as { success: boolean };
    expect(result.success).toBe(false);

    const row = await latestAuditRow(orgId, 'manage_classifiers');
    expect(row).not.toBeNull();
    expect(row!.payload_data.success).toBe(false);
    expect(row!.payload_data.error).toMatchObject({ name: expect.any(String) });
    expect(row!.payload_data.error).not.toHaveProperty('message');
  });
});
