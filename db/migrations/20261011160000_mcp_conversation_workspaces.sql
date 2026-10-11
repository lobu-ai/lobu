-- migrate:up
-- An MCP conversation belongs to its user's account, and appears in the Recent
-- list of every workspace its calls actually ran in. The single
-- `organization_id` column recorded the connection's workspace instead, which
-- is null for account-level (bare /mcp) clients, so their conversations showed
-- in every workspace. This replaces it with one row per workspace.
--
-- Old replicas still write `mcp_client_conversations.organization_id`, which
-- this drops, so the deploy quiesces (no `lobu:no-quiesce`).
--
-- Cost: the backfill reads the existing 14-day Recent window of events.
-- Measured on production 2026-10-11 against 9,711 conversation rows: the
-- event-backfill SELECT took 1.6s and produced 4,044 workspace rows.
-- Dropping the column is a metadata-only change.
CREATE TABLE IF NOT EXISTS public.mcp_client_conversation_workspaces (
  user_id text NOT NULL,
  client_identity text NOT NULL,
  conversation_id text NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_identity, conversation_id, organization_id),
  FOREIGN KEY (user_id, client_identity, conversation_id)
    REFERENCES public.mcp_client_conversations (user_id, client_identity, conversation_id)
    ON DELETE CASCADE
);

-- squawk-ignore require-concurrent-index-creation -- table created immediately above
CREATE INDEX IF NOT EXISTS mcp_conversation_workspaces_recent
  ON public.mcp_client_conversation_workspaces (user_id, organization_id, last_activity_at DESC);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'mcp_client_conversations'
      AND column_name = 'organization_id'
  ) THEN
    RETURN;
  END IF;

  -- A non-null workspace was consistent across every call the row recorded.
  INSERT INTO public.mcp_client_conversation_workspaces (
    user_id, client_identity, conversation_id, organization_id, last_activity_at
  )
  SELECT mc.user_id, mc.client_identity, mc.conversation_id, mc.organization_id,
    mc.last_activity_at
  FROM public.mcp_client_conversations mc
  WHERE mc.organization_id IS NOT NULL
  ON CONFLICT DO NOTHING;

  -- Workspace events carry the conversation that caused them. Connector
  -- operation events have no `created_by`, so they match on client and
  -- conversation alone; a pair claimed by more than one user is skipped.
  WITH calls AS (
    SELECT e.created_by, e.client_id,
      COALESCE(NULLIF(e.metadata->>'mcp_conversation_id', ''),
        NULLIF(e.metadata->>'mcp_session_id', '')) AS activity_id,
      e.organization_id, max(e.created_at) AS last_activity_at
    FROM public.events e
    WHERE e.organization_id IS NOT NULL AND e.client_id IS NOT NULL
      AND e.created_at > now() - interval '14 days'
      AND COALESCE(NULLIF(e.metadata->>'mcp_conversation_id', ''),
        NULLIF(e.metadata->>'mcp_session_id', '')) IS NOT NULL
    GROUP BY 1, 2, 3, 4
  ),
  matched AS (
    SELECT mc.user_id, mc.client_identity, mc.conversation_id, c.organization_id,
      c.last_activity_at,
      count(*) OVER (PARTITION BY c.created_by, mc.client_identity, mc.conversation_id, c.organization_id)
        AS owners
    FROM calls c
    JOIN public.mcp_client_conversations mc
      ON mc.client_identity = c.client_id AND mc.conversation_id = c.activity_id
      AND (c.created_by IS NULL OR c.created_by = mc.user_id)
  )
  INSERT INTO public.mcp_client_conversation_workspaces (
    user_id, client_identity, conversation_id, organization_id, last_activity_at
  )
  SELECT m.user_id, m.client_identity, m.conversation_id, m.organization_id,
    max(m.last_activity_at)
  FROM matched m
  JOIN public.organization o ON o.id = m.organization_id
  WHERE m.owners = 1
  GROUP BY m.user_id, m.client_identity, m.conversation_id, m.organization_id
  ON CONFLICT (user_id, client_identity, conversation_id, organization_id)
  DO UPDATE SET last_activity_at = GREATEST(
    public.mcp_client_conversation_workspaces.last_activity_at,
    EXCLUDED.last_activity_at
  );

  ALTER TABLE public.mcp_client_conversations DROP COLUMN organization_id;
END
$migration$;

-- migrate:down
-- Forward-only: one workspace column cannot represent a conversation that
-- spans several.
