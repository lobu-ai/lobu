-- The previous normalizer discarded resource-identifying query data. There is
-- no generic way to reconstruct it from connector input. Retire these runs;
-- recreation must require a fresh full target rather than copying the old one.
-- The marker is stamped by the new writer in existing run_metadata. New readers
-- also reject unmarked rows written by old replicas during a rolling deployment.
-- migrate:up
UPDATE runs
SET status = 'failed', completed_at = current_timestamp,
    expires_at = LEAST(expires_at, current_timestamp),
    error_message = 'The original page target was lost. Create a new draft with its full URL.'
WHERE activation_kind = 'page_visit'
  AND status IN ('pending', 'running')
  AND run_metadata->>'page_activation_identity' IS DISTINCT FROM 'exact';

-- migrate:down
-- Irreversible: discarded URL identity cannot be restored safely.
