-- migrate:up
-- Exact operation keys already name a connector. Persist that target so a
-- connector-wide rule cannot outrank its own exact-action exception.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM write_approval_policies
    WHERE resource_class = 'connector_action' AND operation_key IS NOT NULL
      AND connector_key IS NULL AND connection_id IS NULL
      AND (strpos(operation_key, '::') <= 1 OR length(operation_key) = strpos(operation_key, '::') + 1)
  ) THEN
    RAISE EXCEPTION 'Exact connector policies must use qualified connector::action keys before migration';
  END IF;
END $$;

-- The existing unique scope index deliberately aborts on collisions. Never
-- choose between two existing decisions or merge their delivery targets here.
UPDATE write_approval_policies
SET connector_key = split_part(operation_key, '::', 1)
WHERE resource_class = 'connector_action' AND operation_key IS NOT NULL
  AND connector_key IS NULL AND connection_id IS NULL;

ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_exact_target_check;
ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT write_approval_policies_exact_target_check CHECK (
    operation_key IS NULL OR connector_key IS NOT NULL OR connection_id IS NOT NULL
  ) NOT VALID;
ALTER TABLE write_approval_policies
  VALIDATE CONSTRAINT write_approval_policies_exact_target_check;

-- migrate:down
-- Canonical targets are valid in the previous schema; keep their identity and
-- decisions rather than inventing which rows originally omitted the connector.
ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_exact_target_check;
