-- Only the two conditions a human must resolve before physical merge execution
-- is removed: decisions still waiting on a merge, and saved Automation code
-- that calls retired entity methods. Redirects, active ledgers and auto_merge
-- rules are repaired during the upgrade by
-- 20261009015900_retire_remaining_physical_merges.sql, which sorts first.
-- Fresh installs run preconditions before their baseline tables exist.
DO $retirement$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'runs' AND column_name IN ('action_key', 'action_input', 'approval_status', 'status')) = 4 THEN
    IF EXISTS (SELECT 1 FROM public.runs WHERE action_key = 'entity_change'
      AND action_input->>'operation' IN ('merge', 'unmerge', 'resolve_duplicates')
      AND (approval_status IN ('pending', 'rejected') OR status IN ('pending', 'claimed', 'running'))) THEN
      RAISE EXCEPTION 'Physical merge approvals or executions remain; finish, cancel or delete them before upgrading (docs/MIGRATIONS.md). List them with: SELECT id, organization_id, status, approval_status, action_input->>''operation'' AS operation FROM runs WHERE action_key = ''entity_change'' AND action_input->>''operation'' IN (''merge'', ''unmerge'', ''resolve_duplicates'') AND (approval_status IN (''pending'', ''rejected'') OR status IN (''pending'', ''claimed'', ''running''))';
    END IF;
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'automations' AND column_name IN ('reaction_script', 'sources')) = 2 THEN
    IF EXISTS (SELECT 1 FROM public.automations
      WHERE COALESCE(reaction_script, '') ~ 'entities[[:space:]]*\.[[:space:]]*(manage|search|merge|unmerge|resolveDuplicates)[[:space:]]*\('
         OR COALESCE(reaction_script, '') ~ 'merged_into' OR sources::text ~ 'merged_into') THEN
      RAISE EXCEPTION 'Saved Automation scripts still call retired entity methods or read merged_into; edit them before upgrading (docs/MIGRATIONS.md). List them with: SELECT id, organization_id, name FROM automations WHERE COALESCE(reaction_script, '''') ~ ''entities[[:space:]]*\.[[:space:]]*(manage|search|merge|unmerge|resolveDuplicates)[[:space:]]*\('' OR COALESCE(reaction_script, '''') ~ ''merged_into'' OR sources::text ~ ''merged_into''';
    END IF;
  END IF;
END
$retirement$;
