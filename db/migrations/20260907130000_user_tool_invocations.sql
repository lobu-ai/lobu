-- migrate:up
CREATE TABLE IF NOT EXISTS public.user_tool_invocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  organization_id text REFERENCES public.organization(id) ON DELETE SET NULL,
  client_id text,
  activity_id text,
  tool_name text NOT NULL,
  success boolean NOT NULL,
  duration_ms double precision NOT NULL,
  payload_data jsonb NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  source_event_id bigint UNIQUE
);

-- squawk-ignore require-concurrent-index-creation -- new table, not yet served
CREATE INDEX IF NOT EXISTS user_tool_invocations_owner_recent
  ON public.user_tool_invocations (user_id, id DESC);
-- squawk-ignore require-concurrent-index-creation -- new table, not yet served
CREATE INDEX IF NOT EXISTS user_tool_invocations_owner_activity
  ON public.user_tool_invocations (user_id, activity_id, id DESC);
-- squawk-ignore require-concurrent-index-creation -- new table, not yet served
CREATE INDEX IF NOT EXISTS user_tool_invocations_owner_client
  ON public.user_tool_invocations (user_id, client_id, id DESC);

-- Copy only individually attributed calls, never the conversation projection's
-- last/max user_id. Original events remain append-only and keep their IDs.
-- PAT and session calls were pinned to their execution workspace. An old OAuth
-- event's workspace may instead have been the token default, so preserve that
-- less reliable value only as source metadata.
INSERT INTO public.user_tool_invocations (
  user_id, organization_id, client_id, activity_id, tool_name, success, duration_ms,
  payload_data, metadata, created_at, source_event_id
)
SELECT e.created_by,
  CASE WHEN e.metadata->>'token_type' IN ('pat', 'session') THEN e.organization_id END,
  e.client_id,
  COALESCE(NULLIF(e.metadata->>'mcp_conversation_id', ''), NULLIF(e.metadata->>'mcp_session_id', '')),
  e.payload_data->>'tool_name',
  COALESCE(e.payload_data->>'success' = 'true', false),
  CASE WHEN jsonb_typeof(e.payload_data->'duration_ms') = 'number'
    THEN (e.payload_data->>'duration_ms')::double precision ELSE 0 END,
  e.payload_data,
  COALESCE(e.metadata, '{}'::jsonb) || jsonb_build_object('source_organization_id', e.organization_id),
  e.created_at, e.id
FROM public.events e
JOIN public."user" u ON u.id = e.created_by
WHERE e.semantic_type = 'audit' AND e.origin_type = 'tool_invocation'
  AND e.payload_data->>'tool_name' IS NOT NULL
  AND e.metadata->>'token_type' IN ('oauth', 'pat', 'session')
ORDER BY e.created_at, e.id
ON CONFLICT (source_event_id) DO NOTHING;

-- migrate:down
-- squawk-ignore ban-drop-table -- rollback of the table introduced above
DROP TABLE IF EXISTS public.user_tool_invocations;
