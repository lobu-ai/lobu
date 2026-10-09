-- migrate:up
-- Phase one: stop physical execution and remove runtime column readers.
-- Existing historical ledgers become audit-only; identifiers and snapshots stay.
-- Owner-operated cleanup is required before removing physical merge execution.
-- Fresh installs run preconditions before their baseline tables exist.
DO $retirement$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'entities' AND column_name IN ('merged_into')) = 1 THEN
    IF EXISTS (SELECT 1 FROM public.entities WHERE merged_into IS NOT NULL) THEN
      RAISE EXCEPTION 'Physical merge redirects remain; run the verified, backed-up retirement maintenance before upgrading';
    END IF;
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'entity_merge_operations' AND column_name IN ('status')) = 1 THEN
    IF EXISTS (SELECT 1 FROM public.entity_merge_operations WHERE status = 'active') THEN
      RAISE EXCEPTION 'Active physical merge ledgers remain; retire them through verified maintenance before upgrading';
    END IF;
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'runs' AND column_name IN ('action_key', 'action_input', 'approval_status', 'status')) = 4 THEN
    IF EXISTS (SELECT 1 FROM public.runs WHERE action_key = 'entity_change'
      AND action_input->>'operation' IN ('merge', 'unmerge', 'resolve_duplicates')
      AND (approval_status IN ('pending', 'rejected') OR status IN ('pending', 'claimed', 'running'))) THEN
      RAISE EXCEPTION 'Physical merge approvals or executions remain; explicitly migrate their decisions before upgrading';
    END IF;
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'automations' AND column_name IN ('reaction_script', 'sources')) = 2 THEN
    IF EXISTS (SELECT 1 FROM public.automations
      WHERE COALESCE(reaction_script, '') ~ 'entities[[:space:]]*\.[[:space:]]*(manage|search|merge|unmerge|resolveDuplicates)[[:space:]]*\('
         OR COALESCE(reaction_script, '') ~ 'merged_into' OR sources::text ~ 'merged_into') THEN
      RAISE EXCEPTION 'Saved Automation callers still use retired entity methods or redirects; migrate the current configuration before upgrading';
    END IF;
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'entity_types' AND column_name IN ('deleted_at', 'metadata_schema')) = 2 THEN
    IF EXISTS (SELECT 1 FROM public.entity_types
      WHERE deleted_at IS NULL AND metadata_schema->'x-lobu-resolution' @> '{"rules":[{"onMatch":"auto_merge"}]}'::jsonb) THEN
      RAISE EXCEPTION 'Rename explicit automatic identity rules from auto_merge to auto_link before upgrading';
    END IF;
  END IF;
END
$retirement$;

-- Keep the column for rolling readers while fencing every physical writer.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.entities'::regclass AND conname = 'entities_physical_merge_retired') THEN
    ALTER TABLE public.entities ADD CONSTRAINT entities_physical_merge_retired CHECK (merged_into IS NULL) NOT VALID;
  END IF;
END $$;
-- squawk-ignore prefer-robust-stmts -- validation is repeatable; the runner wraps this migration in a transaction
ALTER TABLE public.entities VALIDATE CONSTRAINT entities_physical_merge_retired;

ALTER TABLE public.entity_merge_operations
  DROP CONSTRAINT IF EXISTS entity_merge_operations_winner_entity_id_fkey,
  DROP CONSTRAINT IF EXISTS entity_merge_operations_loser_entity_id_fkey;
COMMENT ON TABLE public.entity_merge_operations IS 'Historical physical merge audit. Execution and undo are retired; retain identifiers and snapshots.';

CREATE OR REPLACE FUNCTION lobu_guard_identity_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Phase one keeps the column for rolling readers but rejects every old writer.
  IF TG_OP = 'UPDATE' AND NEW.merged_into IS NOT NULL THEN
    RAISE EXCEPTION 'Physical entity merge is retired; use identity relationships';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.entity_type_id, NEW.deleted_at, NEW.merged_into)
     IS NOT DISTINCT FROM (OLD.organization_id, OLD.entity_type_id, OLD.deleted_at, OLD.merged_into) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM entity_relationships r JOIN entity_relationship_types t ON t.id = r.relationship_type_id
    WHERE r.deleted_at IS NULL AND t.purpose = 'identity' AND OLD.id IN (r.from_entity_id, r.to_entity_id)) THEN
    RAISE EXCEPTION 'Unlink identity associations before deleting or changing a member type or organization';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Physical merge retirement is irreversible; restore a reviewed backup to roll back';
END $$;
