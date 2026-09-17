-- Attach index for `views` (phase 1).
--
-- Mount-point reads filter views by their attach lines (`attach @> ...`), so
-- the payload gets a GIN index like the other jsonb filter columns. Split
-- from 20260917000000_views because CONCURRENTLY cannot run inside that
-- file's transactional section (one statement per transaction:false file).
-- migrate:up transaction:false
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_views_attach
    ON public.views USING gin (attach);

-- migrate:down transaction:false
DROP INDEX CONCURRENTLY IF EXISTS public.idx_views_attach;
