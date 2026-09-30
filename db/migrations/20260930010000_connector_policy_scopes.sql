-- migrate:up
-- Connector targets and action filters are independent: a connection can have
-- one rule for all destructive operations without enumerating today's catalog.
ALTER TABLE write_approval_policies
  ADD COLUMN IF NOT EXISTS connector_key text,
  ADD COLUMN IF NOT EXISTS connection_id bigint,
  ADD COLUMN IF NOT EXISTS operation_category text;

ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_connector_scope_check;
ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT write_approval_policies_connector_scope_check CHECK (
    (connector_key IS NULL OR (resource_class = 'connector_action' AND btrim(connector_key) <> ''))
    AND (connection_id IS NULL OR resource_class = 'connector_action')
    AND (connector_key IS NULL OR connection_id IS NULL)
    AND (operation_category IS NULL OR (
      resource_class = 'connector_action' AND operation_key IS NULL
      AND operation_category IN ('read', 'write', 'destructive', 'non_destructive', 'unknown')
    ))
  ) NOT VALID;
ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  VALIDATE CONSTRAINT write_approval_policies_connector_scope_check;

-- squawk-ignore require-concurrent-index-creation -- bounded connection configuration; migration runs while writers are quiesced
CREATE UNIQUE INDEX IF NOT EXISTS connections_org_id_policy_key
  ON connections (organization_id, id);
ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_connection_fkey;
-- squawk-ignore adding-foreign-key-constraint -- NOT VALID followed by validation; existing rows have null connection_id
ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT write_approval_policies_connection_fkey
  FOREIGN KEY (organization_id, connection_id)
  REFERENCES connections (organization_id, id) ON DELETE CASCADE NOT VALID;
-- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
ALTER TABLE write_approval_policies VALIDATE CONSTRAINT write_approval_policies_connection_fkey;

-- squawk-ignore require-concurrent-index-creation -- bounded policy configuration; replace identity while writers are quiesced
CREATE UNIQUE INDEX IF NOT EXISTS write_approval_policies_scoped_identity
  ON write_approval_policies (
    organization_id, resource_class, COALESCE(principal_kind, ''), COALESCE(principal_id, ''),
    COALESCE(operation_key, ''), COALESCE(entity_type_slug, ''), COALESCE(field_path, ''),
    COALESCE(entity_id, 0), COALESCE(target_agent_id, ''),
    COALESCE(connector_key, ''), COALESCE(connection_id, 0), COALESCE(operation_category, '')
  );
-- squawk-ignore require-concurrent-index-deletion -- quiesced migration; expanded identity already exists
DROP INDEX IF EXISTS write_approval_policies_identity;


-- Disabled and Block now have the same execution and discovery semantics.
UPDATE write_policy_action_effects SET effect = 'deny' WHERE effect = 'disabled';
ALTER TABLE write_policy_action_effects DROP CONSTRAINT IF EXISTS write_policy_action_effects_effect_check;
ALTER TABLE write_policy_action_effects
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT write_policy_action_effects_effect_check
  CHECK (effect IN ('auto', 'approval', 'deny')) NOT VALID;
ALTER TABLE write_policy_action_effects VALIDATE CONSTRAINT write_policy_action_effects_effect_check;

-- Seed an ordinary, editable Reads Auto rule exactly once at org creation.
-- A DB trigger covers both personal-org provisioning and web-created workspaces.
-- Deleting this rule is intentional: no runtime fallback recreates it.
CREATE OR REPLACE FUNCTION seed_connector_read_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy_id bigint;
BEGIN
  INSERT INTO write_approval_policies (organization_id, resource_class, operation_category)
  VALUES (NEW.id, 'connector_action', 'read') RETURNING id INTO policy_id;
  INSERT INTO write_policy_action_effects (policy_id, action, effect)
  VALUES (policy_id, 'execute', 'auto');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS organization_connector_read_policy ON organization;
CREATE TRIGGER organization_connector_read_policy AFTER INSERT ON organization
FOR EACH ROW EXECUTE FUNCTION seed_connector_read_policy();

-- migrate:down
DROP TRIGGER IF EXISTS organization_connector_read_policy ON organization;
DROP FUNCTION IF EXISTS seed_connector_read_policy();
ALTER TABLE write_policy_action_effects DROP CONSTRAINT IF EXISTS write_policy_action_effects_effect_check;
ALTER TABLE write_policy_action_effects
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT write_policy_action_effects_effect_check
  CHECK (effect IN ('auto', 'approval', 'deny', 'disabled')) NOT VALID;
ALTER TABLE write_policy_action_effects VALIDATE CONSTRAINT write_policy_action_effects_effect_check;
-- Rollback must not silently discard policies the old schema cannot express.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM write_approval_policies
    WHERE connector_key IS NOT NULL OR connection_id IS NOT NULL OR operation_category IS NOT NULL)
  THEN RAISE EXCEPTION 'Remove scoped connector policies explicitly before rolling back';
  END IF;
END $$;
-- squawk-ignore require-concurrent-index-creation -- quiesced rollback, policy configuration only
CREATE UNIQUE INDEX IF NOT EXISTS write_approval_policies_identity
  ON write_approval_policies (
    organization_id, resource_class, COALESCE(principal_kind, ''), COALESCE(principal_id, ''),
    COALESCE(operation_key, ''), COALESCE(entity_type_slug, ''), COALESCE(field_path, ''),
    COALESCE(entity_id, 0), COALESCE(target_agent_id, '')
  );
-- squawk-ignore require-concurrent-index-deletion -- original identity has been restored
DROP INDEX IF EXISTS write_approval_policies_scoped_identity;
ALTER TABLE write_approval_policies DROP CONSTRAINT IF EXISTS write_approval_policies_connection_fkey;
ALTER TABLE write_approval_policies DROP CONSTRAINT IF EXISTS write_approval_policies_connector_scope_check;
-- squawk-ignore ban-drop-column -- rollback refuses while any new-scope policy exists
ALTER TABLE write_approval_policies DROP COLUMN IF EXISTS connector_key, DROP COLUMN IF EXISTS connection_id, DROP COLUMN IF EXISTS operation_category;
-- squawk-ignore require-concurrent-index-deletion -- quiesced rollback; foreign key was removed
DROP INDEX IF EXISTS connections_org_id_policy_key;
