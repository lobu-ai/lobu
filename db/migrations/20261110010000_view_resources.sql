-- migrate:up
-- lobu:no-quiesce additive with a default: code before this deploy never selects the column, and its inserts get []
-- External origins a view may load images from, read from its module's
-- `defineView({ resources })` on save. Every existing view declares none, so
-- the constant default covers them with no backfill; a constant default makes
-- this a metadata-only change, not a table rewrite.
ALTER TABLE public.views ADD COLUMN IF NOT EXISTS resources jsonb NOT NULL DEFAULT '[]'::jsonb;

-- migrate:down

ALTER TABLE public.views DROP COLUMN IF EXISTS resources;
