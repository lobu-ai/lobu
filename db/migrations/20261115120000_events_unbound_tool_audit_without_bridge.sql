-- migrate:up
-- lobu:no-quiesce  (additive and weaker than the constraint it will replace: every row the running code inserts already satisfies it)
--
-- First of three steps that drop events.linked_org_ids, the retired
-- cross-workspace bridge that nothing has read or written since
-- 20261114120000. events_unbound_tool_audit names that column, so dropping
-- the column would silently drop the constraint too. This adds its
-- replacement, identical except for the linked_org_ids term.
--
-- OPERATIONAL COST: catalog-only. ACCESS EXCLUSIVE on events for the catalog
-- update, bounded by the 5s lock wait. NOT VALID skips the table scan; the
-- next migration validates under a lock that does not block reads or writes.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.events'::regclass
      AND conname = 'events_unbound_tool_audit_owned'
  ) THEN
    ALTER TABLE public.events ADD CONSTRAINT events_unbound_tool_audit_owned CHECK (
      organization_id IS NOT NULL OR (
        semantic_type = 'audit' AND origin_type IS NOT DISTINCT FROM 'tool_invocation'
        AND COALESCE(cardinality(entity_ids), 0) = 0
        AND connector_key IS NULL AND connection_id IS NULL
        AND feed_key IS NULL AND feed_id IS NULL AND run_id IS NULL
        AND automation_id IS NULL AND automation_version_id IS NULL
        AND identity_ns IS NULL AND identity_key IS NULL
        AND supersedes_event_id IS NULL AND superseded_by IS NULL
        AND interaction_type = 'none'
      )
    ) NOT VALID;
  END IF;
END $$;

-- migrate:down
-- lobu:no-quiesce
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_unbound_tool_audit_owned;
