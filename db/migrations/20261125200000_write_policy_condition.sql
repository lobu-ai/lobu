-- migrate:up
-- lobu:no-quiesce  (additive nullable column: old code never selects condition and its PUT rejects `when`, so nothing it reads or writes changes; see the rollout note below)

-- A connector action rule may carry conditions on the operation input (`when`):
-- a JSON array of 1-8 field or scan conditions that must all hold for the rule
-- to apply. Null keeps today's rule, which always applies when its scope matches.
--
-- Rollout: a conditional rule only exists once a new replica accepted one, and
-- until the rollout finishes an old replica reads it as unconditional. Cost: one
-- metadata-only ADD COLUMN, a CHECK validated over the bounded policy table, and
-- the identity index rebuilt over that same small table.
ALTER TABLE write_approval_policies
  ADD COLUMN IF NOT EXISTS condition jsonb;

ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_condition_check;
ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT write_approval_policies_condition_check
  CHECK (
    condition IS NULL OR (
      resource_class = 'connector_action' AND
      CASE WHEN jsonb_typeof(condition) = 'array'
        THEN jsonb_array_length(condition) BETWEEN 1 AND 8
        ELSE false
      END
    )
  ) NOT VALID;
ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  VALIDATE CONSTRAINT write_approval_policies_condition_check;

-- Rules that differ only by their conditions are different rules, so the
-- condition joins the identity. It is hashed: a list of values can outgrow a
-- btree index row, and jsonb's text form is canonical, so equal lists collide.
-- squawk-ignore require-concurrent-index-deletion -- bounded policy configuration; replaced in the same transaction
DROP INDEX IF EXISTS write_approval_policies_scoped_identity;
-- squawk-ignore require-concurrent-index-creation -- bounded policy configuration; replaced in the same transaction
CREATE UNIQUE INDEX IF NOT EXISTS write_approval_policies_scoped_identity
  ON write_approval_policies (
    organization_id, resource_class, COALESCE(principal_kind, ''), COALESCE(principal_id, ''),
    COALESCE(operation_key, ''), COALESCE(entity_type_slug, ''), COALESCE(field_path, ''),
    COALESCE(entity_id, 0), COALESCE(target_agent_id, ''),
    COALESCE(connector_key, ''), COALESCE(connection_id, 0), COALESCE(operation_category, ''),
    kind, COALESCE(audience, ''), COALESCE(md5(condition::text), '')
  );

-- migrate:down
-- Rollback must not silently turn a conditional rule into one that always applies.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM write_approval_policies WHERE condition IS NOT NULL)
  THEN RAISE EXCEPTION 'Remove conditional policy rules explicitly before rolling back';
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
    kind, COALESCE(audience, '')
  );
ALTER TABLE write_approval_policies DROP CONSTRAINT IF EXISTS write_approval_policies_condition_check;
-- squawk-ignore ban-drop-column -- rollback refuses while any conditional rule exists
ALTER TABLE write_approval_policies DROP COLUMN IF EXISTS condition;
