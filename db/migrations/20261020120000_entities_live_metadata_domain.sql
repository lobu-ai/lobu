-- Domain uniqueness covers live entities only.
--
-- idx_entities_metadata_domain had no deleted_at predicate, so a tombstoned
-- entity kept reserving its metadata.domain and every later create with that
-- domain failed as a duplicate. The replacement keeps the same key, adding
-- deleted_at IS NULL so a tombstone releases its domain while two live
-- entities in one organization still cannot share one. No ON CONFLICT targets
-- this index; it only rejects duplicates.
--
-- Build the replacement CONCURRENTLY before dropping the old index so live
-- uniqueness stays enforced. The normal path allows writes; repairing an
-- invalid index uses a regular DROP and needs an exclusive table lock.
-- transaction:false permits CONCURRENTLY and rerunning either section after
-- a partial failure.

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
      AND c.relname = 'idx_entities_live_metadata_domain'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_entities_live_metadata_domain';
  END IF;
END
$heal$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_entities_live_metadata_domain
  ON public.entities ((metadata ->> 'domain'), organization_id)
  WHERE metadata ->> 'domain' IS NOT NULL AND deleted_at IS NULL;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entities_metadata_domain;

-- migrate:down transaction:false

-- Fails if a live entity has since claimed a tombstone's domain; resolve those
-- duplicates before rolling back. A failed concurrent build leaves an invalid
-- index that IF NOT EXISTS would skip on retry, so heal it before rebuilding.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_entities_metadata_domain'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_entities_metadata_domain';
  END IF;
END
$heal$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_entities_metadata_domain
  ON public.entities ((metadata ->> 'domain'), organization_id)
  WHERE metadata ->> 'domain' IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entities_live_metadata_domain;
