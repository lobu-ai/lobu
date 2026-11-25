-- migrate:up
-- lobu:no-quiesce -- no code since the skills (20261125130000) and guardrails (20261125140000) reader cutovers reads or writes these columns, and an install still on older code has one of those quiesced migrations in the same batch.
--
-- Drop agents.skills_config, agents.guardrails and agents.guardrails_inline.
-- The reader cutovers backfilled them into the workspace skill and guardrail
-- libraries and stopped every reader and writer; the columns were kept only so
-- a code rollback past those cutovers still found its data.
--
-- OPERATIONAL COST: catalog-only, no row rewrite. ACCESS EXCLUSIVE on agents
-- until the transaction commits, bounded by the 5s lock wait. agents is a small
-- config table (under 100 rows in production); not timed at production size.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.agents
  DROP COLUMN IF EXISTS skills_config,
  DROP COLUMN IF EXISTS guardrails,
  DROP COLUMN IF EXISTS guardrails_inline;

-- migrate:down

-- Restores the columns empty; the data lives in the workspace libraries.
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS skills_config jsonb DEFAULT '{"skills": []}'::jsonb,
  ADD COLUMN IF NOT EXISTS guardrails jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS guardrails_inline jsonb DEFAULT '[]'::jsonb;
