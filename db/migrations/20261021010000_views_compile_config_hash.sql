-- migrate:up
-- lobu:no-quiesce old code never reads the column; the one gap is an old pod
-- storing a CLI-built bundle over a row a new pod stamped during the same
-- rollout, which a later serve would rebuild from the same source
-- Fingerprint of the server view compiler (bootstrap, bundled @lobu/views
-- runtime, pinned package versions, esbuild) that produced compiled_code.
-- Set only when the server compiled the bundle itself; NULL for a bundle the
-- caller supplied and for rows saved before this column existed. A non-NULL
-- value that differs from the running server's fingerprint marks the bundle
-- stale, and the server rebuilds it from source_code when the view is served.
ALTER TABLE public.views ADD COLUMN IF NOT EXISTS compile_config_hash text;

-- migrate:down

ALTER TABLE public.views DROP COLUMN IF EXISTS compile_config_hash;
