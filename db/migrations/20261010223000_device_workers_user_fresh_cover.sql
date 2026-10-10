-- Index fresh-device lookups by owner for poll-time fleet reconciliation.
--
-- reconcileDeviceCapabilities (device-reconcile.ts) reads id and capabilities;
-- INCLUDE allows index-only scans when heap pages are all-visible.
-- getDeviceManifestSourcesForUser (device-manifests.ts) uses the same range
-- but still fetches connector_manifests for every matching device. Keep that
-- potentially large JSONB out of the index to avoid B-tree tuple-size limits.
-- Heartbeats update last_seen_at, so the index adds write overhead and fresh
-- rows can still require heap visibility checks for the capabilities query.
--
-- transaction:false for the CONCURRENTLY index build; every statement is
-- individually rerunnable so a partial failure can retry.

-- migrate:up transaction:false
-- lobu:no-quiesce

DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_device_workers_user_fresh_cover'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_device_workers_user_fresh_cover';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_workers_user_fresh_cover
  ON public.device_workers (user_id, last_seen_at)
  INCLUDE (id, platform, capabilities);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_device_workers_user_fresh_cover;
