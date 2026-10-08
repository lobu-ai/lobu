-- migrate:up
-- lobu:no-quiesce
-- Release N+1: deploy release N to remove runtime readers and fence old writers
-- before applying this migration.
-- DROP COLUMN is metadata-only (no table rewrite), with a brief ACCESS EXCLUSIVE
-- lock on entities. Local integration measured 5.9ms over 18,001 synthetic rows,
-- with no table rewrite (live catalog: 17,905 rows on 2026-10-08). Production
-- lock contention is not measured; bound lock waiting to 5s.
-- The column owns its empty partial index, removed by DROP COLUMN without
-- CASCADE. External tracked dependencies must block instead of disappearing.
-- Historical ledger rows/constraints and identity provenance remain untouched.
SET LOCAL lock_timeout = '5s';

-- Existing installations must deploy the first retirement release before this
-- contract release. Fresh installs and pre-column schemas have no old readers
-- of this column; historical migrations will establish the fence in order.
DO $retirement$
DECLARE entities_oid oid := to_regclass('public.entities');
BEGIN
  IF entities_oid IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = entities_oid AND attname = 'merged_into' AND NOT attisdropped
  ) THEN
    IF EXISTS (SELECT 1 FROM public.entities WHERE merged_into IS NOT NULL) THEN
      RAISE EXCEPTION 'Physical merge redirects remain; complete audited maintenance with the first physical-merge retirement release before upgrading';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = entities_oid AND conname = 'entities_physical_merge_retired'
        AND contype = 'c' AND convalidated
        AND pg_get_expr(conbin, conrelid) = '(merged_into IS NULL)'
    ) THEN
      RAISE EXCEPTION 'Deploy the first physical-merge retirement release with its validated redirect fence before upgrading';
    END IF;
  END IF;
END
$retirement$;

CREATE OR REPLACE FUNCTION public.lobu_guard_identity_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.entity_type_id, NEW.deleted_at)
     IS NOT DISTINCT FROM (OLD.organization_id, OLD.entity_type_id, OLD.deleted_at) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM entity_relationships r JOIN entity_relationship_types t ON t.id = r.relationship_type_id
    WHERE r.deleted_at IS NULL AND t.purpose = 'identity' AND OLD.id IN (r.from_entity_id, r.to_entity_id)) THEN
    RAISE EXCEPTION 'Unlink identity associations before deleting or changing a member type or organization';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

ALTER TABLE public.entities
  DROP CONSTRAINT IF EXISTS entities_physical_merge_retired RESTRICT,
  DROP CONSTRAINT IF EXISTS entities_merged_into_fkey RESTRICT,
  DROP COLUMN IF EXISTS merged_into RESTRICT;
DROP FUNCTION IF EXISTS public.lobu_resolution_members(jsonb) RESTRICT;

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Physical merge retirement is irreversible; restore a reviewed backup to roll back';
END $$;
