-- Read-only prerequisite; fresh databases and already-dropped columns pass.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'tools_config'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.agents WHERE tools_config IS NOT NULL AND tools_config <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'Refusing to drop nonempty agents.tools_config; review and explicitly clear retired settings before retrying';
    END IF;
  END IF;
END
$guard$;
