-- migrate:up
-- This rebuilds a mutable Recent projection, never the events audit ledger.
-- Deployment quiesces writers: the primary-key cutover is incompatible with
-- the previous writer. Only the existing 14-day Recent window is rebuilt.
-- Source SELECT measured on production: 12,894 calls in 1.083s (2026-09-07).
-- This times the source read, not the complete projection rebuild.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.mcp_client_conversations'::regclass
      AND conname = 'mcp_client_conversations_actor_pkey'
  ) THEN
    RETURN;
  END IF;

  CREATE TEMP TABLE mcp_activity_calls ON COMMIT DROP AS
    SELECT e.organization_id, e.created_by AS user_id, e.client_id,
      COALESCE(NULLIF(e.metadata->>'mcp_conversation_id', ''),
        NULLIF(e.metadata->>'mcp_session_id', '')) AS activity_id,
      NULLIF(e.metadata->>'mcp_session_id', '') AS session_id,
      e.metadata->>'agent_id' AS agent_id,
      e.payload_data->>'tool_name' AS tool_name,
      e.payload_data->>'success' IS DISTINCT FROM 'true' AS failed,
      e.occurred_at, e.id
    FROM public.events e
    WHERE e.semantic_type = 'audit' AND e.origin_type = 'tool_invocation'
      AND e.client_id IS NOT NULL
      AND e.payload_data->>'tool_name' IS NOT NULL
      AND COALESCE(NULLIF(e.metadata->>'mcp_conversation_id', ''),
        NULLIF(e.metadata->>'mcp_session_id', '')) IS NOT NULL
      AND e.occurred_at > now() - interval '14 days';

  -- A legacy row can combine multiple actors. Preserve its title only when
  -- the entire recorded lifetime is covered and all calls identify its user.
  CREATE TEMP TABLE mcp_activity_titles ON COMMIT DROP AS
    SELECT mc.user_id, mc.client_identity, mc.conversation_id, mc.title, mc.updated_at
    FROM public.mcp_client_conversations mc
    JOIN mcp_activity_calls c ON c.organization_id = mc.organization_id
      AND c.client_id = mc.client_identity AND c.activity_id = mc.conversation_id
    WHERE mc.title IS NOT NULL AND mc.user_id IS NOT NULL
      AND mc.first_activity_at > now() - interval '14 days'
    GROUP BY mc.organization_id, mc.client_identity, mc.conversation_id
    HAVING count(*) = mc.call_count
      AND bool_and(c.user_id IS NOT NULL AND c.user_id = mc.user_id);

  DELETE FROM public.mcp_client_conversations;
  ALTER TABLE public.mcp_client_conversations DROP CONSTRAINT mcp_client_conversations_pkey;
  ALTER TABLE public.mcp_client_conversations ALTER COLUMN organization_id DROP NOT NULL;
  ALTER TABLE public.mcp_client_conversations ALTER COLUMN user_id SET NOT NULL;
  ALTER TABLE public.mcp_client_conversations ADD CONSTRAINT mcp_client_conversations_actor_pkey
    PRIMARY KEY (user_id, client_identity, conversation_id);

  WITH activity AS (
    SELECT user_id, client_id, activity_id,
      CASE WHEN count(organization_id) = count(*) AND count(DISTINCT organization_id) = 1
        THEN min(organization_id) ELSE NULL END AS organization_id,
      COALESCE(jsonb_agg(DISTINCT session_id) FILTER (WHERE session_id IS NOT NULL), '[]'::jsonb) AS session_ids,
      (array_agg(agent_id ORDER BY occurred_at DESC, id DESC))[1] AS agent_id,
      (array_agg(tool_name ORDER BY occurred_at DESC, id DESC))[1] AS last_action,
      jsonb_agg(DISTINCT tool_name) AS tools,
      count(*) AS call_count, count(*) FILTER (WHERE failed) AS failed_count,
      min(occurred_at) AS first_activity_at, max(occurred_at) AS last_activity_at
    FROM mcp_activity_calls
    WHERE user_id IS NOT NULL
    GROUP BY user_id, client_id, activity_id
  )
  INSERT INTO public.mcp_client_conversations (
    user_id, client_identity, conversation_id, organization_id, client_id,
    transport_session_ids, agent_id, title, last_action, tools, call_count,
    failed_count, first_activity_at, last_activity_at
  )
  SELECT a.user_id, a.client_id, a.activity_id, a.organization_id, a.client_id,
    a.session_ids, a.agent_id, title.title, a.last_action, a.tools, a.call_count,
    a.failed_count, a.first_activity_at, a.last_activity_at
  FROM activity a
  LEFT JOIN LATERAL (
    SELECT t.title FROM mcp_activity_titles t
    WHERE t.user_id = a.user_id AND t.client_identity = a.client_id
      AND t.conversation_id = a.activity_id
    ORDER BY t.updated_at DESC, t.title
    LIMIT 1
  ) title ON true;

  DROP INDEX IF EXISTS public.mcp_client_conversations_recent;
  DROP INDEX IF EXISTS public.mcp_activity_scope_client_recent;
  CREATE INDEX mcp_activity_actor_recent
    ON public.mcp_client_conversations (user_id, last_activity_at DESC);
  CREATE INDEX mcp_activity_actor_client_recent
    ON public.mcp_client_conversations (user_id, client_id, activity_kind, last_activity_at DESC)
    WHERE client_id IS NOT NULL AND call_count > 0;
END
$migration$;

-- migrate:down
-- Forward-only: restoring the workspace key would merge different actors.
