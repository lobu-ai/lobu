-- migrate:up transaction:false

-- Conversation admission probes only unfinished turns. Repair an interrupted
-- concurrent build before IF NOT EXISTS can preserve its invalid index.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_runs_agent_turn_conversation_active'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_runs_agent_turn_conversation_active';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_agent_turn_conversation_active
  ON public.runs (organization_id,
    ((action_input->'turn'->>'agent_id')),
    ((action_input->'turn'->>'conversation_id')), id)
  WHERE run_type = 'agent_turn' AND status IN ('pending', 'claimed', 'running');

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_runs_agent_turn_conversation_active;
