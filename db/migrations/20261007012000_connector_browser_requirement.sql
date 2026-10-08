-- migrate:up
-- lobu:no-quiesce
-- Additive metadata; old replicas ignore the declaration during rollout.
ALTER TABLE connector_definitions ADD COLUMN IF NOT EXISTS browser jsonb;

-- migrate:down
ALTER TABLE connector_definitions DROP COLUMN IF EXISTS browser;
