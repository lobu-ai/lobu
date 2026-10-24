-- migrate:up transaction:false
-- lobu:no-quiesce

-- Each authorized connection/event-type pair has an independently bounded
-- arrival scan. Unrelated source history cannot increase page scan work.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'idx_events_source_reference_arrival'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_events_source_reference_arrival';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_source_reference_arrival
  ON public.events (organization_id, connection_id, semantic_type, created_at, id)
  WHERE origin_type = 'source_reference' AND payload_type = 'empty'
    AND cardinality(COALESCE(entity_ids, '{}'::bigint[])) = 0;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_source_reference_arrival;
