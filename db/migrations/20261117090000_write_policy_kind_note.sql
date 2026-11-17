-- migrate:up
-- lobu:no-quiesce  (additive: old code never selects kind/note, its inserts default to 'grant', and its ON CONFLICT DO NOTHING has no index target)

-- A policy row is either a grant (narrowest matching grant decides, as before)
-- or a guardrail (every matching guardrail applies after the grant fold and can
-- only make the result stricter). Existing rows are grants; no backfill.
-- `note` is the human reason shown when the rule decides a held or blocked run.
ALTER TABLE write_approval_policies
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'grant',
  ADD COLUMN IF NOT EXISTS note text;

ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_kind_check;
ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT write_approval_policies_kind_check
  CHECK (kind IN ('grant', 'guardrail')) NOT VALID;
ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  VALIDATE CONSTRAINT write_approval_policies_kind_check;

ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_note_length;
ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT write_approval_policies_note_length
  CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 280) NOT VALID;
ALTER TABLE write_approval_policies
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  VALIDATE CONSTRAINT write_approval_policies_note_length;

-- A grant and a guardrail may share one scope, so kind joins the identity.
-- squawk-ignore require-concurrent-index-deletion -- bounded policy configuration; replaced in the same transaction
DROP INDEX IF EXISTS write_approval_policies_scoped_identity;
-- squawk-ignore require-concurrent-index-creation -- bounded policy configuration; replaced in the same transaction
CREATE UNIQUE INDEX IF NOT EXISTS write_approval_policies_scoped_identity
  ON write_approval_policies (
    organization_id, resource_class, COALESCE(principal_kind, ''), COALESCE(principal_id, ''),
    COALESCE(operation_key, ''), COALESCE(entity_type_slug, ''), COALESCE(field_path, ''),
    COALESCE(entity_id, 0), COALESCE(target_agent_id, ''),
    COALESCE(connector_key, ''), COALESCE(connection_id, 0), COALESCE(operation_category, ''),
    kind
  );

-- migrate:down
-- Rollback must not silently turn a guardrail into a grant or drop a note.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM write_approval_policies WHERE kind <> 'grant' OR note IS NOT NULL)
  THEN RAISE EXCEPTION 'Remove guardrail policies and policy notes explicitly before rolling back';
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
    COALESCE(connector_key, ''), COALESCE(connection_id, 0), COALESCE(operation_category, '')
  );
ALTER TABLE write_approval_policies DROP CONSTRAINT IF EXISTS write_approval_policies_note_length;
ALTER TABLE write_approval_policies DROP CONSTRAINT IF EXISTS write_approval_policies_kind_check;
-- squawk-ignore ban-drop-column -- rollback refuses while any guardrail or note exists
ALTER TABLE write_approval_policies DROP COLUMN IF EXISTS note, DROP COLUMN IF EXISTS kind;
