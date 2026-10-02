/**
 * A write for an established session must never CREATE a row.
 *
 * The persisted `mcp_sessions` row is the cross-replica revocation signal: a
 * revoke on any pod DELETEs it, and a pod holding a live in-memory transport
 * notices by failing to find it. Checking existence and then upserting is NOT
 * enough — a revoke committing between the check and the write is silently
 * undone by that write, and the session comes back to life on a client whose
 * access was just revoked.
 *
 * `refreshSession` is update-only, so a deleted row stays deleted no matter how
 * the two interleave. These tests pin the atomic store primitive; the recovery
 * suite separately pins the handler interleaving.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpSessionStore, type PersistedMcpSession } from '../../../mcp-session-store';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

describe('mcp session refresh is update-only', () => {
  const store = new McpSessionStore();
  let session: PersistedMcpSession;

  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Refresh Org' });
    const user = await createTestUser({ email: 'refresh@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient();

    session = {
      sessionId: 'sess-refresh-1',
      userId: user.id,
      clientId: client.client_id,
      organizationId: org.id,
      memberRole: 'owner',
      requestedAgentId: null,
      isAuthenticated: true,
      scopedToOrg: false,
      supportsMcpApps: true,
      supportsAppSandboxDomain: true,
      lastAccessedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    };
  });

  it('refreshes an existing row and reports success', async () => {
    await store.upsertSession(session);

    const bumped = { ...session, lastAccessedAt: session.lastAccessedAt + 60_000 };
    expect(await store.refreshSession(bumped)).toBe(true);

    const row = await store.getSession(session.sessionId);
    expect(row).not.toBeNull();
    expect(row?.supportsMcpApps).toBe(true);
    expect(row?.supportsAppSandboxDomain).toBe(true);
  });

  it('preserves MCP Apps domain metadata for a row written by the previous binary', async () => {
    await getTestDb()`
      INSERT INTO mcp_sessions (
        session_id,
        user_id,
        client_id,
        organization_id,
        member_role,
        requested_agent_id,
        is_authenticated,
        scoped_to_org,
        supports_mcp_apps,
        last_accessed_at,
        expires_at
      ) VALUES (
        ${session.sessionId},
        ${session.userId},
        ${session.clientId},
        ${session.organizationId},
        ${session.memberRole},
        ${session.requestedAgentId},
        ${session.isAuthenticated},
        ${session.scopedToOrg},
        ${session.supportsMcpApps},
        ${new Date(session.lastAccessedAt)},
        ${new Date(session.expiresAt)}
      )
    `;

    const row = await store.getSession(session.sessionId);
    expect(row?.supportsMcpApps).toBe(true);
    expect(row?.supportsAppSandboxDomain).toBe(true);
  });

  it('leaves the row unwritten when a refresh changes nothing it records', async () => {
    // Every MCP request refreshes its session, and each rewrite leaves a dead
    // row behind. A changed xmin identifies a rewrite.
    const db = getTestDb();
    const xmin = async () =>
      (await db`SELECT xmin::text AS xmin FROM mcp_sessions WHERE session_id = ${session.sessionId}`)[0].xmin;
    await store.upsertSession(session);
    const written = await xmin();

    const sameAuth = { ...session, lastAccessedAt: session.lastAccessedAt + 5_000, expiresAt: session.expiresAt + 5_000 };
    expect(await store.refreshSession(sameAuth)).toBe(true);
    expect(await xmin()).toBe(written);

    const promoted = { ...sameAuth, memberRole: 'admin' };
    expect(await store.refreshSession(promoted)).toBe(true);
    const roleChanged = await xmin();
    expect(roleChanged).not.toBe(written);
    expect((await store.getSession(session.sessionId))?.memberRole).toBe('admin');

    const later = { ...promoted, lastAccessedAt: promoted.lastAccessedAt + 120_000, expiresAt: promoted.expiresAt + 120_000 };
    expect(await store.refreshSession(later)).toBe(true);
    expect(await xmin()).not.toBe(roleChanged);
    expect((await store.getSession(session.sessionId))?.expiresAt).toBe(later.expiresAt);
  });

  it('does NOT resurrect a row deleted by a concurrent revoke', async () => {
    await store.upsertSession(session);

    // Interleave: the revoking replica commits its DELETE while this request is
    // mid-flight, after it already decided the session looked valid.
    await getTestDb()`DELETE FROM mcp_sessions WHERE session_id = ${session.sessionId}`;

    expect(await store.refreshSession(session)).toBe(false);
    expect(await store.getSession(session.sessionId)).toBeNull();

    const rows = await getTestDb()`
      SELECT session_id FROM mcp_sessions WHERE session_id = ${session.sessionId}
    `;
    expect(rows).toHaveLength(0);
  });

  it('upsertSession creates rows only for initialization', async () => {
    // Pins the contrast the established-session paths depend on.
    expect(await store.getSession(session.sessionId)).toBeNull();
    await store.upsertSession(session);
    expect(await store.getSession(session.sessionId)).not.toBeNull();
  });
});
