-- migrate:up
-- lobu:no-quiesce additive: no code before this deploy selects either column
-- The workspace's curated sidebar navigation (`manage_views` get_navigation /
-- set_navigation). NULL means automatic defaults, so every existing workspace
-- keeps its current sidebar with no backfill. The document is replaced whole;
-- navigation_revision is the compare-and-swap token a writer must present, and
-- moves only on a successful write.
ALTER TABLE public.organization ADD COLUMN IF NOT EXISTS navigation_config jsonb;
ALTER TABLE public.organization ADD COLUMN IF NOT EXISTS navigation_revision bigint DEFAULT 0 NOT NULL;

-- migrate:down

ALTER TABLE public.organization DROP COLUMN IF EXISTS navigation_revision;
ALTER TABLE public.organization DROP COLUMN IF EXISTS navigation_config;
