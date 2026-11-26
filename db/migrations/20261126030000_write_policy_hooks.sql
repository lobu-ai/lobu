-- migrate:up
-- lobu:no-quiesce -- existing policies and writers use the operation default; this release creates no loop rules

-- Metadata-only columns and one index rebuild over bounded policy configuration.
ALTER TABLE write_approval_policies
  ADD COLUMN IF NOT EXISTS hook text NOT NULL DEFAULT 'operation',
  ADD COLUMN IF NOT EXISTS tool_patterns text[];

ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- transactional migration
  ADD CONSTRAINT write_approval_policies_hook_check CHECK (
    (hook = 'operation' AND tool_patterns IS NULL)
    OR (
      resource_class = 'connector_action'
      AND kind = 'guardrail'
      AND hook IN ('message_in', 'reply_out', 'tool_call')
      AND connector_key IS NULL AND connection_id IS NULL
      AND operation_key IS NULL AND operation_category IS NULL AND audience IS NULL
      AND (tool_patterns IS NULL OR (
        hook = 'tool_call' AND cardinality(tool_patterns) BETWEEN 1 AND 50
        AND array_ndims(tool_patterns) = 1 AND array_position(tool_patterns, NULL) IS NULL
      ))
    )
  ) NOT VALID;
ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- transactional migration
  VALIDATE CONSTRAINT write_approval_policies_hook_check;

-- Bound index entries independently of the number and length of tool names.
-- A hash conflict rejects an insert; application updates still match the array.
-- squawk-ignore require-concurrent-index-deletion -- bounded policy configuration
DROP INDEX IF EXISTS write_approval_policies_scoped_identity;
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

-- migrate:down
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM write_approval_policies WHERE hook <> 'operation') THEN
    RAISE EXCEPTION 'Remove loop policy rules explicitly before rolling back';
  END IF;
END $$;
-- squawk-ignore require-concurrent-index-deletion -- bounded policy configuration
DROP INDEX IF EXISTS write_approval_policies_scoped_identity;
-- squawk-ignore require-concurrent-index-creation -- bounded policy configuration
CREATE UNIQUE INDEX IF NOT EXISTS write_approval_policies_scoped_identity
  ON write_approval_policies (
    organization_id, resource_class, COALESCE(principal_kind, ''), COALESCE(principal_id, ''),
    COALESCE(operation_key, ''), COALESCE(entity_type_slug, ''), COALESCE(field_path, ''),
    COALESCE(entity_id, 0), COALESCE(target_agent_id, ''),
    COALESCE(connector_key, ''), COALESCE(connection_id, 0), COALESCE(operation_category, ''),
    kind, COALESCE(audience, ''), COALESCE(md5(condition::text), '')
  );
ALTER TABLE write_approval_policies DROP CONSTRAINT IF EXISTS write_approval_policies_hook_check;
-- squawk-ignore ban-drop-column -- rollback refuses while any loop rule exists
ALTER TABLE write_approval_policies DROP COLUMN IF EXISTS hook, DROP COLUMN IF EXISTS tool_patterns;
