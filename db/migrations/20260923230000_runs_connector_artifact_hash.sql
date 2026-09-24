-- migrate:up
-- Deliberately requires the existing quiesced deployment: old replicas must
-- stop admitting/claiming connector runs before this one-time cutover.
-- Cost: ADD COLUMN is metadata-only, with no history backfill. The cutover
-- updates pending connector runs only. Tested on fixtures, not production size.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE runs ADD COLUMN IF NOT EXISTS connector_artifact_hash text;

-- Today's mutable version row cannot prove yesterday's admitted identity.
-- Preserve the run as a visible failure; never guess its hash or replay it.
UPDATE runs r
SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
    approval_status = CASE WHEN approval_status = 'pending' THEN 'rejected' ELSE approval_status END,
    error_message = 'The admitted connector manifest was not recorded. Re-run this operation against the current device contract.'
WHERE r.status = 'pending'
  AND r.run_type IN ('sync', 'action', 'auth')
  AND r.connector_artifact_hash IS NULL
  AND (
    SELECT cv.source_path LIKE 'device-manifest://%'
      AND cv.compiled_code IS NULL AND cv.compile_config_hash IS NULL
      AND cv.source_code IS NULL AND cv.compiled_code_hash IS NOT NULL
    FROM connector_versions cv
    WHERE cv.connector_key = r.connector_key AND cv.version = r.connector_version
      AND (cv.organization_id = r.organization_id OR cv.organization_id IS NULL)
    ORDER BY cv.organization_id NULLS LAST
    LIMIT 1
  );

-- migrate:down
ALTER TABLE runs DROP COLUMN IF EXISTS connector_artifact_hash;
