-- migrate:up
-- lobu:no-quiesce -- #3836 removed all readers/writers and is fully deployed.
-- Contract phase: remove only the dormant column; preserve agents and history.
-- Cost: one bounded agents scan, then an O(1) metadata drop under a short
-- ACCESS EXCLUSIVE lock (no row rewrite). A read-only production scan of 53
-- agents took 0.034s; guard + drop took 0.0014s on a local 53-row fixture.
-- No production DDL was executed for this measurement.
SET LOCAL lock_timeout = '2s';
LOCK TABLE public.agents IN ACCESS EXCLUSIVE MODE;

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

-- squawk-ignore ban-drop-column -- reader removal shipped in the prior release
ALTER TABLE public.agents DROP COLUMN IF EXISTS tools_config;

-- migrate:down
-- The guard admitted only NULL/{}; rollback restores the empty schema slot.
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS tools_config jsonb DEFAULT '{}'::jsonb;
