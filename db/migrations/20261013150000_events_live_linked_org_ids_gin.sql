-- Live-only GIN for the activity feed's linked-org arm.
--
-- With linked-org scope enabled, the feed and its count read
-- current_event_records (superseded_by IS NULL) and split the org scope into
-- a direct arm (organization_id = $org) and a
-- linked arm (linked_org_ids @> ARRAY[$org]). idx_events_linked_org_ids covers
-- every version. To enforce the live predicate, the planner can AND its bitmap
-- with a whole-index scan of idx_events_live_org_effective_date, reading every
-- live row's entry. This partial GIN lets the linked arm find live matches
-- without that extra bitmap scan.
-- idx_events_linked_org_ids stays for reads that include superseded rows.
--
-- transaction:false for the CONCURRENTLY index build; every statement is
-- individually rerunnable so a partial failure can retry.

-- migrate:up transaction:false
-- lobu:no-quiesce

DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_events_live_linked_org_ids'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_events_live_linked_org_ids';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_live_linked_org_ids
  ON public.events USING gin (linked_org_ids)
  WHERE superseded_by IS NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_live_linked_org_ids;
