-- migrate:up

-- Atlassian MCP Jira webhook delivery is retired with its receiver, so the
-- 6-hourly subscription refresh task no longer exists. Cancel its pending
-- tick; an old pod seeding another during rollout fails through the
-- unknown-handler path's normal retry budget.
UPDATE public.runs
SET status = 'cancelled',
    completed_at = now(),
    error_message = 'Task retired: Atlassian MCP webhook delivery was removed'
WHERE run_type = 'task'
  AND queue_name = 'task'
  AND action_key = 'atlassian-mcp-webhook-refresh'
  AND status = 'pending';

-- Strip the retired subscription state from the connections that carried it.
-- Left in place, generic connector teardown would treat `webhook_external_id`
-- as a code-registered subscription and fail deleting an MCP connection, which
-- has no connector code. Only the retired Atlassian module wrote the callback
-- token, project JQL, expiry and status keys, so they identify these rows. The
-- provider-side Jira dynamic webhooks expire on their own (30 days) now that
-- nothing refreshes them.
UPDATE public.connections
SET config = config - ARRAY[
      'webhook_external_id',
      'webhook_callback_token',
      'webhook_signature_secret',
      'webhook_signature_header',
      'webhook_algorithm',
      'webhook_signature_prefix',
      'webhook_dedupe_header',
      'webhook_project_jql',
      'webhook_expires_at',
      'webhook_status',
      'webhook_error',
      'jira_webhook_auth_profile_slug',
      'jira_webhook_app_profile_slug'
    ]::text[],
    updated_at = now()
WHERE config ?| ARRAY[
  'webhook_callback_token',
  'webhook_project_jql',
  'webhook_expires_at',
  'webhook_status'
]::text[];

-- migrate:down

-- Nothing to restore: a rolled-back app seeds a fresh refresh tick at boot,
-- and its connections re-register a subscription on their next config update.
SELECT 1;
