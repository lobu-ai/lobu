-- migrate:up
-- lobu:no-quiesce old code never reads the column, and a bundle it writes no longer matches the stamp's digest
-- `<compiler fingerprint>:<bundle digest>` for a compiled_code the server
-- compiled itself: the fingerprint covers the bootstrap, the bundled
-- @lobu/views runtime, pinned package versions and esbuild. NULL for a bundle
-- the caller supplied and for rows saved before this column existed. When the
-- digest still matches compiled_code and the fingerprint differs from the
-- running server's, the bundle is stale and the server rebuilds it from
-- source_code when the view is served. A writer that replaces compiled_code
-- without restamping leaves a mismatched digest, so that bundle is never
-- rebuilt.
ALTER TABLE public.views ADD COLUMN IF NOT EXISTS compile_config_hash text;

-- migrate:down

ALTER TABLE public.views DROP COLUMN IF EXISTS compile_config_hash;
