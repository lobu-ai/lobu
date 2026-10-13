-- Ordered index for the org-wide activity feed.
--
-- The chronological feed (listContentInternal in
-- packages/server/src/utils/content-search/list-path.ts) pages newest-first on
-- the effective occurrence time, COALESCE(occurred_at, created_at), with id as
-- the tiebreaker. idx_events_live_org_created keys on created_at alone, so no
-- index matched that ORDER BY and every page sorted all of an org's matching
-- live events to return a few dozen. These keys match the ORDER BY exactly, so
-- the feed's direct-org arm (organization_id = $org) becomes an index condition
-- plus an ordered scan that stops at the page's LIMIT; a since/until window is
-- restated on the same expression so it bounds the scan too. Keep the key
-- expression byte-aligned with buildDateCandidateOrderBy and EFFECTIVE_AT_SQL.
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
      AND c.relname = 'idx_events_live_org_effective_date'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_events_live_org_effective_date';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_live_org_effective_date
  ON public.events (organization_id, (COALESCE(occurred_at, created_at)) DESC, id DESC)
  WHERE superseded_by IS NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_live_org_effective_date;
