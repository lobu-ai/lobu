-- migrate:up
-- lobu:no-quiesce adds a nullable column that old code never reads or writes
-- Fingerprint of the server view compiler (bootstrap, bundled @lobu/views
-- runtime, pinned package versions, esbuild) that produced compiled_code.
-- Set only when the server compiled the bundle itself; NULL for a bundle the
-- caller supplied and for rows saved before this column existed. A non-NULL
-- value that differs from the running server's fingerprint marks the bundle
-- stale, and the server rebuilds it from source_code when the view is served.
ALTER TABLE public.views ADD COLUMN IF NOT EXISTS compile_config_hash text;

-- migrate:down

ALTER TABLE public.views DROP COLUMN IF EXISTS compile_config_hash;
