import { getDb } from './db/client';

export const MCP_SESSION_MAX_AGE_MS = 60 * 60 * 1000;

export interface PersistedMcpSession {
  sessionId: string;
  userId: string | null;
  clientId: string | null;
  organizationId: string | null;
  memberRole: string | null;
  requestedAgentId: string | null;
  isAuthenticated: boolean;
  scopedToOrg: boolean;
  supportsMcpApps: boolean;
  supportsAppSandboxDomain: boolean;
  lastAccessedAt: number;
  expiresAt: number;
}

function fromDate(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fromBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 't' || normalized === 'true' || normalized === '1';
  }
  return false;
}

export class McpSessionStore {
  async upsertSession(session: PersistedMcpSession): Promise<void> {
    const sql = getDb();
    await sql`
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
        supports_app_sandbox_domain,
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
        ${session.supportsAppSandboxDomain},
        ${new Date(session.lastAccessedAt)},
        ${new Date(session.expiresAt)}
      )
      ON CONFLICT (session_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        client_id = EXCLUDED.client_id,
        organization_id = EXCLUDED.organization_id,
        member_role = EXCLUDED.member_role,
        requested_agent_id = EXCLUDED.requested_agent_id,
        is_authenticated = EXCLUDED.is_authenticated,
        scoped_to_org = EXCLUDED.scoped_to_org,
        supports_mcp_apps = EXCLUDED.supports_mcp_apps,
        supports_app_sandbox_domain = EXCLUDED.supports_app_sandbox_domain,
        last_accessed_at = EXCLUDED.last_accessed_at,
        expires_at = EXCLUDED.expires_at
    `;
  }

  /**
   * Refresh an EXISTING session row. Returns false if no live row matched.
   *
   * Follow-up requests must not use `upsertSession`: the persisted row is the
   * cross-replica revocation signal, and an INSERT would resurrect a row that
   * a concurrent revoke just deleted — re-arming a session that was meant to
   * die. Checking existence first is not enough, because the revoke can commit
   * between the check and the write; making the write itself update-only
   * collapses that window. Reserve `upsertSession` for initialization, where
   * creating the row is the intent.
   */
  async refreshSession(session: PersistedMcpSession): Promise<boolean> {
    const sql = getDb();
    const rows = await sql`
      UPDATE mcp_sessions SET
        user_id = ${session.userId},
        client_id = ${session.clientId},
        organization_id = ${session.organizationId},
        member_role = ${session.memberRole},
        requested_agent_id = ${session.requestedAgentId},
        is_authenticated = ${session.isAuthenticated},
        scoped_to_org = ${session.scopedToOrg},
        supports_mcp_apps = ${session.supportsMcpApps},
        supports_app_sandbox_domain = ${session.supportsAppSandboxDomain},
        last_accessed_at = GREATEST(last_accessed_at, ${new Date(session.lastAccessedAt)}),
        expires_at = GREATEST(expires_at, ${new Date(session.expiresAt)})
      WHERE session_id = ${session.sessionId}
      RETURNING session_id
    `;
    return rows.length > 0;
  }

  /** Transport activity must neither overwrite newer auth nor recreate revoked rows. */
  async refreshActivity(sessionId: string): Promise<boolean> {
    const sql = getDb();
    const rows = await sql`
      UPDATE mcp_sessions SET
        last_accessed_at = GREATEST(last_accessed_at, NOW()),
        expires_at = GREATEST(expires_at, NOW() + ${MCP_SESSION_MAX_AGE_MS} * interval '1 millisecond')
      WHERE session_id = ${sessionId}
      RETURNING session_id
    `;
    return rows.length > 0;
  }

  async getSession(sessionId: string): Promise<PersistedMcpSession | null> {
    const sql = getDb();
    const rows = await sql`
      SELECT *
      FROM mcp_sessions
      WHERE session_id = ${sessionId}
        AND expires_at > NOW()
      LIMIT 1
    `;
    if (rows.length === 0) return null;

    const row = rows[0] as Record<string, unknown>;
    const supportsMcpApps = fromBool(row.supports_mcp_apps);
    return {
      sessionId: String(row.session_id),
      userId: typeof row.user_id === 'string' ? row.user_id : null,
      clientId: typeof row.client_id === 'string' ? row.client_id : null,
      organizationId: typeof row.organization_id === 'string' ? row.organization_id : null,
      memberRole: typeof row.member_role === 'string' ? row.member_role : null,
      requestedAgentId: typeof row.requested_agent_id === 'string' ? row.requested_agent_id : null,
      isAuthenticated: fromBool(row.is_authenticated),
      scopedToOrg: fromBool(row.scoped_to_org),
      supportsMcpApps,
      supportsAppSandboxDomain:
        row.supports_app_sandbox_domain == null
          ? supportsMcpApps
          : fromBool(row.supports_app_sandbox_domain),
      lastAccessedAt: fromDate(row.last_accessed_at) ?? Date.now(),
      expiresAt: fromDate(row.expires_at) ?? Date.now(),
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const sql = getDb();
    await sql`DELETE FROM mcp_sessions WHERE session_id = ${sessionId}`;
  }

  async deleteExpiredSessions(): Promise<void> {
    const sql = getDb();
    // Lock candidates in the deleting statement: cleanup skips rows already
    // being refreshed, while a later refresh sees any committed deletion.
    // Cap each scheduler tick's work so later ticks can continue the backlog.
    await sql`
      WITH expired AS (
        SELECT session_id FROM mcp_sessions
        WHERE expires_at <= NOW()
        ORDER BY expires_at, session_id
        LIMIT 500
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM mcp_sessions s USING expired
      WHERE s.session_id = expired.session_id
    `;
  }
}
