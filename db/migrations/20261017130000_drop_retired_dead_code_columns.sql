-- migrate:up
-- lobu:no-quiesce -- contract phase after code stopped reading/writing these columns (#2818 follow-up sweep).
-- Phase-2 DROP COLUMN for 9 retired slots already removed from QUERYABLE_SCHEMA
-- exposure ahead of the drop (two-phase change per docs/GOTCHAS.md):
-- entities.enabled_classifiers + automation_versions.classifiers (retired with
-- Automation classifier extraction), connector_definitions.default_repair_agent_id
-- + feeds.repair_* x5 (retired with the connector repair-agent subsystem), and
-- automations.scheduler_client_id (retired with the scheduler rework in #2499).
-- Cost: catalog-only drops under ACCESS EXCLUSIVE, with a 2s lock-wait limit
-- and no row rewrite. The feeds_open_repair_thread_uniq partial unique index
-- and the idx_entities_classifiers GIN index go with their columns.
SET LOCAL lock_timeout = '2s';

-- squawk-ignore ban-drop-column -- contract phase after retired-column reads/writes stopped
ALTER TABLE public.entities DROP COLUMN IF EXISTS enabled_classifiers;

-- squawk-ignore ban-drop-column -- contract phase after retired-column reads/writes stopped
ALTER TABLE public.automation_versions DROP COLUMN IF EXISTS classifiers;

-- squawk-ignore ban-drop-column -- contract phase after retired-column reads/writes stopped
ALTER TABLE public.connector_definitions DROP COLUMN IF EXISTS default_repair_agent_id;

-- squawk-ignore ban-drop-column -- contract phase after retired-column reads/writes stopped
ALTER TABLE public.feeds
  DROP COLUMN IF EXISTS repair_agent_id,
  DROP COLUMN IF EXISTS repair_thread_id,
  DROP COLUMN IF EXISTS repair_attempt_count,
  DROP COLUMN IF EXISTS last_repair_at,
  DROP COLUMN IF EXISTS last_repair_post_hash;

-- squawk-ignore ban-drop-column -- contract phase after retired-column reads/writes stopped
ALTER TABLE public.automations DROP COLUMN IF EXISTS scheduler_client_id;

-- migrate:down
ALTER TABLE public.entities ADD COLUMN IF NOT EXISTS enabled_classifiers text[];
ALTER TABLE public.automation_versions ADD COLUMN IF NOT EXISTS classifiers jsonb;
ALTER TABLE public.connector_definitions ADD COLUMN IF NOT EXISTS default_repair_agent_id text;
ALTER TABLE public.feeds ADD COLUMN IF NOT EXISTS repair_agent_id text;
ALTER TABLE public.feeds ADD COLUMN IF NOT EXISTS repair_thread_id text;
ALTER TABLE public.feeds ADD COLUMN IF NOT EXISTS repair_attempt_count integer DEFAULT 0 NOT NULL;
ALTER TABLE public.feeds ADD COLUMN IF NOT EXISTS last_repair_at timestamp with time zone;
ALTER TABLE public.feeds ADD COLUMN IF NOT EXISTS last_repair_post_hash text;
ALTER TABLE public.automations ADD COLUMN IF NOT EXISTS scheduler_client_id text;
