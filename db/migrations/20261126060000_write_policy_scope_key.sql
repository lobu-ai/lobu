-- migrate:up
-- lobu:no-quiesce -- adds no scope column; the old writer's tuple matches, untargeted ON CONFLICT and inserts keep working, and the trigger keys its rows

-- A policy rule is identified by its scope. Every writer addresses a row by one
-- stored key derived from that scope, so adding a scope column changes only this
-- function. A field at its default (NULL, or hook 'operation') is left out of the
-- key, so a writer that does not know a newer column addresses only rows that
-- leave it at the default. A new scope column must therefore be nullable with
-- NULL meaning the old behaviour, or be listed here with NULLIF of its default.
-- The condition is keyed by its canonical jsonb text so nulls inside it count.
CREATE OR REPLACE FUNCTION write_approval_policy_scope_key(p write_approval_policies) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT md5(jsonb_strip_nulls(jsonb_build_object(
    'resource_class', p.resource_class,
    'principal_kind', p.principal_kind,
    'principal_id', p.principal_id,
    'operation_key', p.operation_key,
    'connector_key', p.connector_key,
    'connection_id', p.connection_id,
    'operation_category', p.operation_category,
    'target_agent_id', p.target_agent_id,
    'entity_type_slug', p.entity_type_slug,
    'field_path', p.field_path,
    'entity_id', p.entity_id,
    'kind', p.kind,
    'audience', p.audience,
    'condition', p.condition::text,
    'hook', NULLIF(p.hook, 'operation'),
    'tool_patterns', p.tool_patterns
  ))::text)
$$;

ALTER TABLE write_approval_policies ADD COLUMN IF NOT EXISTS scope_key text;

CREATE OR REPLACE FUNCTION write_approval_policies_set_scope_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.scope_key := write_approval_policy_scope_key(NEW);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS write_approval_policies_scope_key ON write_approval_policies;
CREATE TRIGGER write_approval_policies_scope_key
  BEFORE INSERT OR UPDATE ON write_approval_policies
  FOR EACH ROW EXECUTE FUNCTION write_approval_policies_set_scope_key();

-- Bounded policy configuration: the trigger keys every row.
UPDATE write_approval_policies SET scope_key = NULL;
-- squawk-ignore prefer-robust-stmts,adding-not-nullable-field -- backfilled above; dbmate wraps the migration in a transaction
ALTER TABLE write_approval_policies ALTER COLUMN scope_key SET NOT NULL;

-- squawk-ignore require-concurrent-index-creation -- bounded policy configuration
CREATE UNIQUE INDEX IF NOT EXISTS write_approval_policies_scope_key_unique
  ON write_approval_policies (organization_id, scope_key);
-- squawk-ignore require-concurrent-index-deletion -- bounded policy configuration
DROP INDEX IF EXISTS write_approval_policies_scoped_identity;

-- migrate:down
-- squawk-ignore require-concurrent-index-creation -- bounded policy configuration
CREATE UNIQUE INDEX IF NOT EXISTS write_approval_policies_scoped_identity
  ON write_approval_policies (
    organization_id, resource_class, COALESCE(principal_kind, ''), COALESCE(principal_id, ''),
    COALESCE(operation_key, ''), COALESCE(entity_type_slug, ''), COALESCE(field_path, ''),
    COALESCE(entity_id, 0), COALESCE(target_agent_id, ''),
    COALESCE(connector_key, ''), COALESCE(connection_id, 0), COALESCE(operation_category, ''),
    kind, COALESCE(audience, ''), COALESCE(md5(condition::text), ''), hook,
    (tool_patterns IS NULL), COALESCE(hash_array_extended(tool_patterns, 0), 0)
  );
-- squawk-ignore require-concurrent-index-deletion -- bounded policy configuration
DROP INDEX IF EXISTS write_approval_policies_scope_key_unique;
DROP TRIGGER IF EXISTS write_approval_policies_scope_key ON write_approval_policies;
DROP FUNCTION IF EXISTS write_approval_policies_set_scope_key();
-- squawk-ignore ban-drop-column -- derived key; the restored index carries identity
ALTER TABLE write_approval_policies DROP COLUMN IF EXISTS scope_key;
DROP FUNCTION IF EXISTS write_approval_policy_scope_key(write_approval_policies);
