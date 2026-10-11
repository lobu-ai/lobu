-- Partial index for the org-guidance read in managed-agent prompts.
--
-- loadOrgGuidanceBlock (packages/server/src/utils/org-guidance.ts) selects
-- current guidance with both connection_id and connector_key NULL and text
-- present, ordered by id with LIMIT 101. These keys and the matching predicate
-- allow an ordered index scan; title and payload_text still require heap reads.
-- Keep the predicate aligned with the query. Its bound semantic_type permits
-- this partial index in a custom plan, but not in a generic plan.
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
      AND c.relname = 'idx_events_org_guidance'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_events_org_guidance';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_org_guidance
  ON public.events (organization_id, id)
  WHERE (superseded_by IS NULL)
    AND (semantic_type = 'guidance'::text)
    AND (connection_id IS NULL)
    AND (connector_key IS NULL)
    AND (payload_text IS NOT NULL);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_org_guidance;
