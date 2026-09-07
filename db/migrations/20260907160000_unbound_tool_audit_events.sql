-- migrate:up
-- Only standalone tool-call audits may have no workspace. In particular,
-- resource links must not expose a private call through workspace visibility.
--
-- OPERATIONAL COST: adding the NOT VALID constraint and dropping NOT NULL are
-- catalog-only operations, but VALIDATE scans the full events table with the
-- earlier ACCESS EXCLUSIVE lock held until the migration transaction ends. This has not been timed on
-- a production-sized copy; deployment quiesces application writers first.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.events'::regclass
      AND conname = 'events_unbound_tool_audit'
  ) THEN
    ALTER TABLE public.events ADD CONSTRAINT events_unbound_tool_audit CHECK (
      organization_id IS NOT NULL OR (
        semantic_type = 'audit' AND origin_type IS NOT DISTINCT FROM 'tool_invocation'
        AND COALESCE(cardinality(entity_ids), 0) = 0
        AND COALESCE(cardinality(linked_org_ids), 0) = 0
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

-- Validate before relaxing NOT NULL; existing rows retain their ownership.
-- squawk-ignore prefer-robust-stmts -- the guarded block above creates the constraint; dbmate wraps both statements in one transaction
ALTER TABLE public.events VALIDATE CONSTRAINT events_unbound_tool_audit;
-- squawk-ignore prefer-robust-stmts,ban-drop-not-null -- the validated constraint is the replacement invariant; nullable rows are the purpose of this migration
ALTER TABLE public.events ALTER COLUMN organization_id DROP NOT NULL;

-- Require an actor at insertion, while allowing the existing user FK to
-- anonymize created_by on account deletion without deleting audit history.
CREATE OR REPLACE FUNCTION public.require_unbound_tool_audit_actor()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS NULL AND NEW.created_by IS NULL THEN
    RAISE EXCEPTION 'A tool audit without a workspace requires a user'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS require_unbound_tool_audit_actor ON public.events;
CREATE TRIGGER require_unbound_tool_audit_actor BEFORE INSERT ON public.events
FOR EACH ROW WHEN (NEW.organization_id IS NULL)
EXECUTE FUNCTION public.require_unbound_tool_audit_actor();

-- migrate:down
-- Forward-only: existing unbound audit records must remain append-only.
