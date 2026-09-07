-- migrate:up transaction:false

-- Personal Recent detail selects an actor/client/activity page, including calls
-- with NULL or multiple execution targets. Keep workspace event indexes: those
-- readers retain their existing authorization and predicates.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'events_mcp_actor_activity'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.events_mcp_actor_activity';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS events_mcp_actor_activity
  ON public.events (
    created_by,
    client_id,
    (COALESCE(NULLIF(metadata->>'mcp_conversation_id', ''),
      NULLIF(metadata->>'mcp_session_id', ''))),
    occurred_at DESC,
    id DESC
  )
  WHERE created_by IS NOT NULL
    AND semantic_type = 'audit'
    AND origin_type = 'tool_invocation';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.events_mcp_actor_activity;
