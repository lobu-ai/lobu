-- migrate:up transaction:false
-- Original member-pair decisions must remain discoverable after regrouping.
DO $heal$
DECLARE index_name text;
BEGIN
  FOR index_name IN SELECT c.relname FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT i.indisvalid
      AND c.relname IN ('idx_identity_rejected_members', 'idx_identity_withdrawn_members')
  LOOP EXECUTE format('DROP INDEX public.%I', index_name); END LOOP;
END
$heal$;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_identity_rejected_members
  ON runs USING gin ((action_input->'member_support'))
  WHERE approval_status = 'rejected' AND action_key = 'entity_change' AND action_input->>'operation' = 'link';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_identity_withdrawn_members
  ON entity_relationships USING gin ((metadata->'_lobu_identity_decision'->'member_support'))
  WHERE deleted_at IS NOT NULL;

-- migrate:down transaction:false
DROP INDEX CONCURRENTLY IF EXISTS idx_identity_withdrawn_members;
DROP INDEX CONCURRENTLY IF EXISTS idx_identity_rejected_members;
