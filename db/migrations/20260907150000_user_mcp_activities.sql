-- migrate:up
CREATE TABLE IF NOT EXISTS public.user_mcp_activities (
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  client_identity text NOT NULL,
  activity_id text NOT NULL,
  activity_kind text NOT NULL CHECK (activity_kind IN ('conversation', 'session')),
  client_id text,
  client_software_id text,
  title text,
  last_action text NOT NULL,
  tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  call_count bigint NOT NULL DEFAULT 0,
  failed_count bigint NOT NULL DEFAULT 0,
  first_activity_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_identity, activity_id)
);
-- squawk-ignore require-concurrent-index-creation -- new table
CREATE INDEX IF NOT EXISTS user_mcp_activities_recent
  ON public.user_mcp_activities (user_id, last_activity_at DESC);
-- squawk-ignore require-concurrent-index-creation -- new table
CREATE INDEX IF NOT EXISTS user_mcp_activities_client_recent
  ON public.user_mcp_activities (user_id, client_id, activity_kind, last_activity_at DESC);

-- Workspace event links keep their recorded transport associations, without
-- private account titles, counters, or inferred user ownership.
CREATE TABLE IF NOT EXISTS public.mcp_activity_event_scopes (
  organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  client_identity text NOT NULL,
  activity_id text NOT NULL,
  transport_session_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(transport_session_ids) = 'array'),
  PRIMARY KEY (organization_id, client_identity, activity_id)
);

INSERT INTO public.user_mcp_activities (
  user_id, client_identity, activity_id, activity_kind, client_id,
  client_software_id, last_action, tools, call_count, failed_count,
  first_activity_at, last_activity_at
)
SELECT i.user_id, COALESCE(i.client_id, ''), i.activity_id,
  CASE WHEN bool_or(
    NULLIF(i.metadata->>'mcp_conversation_id', '') IS NOT NULL
      AND NULLIF(i.metadata->>'mcp_conversation_id', '')
        IS DISTINCT FROM NULLIF(i.metadata->>'mcp_session_id', '')
  )
    THEN 'conversation' ELSE 'session' END,
  i.client_id, oc.software_id,
  (array_agg(i.tool_name ORDER BY i.created_at DESC, i.id DESC))[1],
  jsonb_agg(DISTINCT i.tool_name), count(*), count(*) FILTER (WHERE NOT i.success),
  min(i.created_at), max(i.created_at)
FROM public.user_tool_invocations i
LEFT JOIN public.oauth_clients oc ON oc.id = i.client_id
WHERE i.activity_id IS NOT NULL
GROUP BY i.user_id, i.client_id, i.activity_id, oc.software_id
ON CONFLICT (user_id, client_identity, activity_id) DO NOTHING;

DO $migration$
BEGIN
  IF to_regclass('public.mcp_client_conversations') IS NOT NULL THEN
    INSERT INTO public.mcp_activity_event_scopes
      (organization_id, client_identity, activity_id, transport_session_ids)
    SELECT organization_id, client_identity, conversation_id, transport_session_ids
    FROM public.mcp_client_conversations
    ON CONFLICT (organization_id, client_identity, activity_id) DO NOTHING;

    -- Deleted registrations no longer join oauth_clients, but the old writer
    -- retained their software identity (including command-client exclusion).
    UPDATE public.user_mcp_activities a SET client_software_id = stored.software_id
    FROM (
      SELECT client_identity, min(client_software_id) AS software_id
      FROM public.mcp_client_conversations
      WHERE client_software_id IS NOT NULL
      GROUP BY client_identity HAVING count(DISTINCT client_software_id) = 1
    ) stored
    WHERE a.client_identity = stored.client_identity AND a.client_software_id IS NULL;

    -- The old projection overwrote user_id. Require individually attributed
    -- calls to agree before moving a title into a user's private account.
    WITH titles AS (
      SELECT a.user_id, a.client_identity, a.activity_id, min(mc.title) AS title
      FROM public.user_mcp_activities a
      JOIN public.mcp_client_conversations mc
        ON mc.client_identity = a.client_identity AND mc.conversation_id = a.activity_id
      WHERE mc.user_id = a.user_id AND mc.title IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.user_tool_invocations other_call
          WHERE COALESCE(other_call.client_id, '') = a.client_identity
            AND other_call.activity_id = a.activity_id AND other_call.user_id <> a.user_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.events e
          WHERE e.organization_id = mc.organization_id AND e.client_id = mc.client_id
            AND (e.metadata->>'mcp_conversation_id' = mc.conversation_id
              OR mc.transport_session_ids ? (e.metadata->>'mcp_session_id'))
            AND e.origin_type = 'tool_invocation' AND e.created_by IS DISTINCT FROM a.user_id
        )
      GROUP BY a.user_id, a.client_identity, a.activity_id
      HAVING count(DISTINCT mc.title) = 1
    )
    UPDATE public.user_mcp_activities a SET title = t.title
    FROM titles t WHERE a.user_id = t.user_id AND a.client_identity = t.client_identity
      AND a.activity_id = t.activity_id AND a.title IS NULL;

    -- squawk-ignore ban-drop-table -- all readers/writers replaced in this release
    DROP TABLE public.mcp_client_conversations;
  END IF;
END
$migration$;
DROP FUNCTION IF EXISTS public.stamp_mcp_conversation_client_software_id();
DROP FUNCTION IF EXISTS public.set_mcp_client_activity_kind();

-- Each actual workspace event supplies its own organization. Account calls
-- never create workspace associations from an OAuth anchor.
CREATE OR REPLACE FUNCTION public.record_mcp_event_scope() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  activity text := COALESCE(NULLIF(NEW.metadata->>'mcp_conversation_id', ''),
    NULLIF(NEW.metadata->>'mcp_session_id', ''));
  transport text := NULLIF(NEW.metadata->>'mcp_session_id', '');
BEGIN
  IF NEW.organization_id IS NULL OR NEW.client_id IS NULL OR activity IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.mcp_activity_event_scopes
    (organization_id, client_identity, activity_id, transport_session_ids)
  VALUES (NEW.organization_id, NEW.client_id, activity,
    CASE WHEN transport IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(transport) END)
  ON CONFLICT (organization_id, client_identity, activity_id) DO UPDATE SET
    transport_session_ids = CASE WHEN transport IS NULL
      OR public.mcp_activity_event_scopes.transport_session_ids ? transport
      THEN public.mcp_activity_event_scopes.transport_session_ids
      ELSE public.mcp_activity_event_scopes.transport_session_ids || jsonb_build_array(transport) END;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS record_mcp_event_scope ON public.events;
CREATE TRIGGER record_mcp_event_scope AFTER INSERT ON public.events
FOR EACH ROW EXECUTE FUNCTION public.record_mcp_event_scope();

-- migrate:down
-- Ownership consolidation is forward-only; restore neither the old writer nor
-- its mutable user attribution when rolling application releases.
