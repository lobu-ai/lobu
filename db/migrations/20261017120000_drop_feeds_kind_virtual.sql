-- migrate:up
-- lobu:no-quiesce -- requires #4186's channel-feed writer removal to be fully deployed first.
-- Contract phase of #3132/#3134: per-feed operations in
-- connector_definitions.feeds_schema and feeds.config.store replaced the
-- transitional kind/virtual discriminators. Cost: a catalog-only drop under
-- ACCESS EXCLUSIVE, with a 2s lock-wait limit and no row rewrite. Execution
-- time at production size has not been measured here. The CHECK constraint
-- and NOT NULL markers go with the columns.
SET LOCAL lock_timeout = '2s';

-- squawk-ignore ban-drop-column -- contract phase after #4186's writer removal
ALTER TABLE public.feeds DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS virtual;

-- migrate:down
-- Restores the slots written by the capability-era channel-feed insert before
-- #4186, with the original defaults and CHECK. Channel feeds recover their
-- 'streaming' marker from config.store; other feeds receive collected/false.
-- This does not reconstruct legacy source-read flags for pre-capability code.
ALTER TABLE public.feeds ADD COLUMN IF NOT EXISTS virtual boolean NOT NULL DEFAULT false;
ALTER TABLE public.feeds ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'collected';
UPDATE public.feeds SET kind = 'streaming'
WHERE config ->> 'store' = 'channel_messages' AND kind <> 'streaming';
ALTER TABLE public.feeds DROP CONSTRAINT IF EXISTS feeds_kind_check;
ALTER TABLE public.feeds
  ADD CONSTRAINT feeds_kind_check CHECK (kind IN ('collected', 'streaming', 'virtual')) NOT VALID;
ALTER TABLE public.feeds VALIDATE CONSTRAINT feeds_kind_check;
