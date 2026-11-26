-- migrate:up
-- lobu:no-quiesce -- the deployed compatibility reader enforces the copied rules when this transaction commits

-- Cost: one scan and row expansion over bounded workspace policy configuration.
-- Take parent locks before legacy tables so an agent or workspace deletion
-- cannot hold a parent row while waiting to cascade into the source subjects.
-- The insert checks those same parent rows. Ordinary reads remain available.
LOCK TABLE organization, agents IN SHARE MODE;
LOCK TABLE workspace_guardrails, workspace_guardrail_subjects IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workspace_guardrails
    WHERE enabled AND archived_at IS NULL
      AND (
        config->>'builtin' IS NULL
        OR config->>'builtin' NOT IN ('secret-scan', 'pii-scan', 'forbidden-tools')
        OR config IS DISTINCT FROM jsonb_build_object('builtin', config->>'builtin')
      )
  ) THEN
    RAISE EXCEPTION 'An active workspace guardrail cannot be migrated. Replace unsupported checks before running the cutover.';
  END IF;
END $$;

WITH builtin_rules (builtin, hook, condition, tool_patterns) AS (
  VALUES
    ('secret-scan', 'reply_out', '[{"scan":"secrets","field":"/text"}]'::jsonb, NULL::text[]),
    ('pii-scan', 'message_in', '[{"scan":"pii","field":"/text"}]'::jsonb, NULL::text[]),
    ('pii-scan', 'reply_out', '[{"scan":"pii","field":"/text"}]'::jsonb, NULL::text[]),
    ('pii-scan', 'tool_call', '[{"scan":"pii","field":"/arguments"}]'::jsonb, NULL::text[]),
    ('forbidden-tools', 'tool_call', NULL::jsonb, ARRAY['delete_branch', 'delete_repo', 'drop_table']::text[])
),
desired AS (
  SELECT g.organization_id, s.principal_kind, s.principal_id,
    r.hook, r.condition, r.tool_patterns, min(g.name COLLATE "C") AS note
  FROM workspace_guardrails g
  JOIN workspace_guardrail_subjects s ON s.guardrail_id = g.id AND s.organization_id = g.organization_id
  JOIN builtin_rules r ON r.builtin = g.config->>'builtin'
  WHERE g.enabled AND g.archived_at IS NULL
  GROUP BY g.organization_id, s.principal_kind, s.principal_id, r.hook, r.condition, r.tool_patterns
),
inserted AS (
  INSERT INTO write_approval_policies (
    organization_id, resource_class, principal_kind, principal_id, kind, note, hook, condition, tool_patterns
  )
  SELECT organization_id, 'connector_action', principal_kind, principal_id, 'guardrail', note, hook, condition, tool_patterns
  FROM desired
  RETURNING id
)
INSERT INTO write_policy_action_effects (policy_id, action, effect)
SELECT id, 'execute', 'deny' FROM inserted;

-- The old reader and writer observe this atomically with the new rows.
-- squawk-ignore require-concurrent-index-creation -- index and handoff must commit together
CREATE INDEX IF NOT EXISTS write_approval_policies_loop_lookup
  ON write_approval_policies (organization_id, hook) WHERE hook <> 'operation';

-- migrate:down
-- The collections are editable after the cutover and edits can diverge from
-- the library. A rollback deploy can use the compatibility release and keep
-- this migration applied, so it continues enforcing current policy.
DO $$ BEGIN
  RAISE EXCEPTION 'The policy cutover cannot be reverted after loop editing is enabled. Roll back application code to the compatibility release instead.';
END $$;
