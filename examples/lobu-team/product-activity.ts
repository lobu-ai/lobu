/** Live account facts and current MCP state. Never ingested as connector events. */
export const productActivitySql = `SELECT *
          FROM (
            SELECT
              'signup:' || u.id AS activity_id,
              u."createdAt" AS occurred_at,
              'New signup'::text AS title,
              concat_ws(
                ' · ',
                coalesce(nullif(u.name, ''), 'Unnamed user'),
                u.email,
                coalesce((
                  SELECT string_agg(DISTINCT o.name, ', ' ORDER BY o.name)
                  FROM member m
                  JOIN organization o ON o.id = m."organizationId"
                  WHERE m."userId" = u.id
                ), 'No organization')
              ) AS payload_text,
              jsonb_build_object('event_type', 'account.created',
                'user_id', u.id) AS activity_data
            FROM "user" u
            WHERE coalesce(u.principal_kind, 'human') = 'human'

            UNION ALL

            SELECT
              'login:' || s.id,
              s."createdAt",
              'Session created'::text,
              'Account ' || s."userId",
              jsonb_build_object('event_type', 'session.created',
                'user_id', s."userId", 'session_id', s.id)
            FROM session s
            JOIN "user" u ON u.id = s."userId"
            WHERE coalesce(u.principal_kind, 'human') = 'human'

            UNION ALL

            SELECT
              'connection:' || c.id,
              c.created_at,
              'New connection'::text,
              concat_ws(' · ', c.connector_key, 'Connection ' || c.id,
                'Workspace ' || c.organization_id),
              jsonb_build_object('event_type', 'connection.created',
                'connection_id', c.id, 'connector_key', c.connector_key,
                'organization_id', c.organization_id, 'user_id', c.created_by)
            FROM connections c

            UNION ALL

            SELECT
              'mcp:' || jsonb_build_array(m.user_id, m.client_identity,
                m.conversation_id,
                to_char(m.last_activity_at AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS.US'),
                lpad(m.call_count::text, 20, '0'))::text,
              m.last_activity_at,
              'MCP activity observed'::text,
              concat_ws(' · ', 'Account ' || m.user_id,
                'Client ' || nullif(m.client_identity, ''),
                m.call_count || ' cumulative calls at observation',
                m.failed_count || ' cumulative failures at observation'),
              jsonb_build_object('event_type', 'mcp.activity_observed',
                'user_id', m.user_id, 'client_identity', m.client_identity,
                'client_id', m.client_id, 'mcp_activity_id', m.conversation_id,
                'conversation_started_at', to_char(m.first_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                'call_count', m.call_count::text, 'failed_count', m.failed_count::text)
            FROM mcp_client_conversations m
            JOIN "user" u ON u.id = m.user_id
            WHERE m.call_count > 0
              AND coalesce(u.principal_kind, 'human') = 'human'

            UNION ALL

            SELECT
              'tool-failure:' || e.origin_id,
              e.created_at,
              'Failed tool call'::text,
              concat_ws(' · ', 'Account ' || e.created_by,
                e.payload_data->>'tool_name',
                coalesce(e.payload_data->'error'->>'code', e.payload_data->'error'->>'name', 'Unknown error')),
              jsonb_build_object('event_type', 'tool_invocation.completed',
                'user_id', e.created_by, 'organization_id', e.organization_id,
                'tool_name', e.payload_data->>'tool_name', 'success', false,
                'error', jsonb_strip_nulls(jsonb_build_object(
                  'code', e.payload_data#>>'{error,code}',
                  'name', e.payload_data#>>'{error,name}')),
                'actor', jsonb_build_object('token_type', e.metadata->>'token_type',
                  'agent_id', e.metadata->>'agent_id', 'client_id', e.client_id,
                  'mcp_session_id', e.metadata->>'mcp_session_id',
                  'mcp_conversation_id', e.metadata->>'mcp_conversation_id'))
            FROM events e
            JOIN "user" u ON u.id = e.created_by
            WHERE e.semantic_type = 'audit'
              AND e.origin_type = 'tool_invocation'
              AND e.metadata->>'event_type' = 'tool_invocation.completed'
              AND e.payload_data->>'success' = 'false'
              AND coalesce(u.principal_kind, 'human') = 'human'
          ) activity`;

export function sourceWindow(start: string, end: string): string {
  for (const value of [start, end]) {
    if (
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value
    )
      throw new Error("Expected canonical UTC source bounds");
  }
  if (start >= end || Date.parse(end) - Date.parse(start) > 86_400_000)
    throw new Error("Source windows must be ordered and at most 24 hours");
  return `occurred_at >= '${start}'::timestamptz AND occurred_at < '${end}'::timestamptz`;
}

export function productActivityQuery(start: string, end: string): string {
  return `SELECT * FROM (${productActivitySql}) source
    WHERE ${sourceWindow(start, end)} ORDER BY occurred_at, activity_id`;
}
