-- migrate:up
-- lobu:no-quiesce  (data-only: rewrites existing policy values that running code already evaluates)

-- 20261015120000 seeds personal orgs with "All actions: Auto" at creation, but
-- personal orgs created before it still carry the old "Reads: Auto" seed, so
-- every non-read connector action (e.g. a browser navigate) waits for approval.
-- Move those orgs to the current default only when the seed is untouched: the
-- org's single connector rule is the unscoped read grant with no note, never
-- edited since creation, whose only effect is execute=auto. Any other connector
-- rule, scope, guardrail, note, edit, or effect means the owner customized the
-- policy, and it is left as is. Team orgs keep "Reads: Auto".
-- Cost: bounded configuration tables (hundreds of rows in prod); milliseconds.
WITH personal_org AS (
  SELECT o.id
  FROM organization o
  WHERE pg_input_is_valid(o.metadata, 'jsonb')
    -- Match readPersonalOrgOwnerId: only a nonempty string identifies a personal org.
    AND jsonb_typeof(o.metadata::jsonb -> 'personal_org_for_user_id') = 'string'
    AND o.metadata::jsonb ->> 'personal_org_for_user_id' <> ''
),
untouched_seed AS (
  SELECT min(p.id) AS policy_id
  FROM write_approval_policies p
  JOIN personal_org po ON po.id = p.organization_id
  WHERE p.resource_class = 'connector_action'
  GROUP BY p.organization_id
  HAVING count(*) = 1
    AND bool_and(
      p.operation_category = 'read'
      AND p.kind = 'grant'
      AND p.note IS NULL
      AND p.connector_key IS NULL
      AND p.connection_id IS NULL
      AND p.operation_key IS NULL
      AND p.principal_kind IS NULL
      AND p.principal_id IS NULL
      AND p.target_agent_id IS NULL
      AND p.entity_type_slug IS NULL
      AND p.field_path IS NULL
      AND p.entity_id IS NULL
      AND p.updated_at <= p.created_at + interval '1 second'
    )
)
UPDATE write_approval_policies w
SET operation_category = NULL, updated_at = now()
FROM untouched_seed s
WHERE w.id = s.policy_id
  AND (SELECT count(*) FROM write_policy_action_effects e WHERE e.policy_id = w.id) = 1
  AND EXISTS (
    SELECT 1 FROM write_policy_action_effects e
    WHERE e.policy_id = w.id AND e.action = 'execute' AND e.effect = 'auto'
  );

-- migrate:down
-- No-op: after the backfill an org's "All actions: Auto" rule cannot be told
-- apart from one its owner chose, so reverting would silently narrow it.
SELECT 1;
