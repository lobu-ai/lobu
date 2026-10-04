-- migrate:up transaction:false

-- A remote record's Lobu activity stream reads `entity_refs @> ARRAY[ref]`.
-- Only Lobu-authored events carry refs, so the partial index stays small.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'idx_events_entity_refs'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_events_entity_refs';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_entity_refs
  ON public.events USING gin (entity_refs)
  WHERE entity_refs IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_entity_refs;
