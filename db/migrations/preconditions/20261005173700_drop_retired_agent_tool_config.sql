-- Read-only prerequisite; fresh databases and already-dropped columns pass.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'tools_config'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.agents WHERE tools_config IS NOT NULL AND tools_config <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'Refusing to drop nonempty agents.tools_config; the settings API that managed it is gone in this release. Review the rows with SELECT id, organization_id, tools_config FROM agents WHERE tools_config IS NOT NULL AND tools_config <> ''{}''::jsonb, then clear them with UPDATE agents SET tools_config = ''{}''::jsonb WHERE tools_config IS NOT NULL AND tools_config <> ''{}''::jsonb; before retrying (docs/MIGRATIONS.md)';
    END IF;
  END IF;
END
$guard$;
