-- migrate:up
-- lobu:no-quiesce  (additive: old code never selects audience, so during rollout an audience guardrail applies to every destination, which is only stricter)

-- A guardrail may name how wide an audience a write reaches before it applies:
-- 'workspace' matches any destination the workspace or a wider audience sees,
-- 'external' only a destination people outside the workspace see. A destination
-- whose audience cannot be read counts as external. Null keeps today's rule.
ALTER TABLE write_approval_policies
  ADD COLUMN IF NOT EXISTS audience text;

ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_audience_check;
ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT write_approval_policies_audience_check
  CHECK (audience IS NULL OR audience IN ('workspace', 'external')) NOT VALID;
ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  VALIDATE CONSTRAINT write_approval_policies_audience_check;

-- Only a guardrail can narrow by audience: a grant scoped to a destination would
-- let an audience lookup failure decide whether a write is allowed.
ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_audience_guardrail_check;
ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT write_approval_policies_audience_guardrail_check
  CHECK (audience IS NULL OR kind = 'guardrail') NOT VALID;
ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  VALIDATE CONSTRAINT write_approval_policies_audience_guardrail_check;

-- Guardrails for different audiences may share one scope, so audience joins the identity.
-- squawk-ignore require-concurrent-index-deletion -- bounded policy configuration; replaced in the same transaction
DROP INDEX IF EXISTS write_approval_policies_scoped_identity;
-- squawk-ignore require-concurrent-index-creation -- bounded policy configuration; replaced in the same transaction
CREATE UNIQUE INDEX IF NOT EXISTS write_approval_policies_scoped_identity
  ON write_approval_policies (
    organization_id, resource_class, COALESCE(principal_kind, ''), COALESCE(principal_id, ''),
    COALESCE(operation_key, ''), COALESCE(entity_type_slug, ''), COALESCE(field_path, ''),
    COALESCE(entity_id, 0), COALESCE(target_agent_id, ''),
    COALESCE(connector_key, ''), COALESCE(connection_id, 0), COALESCE(operation_category, ''),
    kind, COALESCE(audience, '')
  );

-- migrate:down
-- Rollback must not silently widen an audience guardrail to every destination.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM write_approval_policies WHERE audience IS NOT NULL)
  THEN RAISE EXCEPTION 'Remove audience guardrails explicitly before rolling back';
  END IF;
END $$;
-- squawk-ignore require-concurrent-index-deletion -- quiesced rollback, policy configuration only
DROP INDEX IF EXISTS write_approval_policies_scoped_identity;
-- squawk-ignore require-concurrent-index-creation -- quiesced rollback, policy configuration only
CREATE UNIQUE INDEX IF NOT EXISTS write_approval_policies_scoped_identity
  ON write_approval_policies (
    organization_id, resource_class, COALESCE(principal_kind, ''), COALESCE(principal_id, ''),
    COALESCE(operation_key, ''), COALESCE(entity_type_slug, ''), COALESCE(field_path, ''),
    COALESCE(entity_id, 0), COALESCE(target_agent_id, ''),
    COALESCE(connector_key, ''), COALESCE(connection_id, 0), COALESCE(operation_category, ''),
    kind
  );
ALTER TABLE write_approval_policies DROP CONSTRAINT IF EXISTS write_approval_policies_audience_guardrail_check;
ALTER TABLE write_approval_policies DROP CONSTRAINT IF EXISTS write_approval_policies_audience_check;
-- squawk-ignore ban-drop-column -- rollback refuses while any audience guardrail exists
ALTER TABLE write_approval_policies DROP COLUMN IF EXISTS audience;
