-- migrate:up
-- lobu:no-quiesce  (data only: inserts ordinary connector grants; old code reads them like any other rule)

-- Binding an agent to a chat channel is the owner's consent to its posts there.
-- From this release an agent's send_message outside the asking conversation is
-- evaluated as a connector operation, so give every Chat SDK connection that an
-- agent of the same organization is already bound to the Auto grant a new
-- binding writes (reconcileBindingSendGrants). Without it, existing proactive
-- posts such as Automation digests would be held on deploy. The note marks the
-- binding as the grant's origin; the unique scoped-identity index keeps this
-- idempotent and leaves a rule a person already wrote untouched.
WITH bound AS (
  SELECT DISTINCT organization_id, connection_id, platform
  FROM automation_message_subscriptions
  WHERE connection_organization_id = organization_id
    AND connection_status = 'active'
    AND credential_mode IS NOT NULL
), inserted AS (
  INSERT INTO write_approval_policies (
    organization_id, resource_class, operation_key, connection_id,
    kind, note, created_at, updated_at
  )
  SELECT
    organization_id, 'connector_action', platform || '::send_message', connection_id,
    'grant', 'Allowed because an agent is bound to a channel on this connection', now(), now()
  FROM bound
  ON CONFLICT DO NOTHING
  RETURNING id
)
INSERT INTO write_policy_action_effects (policy_id, action, effect)
SELECT id, 'execute', 'auto' FROM inserted;

-- migrate:down
DELETE FROM write_approval_policies
WHERE resource_class = 'connector_action'
  AND kind = 'grant'
  AND principal_kind IS NULL
  AND operation_key LIKE '%::send_message'
  AND note = 'Allowed because an agent is bound to a channel on this connection';
