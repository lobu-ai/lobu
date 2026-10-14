-- Stamp each connector's declared webhook event type onto connections that
-- registered a per-connection webhook before registration recorded it.
--
-- A registered connection's verified deliveries dispatch to its feeds only when
-- its config names where a delivery carries its event type
-- (`webhook_event_type`, copied from the connector's `webhook.eventType` at
-- registration). Registration never re-runs for a connection that already has
-- its provider hook, so earlier registrations would fall back to raw storage.
-- The values mirror `webhook.eventType` in packages/connectors/src/github.ts
-- and linear.ts; a test pins them together.
--
-- A single UPDATE over the bounded `connections` table; idempotent on re-run.

-- migrate:up

UPDATE connections c
SET config = c.config || jsonb_build_object('webhook_event_type', declared.event_type),
    updated_at = now()
FROM (VALUES
  ('github', '{"header":"x-github-event"}'::jsonb),
  ('linear', '{"path":"type"}'::jsonb)
) AS declared(connector_key, event_type)
WHERE c.connector_key = declared.connector_key
  AND c.deleted_at IS NULL
  AND NULLIF(c.config->>'webhook_external_id', '') IS NOT NULL
  AND NOT c.config ? 'webhook_event_type';

-- migrate:down

SELECT 1;
