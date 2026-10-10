-- migrate:up transaction:false
-- lobu:no-quiesce

-- handleListRuns (packages/server/src/tools/admin/manage_operations/handlers/runs.ts)
-- defaults to excluding chat_message and pages by (created_at DESC, id DESC).
-- Unlike idx_runs_org, this index omits that lane and supports the page order
-- and keyset cursor. The default count can use an index-only scan when
-- visibility permits, but still scans all matching operational runs.
--
-- Match LIST_RUNS_DEFAULT_EXCLUDED_RUN_TYPES in
-- packages/core/src/contracts/tools/manage-operations.ts. Recheck query plans
-- if that list changes; a generic plan cannot infer this predicate from the
-- query's bound exclusion array.
--
-- Concurrent creation scans runs without blocking normal reads and writes;
-- production-size build timing has not been measured here. Heal any INVALID
-- remnant before retrying IF NOT EXISTS after an interrupted build.

DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_runs_org_default_view'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_runs_org_default_view';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_org_default_view
  ON public.runs (organization_id, created_at DESC, id DESC)
  WHERE (run_type <> ALL (ARRAY['chat_message'::text]));

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_runs_org_default_view;
