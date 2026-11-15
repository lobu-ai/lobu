-- migrate:up transaction:false
-- lobu:no-quiesce (additive index; existing replicas remain compatible)
--
-- Personal-memory classification must recognize retired owner identities too:
-- retirement revokes access instead of turning the resource into ordinary data.
-- Index only this reserved namespace, with no row backfill or API change.
-- OPERATIONAL COST: two concurrent index-build scans of entity_identities,
-- without blocking ordinary reads or writes. Only personal-owner rows enter it.

-- Heal an invalid index left by an interrupted concurrent build before retrying.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_entity_identities_personal_owner'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_entity_identities_personal_owner';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_identities_personal_owner
  ON public.entity_identities (organization_id, entity_id)
  WHERE namespace = 'lobu_personal_memory_owner';

-- migrate:down transaction:false
-- lobu:no-quiesce (removes only the additive lookup index)

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_identities_personal_owner;
