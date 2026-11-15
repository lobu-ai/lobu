-- migrate:up transaction:false
-- lobu:no-quiesce (additive index; old replicas keep using the live partial index)
--
-- Resource retirement preserves event access requirements. The read gate unions
-- live and retired resources, using a type index for each arm instead of scanning
-- every entity in the workspace. No row backfill is needed.
-- OPERATIONAL COST: two concurrent index-build scans of entities, without blocking
-- ordinary reads or writes. Only soft-deleted rows enter the new index.

-- Heal an invalid index left by an interrupted concurrent build before retrying.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_entities_retired_type_id'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_entities_retired_type_id';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entities_retired_type_id
  ON public.entities (entity_type_id)
  WHERE deleted_at IS NOT NULL;

-- migrate:down transaction:false
-- lobu:no-quiesce (removes only the additive lookup index)

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entities_retired_type_id;
