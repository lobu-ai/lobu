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
