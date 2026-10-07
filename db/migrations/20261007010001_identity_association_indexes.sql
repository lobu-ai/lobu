-- migrate:up transaction:false
-- Three partial indexes scan existing relationships/runs without blocking writes.
-- Production-size timings have not been measured; no history is rewritten.
-- Retry an interrupted concurrent build instead of preserving an invalid index.
DO $heal$
DECLARE index_name text;
BEGIN
  FOR index_name IN SELECT c.relname FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT i.indisvalid
      AND c.relname IN ('idx_identity_withdrawal_pair', 'idx_identity_rejected_pair', 'idx_merge_rejected_members')
  LOOP
    EXECUTE format('DROP INDEX public.%I', index_name);
  END LOOP;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_identity_withdrawal_pair ON entity_relationships
  (organization_id, LEAST(from_entity_id, to_entity_id), GREATEST(from_entity_id, to_entity_id), updated_at DESC)
  WHERE metadata ? '_lobu_identity_decision' AND deleted_at IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_identity_rejected_pair ON runs (organization_id, (action_input->>'identity_pair'), id DESC)
  WHERE approval_status = 'rejected' AND action_key = 'entity_change';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_merge_rejected_members ON runs USING gin (lobu_resolution_members(action_input))
  WHERE approval_status = 'rejected' AND action_key = 'entity_change' AND action_input->>'operation' = 'merge';

-- migrate:down transaction:false
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM entity_relationship_types WHERE purpose = 'identity') THEN
    RAISE EXCEPTION 'Identity association types must be migrated before rollback';
  END IF;
END $$;
DROP INDEX CONCURRENTLY IF EXISTS idx_merge_rejected_members;
DROP INDEX CONCURRENTLY IF EXISTS idx_identity_rejected_pair;
DROP INDEX CONCURRENTLY IF EXISTS idx_identity_withdrawal_pair;
