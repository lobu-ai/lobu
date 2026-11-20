-- migrate:up transaction:false
-- lobu:no-quiesce

-- Agent-scoped recall and listing filter live events by the memory-scope key
-- `metadata->>'agent_id'`. Without an index that predicate is a filter over
-- every live event in the organization; the agent's rows are a small sliver.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'idx_events_live_org_agent'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_events_live_org_agent';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_live_org_agent
  ON public.events (organization_id, (metadata ->> 'agent_id'))
  WHERE superseded_by IS NULL AND (metadata ->> 'agent_id') IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_live_org_agent;
