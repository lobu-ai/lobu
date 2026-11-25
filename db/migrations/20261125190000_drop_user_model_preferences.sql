-- migrate:up
-- lobu:quiesce code before #5193 (release 24.15.0 and earlier) reads user_model_preferences when it lists Claude model options, including while routing a run, and would fail against the dropped table.
--
-- Drop user_model_preferences. #5193 removed ModelPreferenceStore, its only
-- reader and writer; no caller ever set a preference, and the table held no
-- rows in production when it was dropped.
--
-- OPERATIONAL COST: catalog-only drop of an empty table. ACCESS EXCLUSIVE on
-- user_model_preferences until the transaction commits, bounded by the 5s
-- lock wait.
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS public.user_model_preferences;

-- migrate:down

-- Restores the table empty, as it was in production.
CREATE TABLE IF NOT EXISTS public.user_model_preferences (
    user_id text NOT NULL,
    provider_id text NOT NULL,
    model text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_model_preferences_pkey PRIMARY KEY (user_id, provider_id)
);
