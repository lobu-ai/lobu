-- migrate:up
-- lobu:no-quiesce
-- One row per installation: the random id the anonymous daily install ping
-- reports, so the same install is counted once across days, restarts and
-- replicas. Created lazily by the first ping (INSERT ... ON CONFLICT DO
-- NOTHING); nothing else reads it. The boolean primary key with CHECK pins the
-- table to a single row.
--
-- New table only: code running before this deploy never reads it.
CREATE TABLE IF NOT EXISTS public.instance_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  install_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- migrate:down

DROP TABLE IF EXISTS public.instance_identity;
