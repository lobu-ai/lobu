-- Seed realistic activity for the notification-peek E2E test.
-- Idempotent + safe to re-run. Seed rows are tagged with
-- run_metadata->>'seed' = 'peek' and events.metadata->>'seed' = 'peek'
-- so this script can clean them up without touching real data.
--
-- Org:    local-install (org_47ya40wa5k8)
-- User:   user_install_Eu_pgz479nU   (also used for FK created_by columns)
-- Agents: lobu-builder, owletto-default

\set ORG 'org_47ya40wa5k8'
\set USER 'user_install_Eu_pgz479nU'

BEGIN;

-- `events` is append-only (trigger blocks DELETE). This seed's cleanup of its
-- own tagged rows is sanctioned maintenance, so allow deletes for THIS tx only.
SET LOCAL lobu.allow_event_delete = 'on';

-- Clean previous seed (tagged rows only).
DELETE FROM notification_targets
  USING events
  WHERE notification_targets.event_id = events.id
    AND events.organization_id = :'ORG'
    AND events.metadata->>'seed' = 'peek';
DELETE FROM events WHERE organization_id = :'ORG' AND metadata->>'seed' = 'peek';
DELETE FROM runs WHERE organization_id = :'ORG' AND run_metadata->>'seed' = 'peek';
DELETE FROM automations WHERE organization_id = :'ORG' AND tags @> ARRAY['seed-peek']::text[];
DELETE FROM connections WHERE organization_id = :'ORG' AND slug IN ('seed-gmail', 'seed-slack');

-- ---------------------------------------------------------------------------
-- Automations (automations). Resolve seed rows by their org-scoped slug/tags rather
-- than fixed global ids: the DB assigns each id and dependent rows reference the
-- captured value. The top-of-script cleanup already removes prior seed rows, so
-- no id upsert is needed (a fixed id could retag/delete an unrelated automation).
-- automation_group_id (NOT NULL, unconstrained) is set to each automation's own id so
-- each seed automation stays its own group.
-- ---------------------------------------------------------------------------
INSERT INTO automations (
  organization_id, agent_id, name, slug, description, status,
  schedule, triggers, model_config, sources, created_by, automation_group_id,
  created_at, updated_at, tags
) VALUES (
  :'ORG', 'owletto-default', 'Daily spend digest', 'daily-spend-digest',
  'Summarize yesterday''s card transactions and flag anomalies over $500.',
  'active', '0 9 * * *', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
  :'USER', 0, now() - interval '6 days', now(),
  ARRAY['seed-peek']::text[]
) RETURNING id AS w_spend \gset

INSERT INTO automations (
  organization_id, agent_id, name, slug, description, status,
  schedule, triggers, model_config, sources, created_by, automation_group_id,
  created_at, updated_at, tags
) VALUES (
  :'ORG', 'owletto-default', 'Inbox triage', 'inbox-triage',
  'Flag emails needing a reply and draft suggested responses.',
  'active', '*/30 * * * *', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
  :'USER', 0, now() - interval '4 days', now(),
  ARRAY['seed-peek']::text[]
) RETURNING id AS w_inbox \gset

INSERT INTO automations (
  organization_id, agent_id, name, slug, description, status,
  schedule, triggers, model_config, sources, created_by, automation_group_id,
  created_at, updated_at, tags
) VALUES (
  :'ORG', 'lobu-builder', 'Stale workspace automation', 'stale-workspace-automation',
  'Alert when a workspace has no activity for 7 days.',
  'active', '0 10 * * 1', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
  :'USER', 0, now() - interval '3 days', now(),
  ARRAY['seed-peek']::text[]
) RETURNING id AS w_stale \gset

-- Each seed automation is its own group (group_id = own id).
UPDATE automations SET automation_group_id = id
  WHERE organization_id = :'ORG' AND id IN (:w_spend, :w_inbox, :w_stale);

-- ---------------------------------------------------------------------------
-- Automation runs (run_type = 'automation') — the agent-scoped activity feed.
-- ---------------------------------------------------------------------------
INSERT INTO runs (
  organization_id, run_type, status, automation_id,
  created_at, run_at, completed_at, error_message,
  items_collected, created_by_user_id, run_metadata
) VALUES
  (:'ORG', 'automation', 'completed', :w_spend,
   now() - interval '25 hours', now() - interval '25 hours',
   now() - interval '25 hours' + interval '3 minutes', NULL, 12, :'USER',
   '{"seed":"peek"}'::jsonb),
  (:'ORG', 'automation', 'failed', :w_spend,
   now() - interval '49 hours', now() - interval '49 hours',
   now() - interval '49 hours' + interval '40 seconds',
   'Upstream feed returned 502 Bad Gateway after 3 retries', 0, :'USER',
   '{"seed":"peek"}'::jsonb),
  (:'ORG', 'automation', 'completed', :w_inbox,
   now() - interval '2 hours', now() - interval '2 hours',
   now() - interval '2 hours' + interval '90 seconds', NULL, 5, :'USER',
   '{"seed":"peek"}'::jsonb),
  (:'ORG', 'automation', 'completed', :w_inbox,
   now() - interval '90 minutes', now() - interval '90 minutes',
   now() - interval '90 minutes' + interval '75 seconds', NULL, 8, :'USER',
   '{"seed":"peek"}'::jsonb),
  (:'ORG', 'automation', 'completed', :w_stale,
   now() - interval '5 hours', now() - interval '5 hours',
   now() - interval '5 hours' + interval '12 seconds', NULL, 1, :'USER',
   '{"seed":"peek"}'::jsonb);

-- ---------------------------------------------------------------------------
-- One Gmail connection so sync runs link to a real connector detail page.
-- Id is DB-assigned and captured; the top cleanup (by slug) handles re-runs, so
-- there is no fixed-id upsert that could clobber an unrelated connection (id=1).
-- ---------------------------------------------------------------------------
INSERT INTO connections (
  organization_id, connector_key, display_name, status, slug,
  credential_mode, created_by, created_at, updated_at
) VALUES (
  :'ORG', 'gmail', 'Gmail · work account', 'active', 'seed-gmail',
  'byo', :'USER', now() - interval '10 days', now()
) RETURNING id AS conn_gmail \gset

-- ---------------------------------------------------------------------------
-- One Slack connection so the pending Slack approval links to a real connector
-- of the matching connector_key (not the Gmail connection).
-- ---------------------------------------------------------------------------
INSERT INTO connections (
  organization_id, connector_key, display_name, status, slug,
  credential_mode, created_by, created_at, updated_at
) VALUES (
  :'ORG', 'slack', 'Slack · #finance', 'active', 'seed-slack',
  'byo', :'USER', now() - interval '10 days', now()
) RETURNING id AS conn_slack \gset

-- ---------------------------------------------------------------------------
-- Sync runs (link to the connectors page).
-- ---------------------------------------------------------------------------
INSERT INTO runs (
  organization_id, run_type, status, connector_key, connection_id,
  created_at, run_at, completed_at, error_message, items_collected,
  created_by_user_id, run_metadata
) VALUES
  (:'ORG', 'sync', 'completed', 'gmail', :conn_gmail,
   now() - interval '3 hours', now() - interval '3 hours',
   now() - interval '3 hours' + interval '20 seconds', NULL, 47, :'USER',
   '{"seed":"peek"}'::jsonb),
  (:'ORG', 'sync', 'failed', 'gmail', :conn_gmail,
   now() - interval '9 hours', now() - interval '9 hours',
   now() - interval '9 hours' + interval '15 seconds',
   'OAuth token expired — reconnect Gmail', 0, :'USER',
   '{"seed":"peek"}'::jsonb);

-- ---------------------------------------------------------------------------
-- A real pending approval: the "Daily spend digest" automation proposed
-- posting to Slack. This creates (a) a pending action run, (b) an approval
-- event carrying interaction data so EventCard renders the editable proposed
-- message + Confirm/Reject buttons, and (c) a notification pointing at it.
-- Clicking the notification opens the Memory events peek pane (not navigate).
-- ---------------------------------------------------------------------------

-- (a) Pending action run awaiting human approval.
INSERT INTO runs (
  organization_id, run_type, status, connector_key, connection_id,
  created_at, run_at, approval_status, items_collected,
  created_by_user_id, run_metadata
) VALUES (
  :'ORG', 'action', 'pending', 'slack', :conn_slack,
  now() - interval '20 minutes', now() - interval '20 minutes',
  'pending', 0, :'USER',
  '{"seed":"peek","proposer":"automation:daily-spend-digest"}'::jsonb
)
RETURNING id AS approval_run_id \gset

-- (b) Approval event with interaction data → ActionApprovalCard renders the
--     editable proposed message + Confirm/Reject buttons in the peek pane.
INSERT INTO events (
  organization_id, title, semantic_type, interaction_type, interaction_status,
  interaction_input_schema, interaction_input, run_id, occurred_at, created_at,
  created_by, metadata
) VALUES (
  :'ORG',
  'Proposed: post spend digest to #finance',
  'operation', 'approval', 'pending',
  '{"type":"object","properties":{"channel":{"type":"string","title":"Slack channel"},"message":{"type":"string","title":"Message","format":"textarea"}},"required":["channel","message"]}'::jsonb,
  jsonb_build_object('channel','#finance','message',E'## Daily Spend Digest — Jul 18\nTotal: €1,847.30 across 12 transactions\nFlagged: AWS Production €640, Booking.com €589'),
  :approval_run_id,
  now() - interval '20 minutes', now() - interval '20 minutes',
  :'USER',
  jsonb_build_object('seed','peek','run_id',:approval_run_id,'action_name','Post message','connection_name','#finance (Slack)')
);

-- (c) Notification pointing at the approval run (peek target).
WITH ev AS (
  INSERT INTO events (
    organization_id, title, payload_text, payload_type, semantic_type,
    interaction_type, interaction_status, metadata, occurred_at, created_at,
    created_by
  ) VALUES (
    :'ORG',
    'Approval needed: send digest to #finance',
    'Automation "Daily spend digest" wants to post a summary to the #finance channel. Review the proposed message before it sends.',
    'markdown', 'content', 'none', null,
    jsonb_build_object('seed','peek','notification_type','action_approval_needed','resource_type','run','resource_url','/local-install/events?run_ids=' || :approval_run_id),
    now(), now(), :'USER'
  ) RETURNING id
)
INSERT INTO notification_targets (event_id, user_id, delivered_at, read_at)
  SELECT id, :'USER', now(), NULL FROM ev;

-- ---------------------------------------------------------------------------
-- Transcripts (agent_transcript_snapshot) so automation runs show real content.
-- Each is a session.jsonl conversation: prompt → analysis → tool calls → summary.
-- These stay in the SAME transaction as the records above: a transcript failure
-- must roll back the whole seed so there is never a partially-seeded E2E state.
-- ---------------------------------------------------------------------------
DELETE FROM agent_transcript_snapshot WHERE organization_id = :'ORG' AND conversation_id LIKE 'seed-watch-%';

INSERT INTO agent_transcript_snapshot
  (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status, created_at)
SELECT :'ORG', 'owletto-default',
  'seed-watch-daily-spend-digest-run-' || r.id, r.id,
$jsonl${"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-19T09:00:01Z","message":{"role":"user","content":"Run this Automation now: Daily spend digest. Summarize yesterday's card transactions and flag anomalies over $500."}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-07-19T09:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"I'll pull yesterday's transactions from the connected Revolut account and analyze them for anomalies."}]}}
{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-07-19T09:00:05Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"list_transactions","input":{"since":"2026-07-18","until":"2026-07-19"}}]}}
{"type":"message","id":"m4","parentId":"m3","timestamp":"2026-07-19T09:00:09Z","message":{"role":"toolResult","content":[{"type":"tool_result","tool_use_id":"tu1","content":"12 transactions returned, total: €1,847.30"}]}}
{"type":"message","id":"m5","parentId":"m4","timestamp":"2026-07-19T09:00:12Z","message":{"role":"assistant","content":[{"type":"text","text":"## Daily Spend Digest — Jul 18\n\n**Total: €1,847.30 across 12 transactions**\n\n### Flagged (over €500)\n- **AWS Production** — €640.00 (monthly infra)\n- **Booking.com** — €589.00 (hotel, Lisbon)\n\n### Recurring\n- Netflix €15.99, Spotify €10.99, Notion €9.00\n\n### Notes\nSpend is 23% above your 30-day average (€1,503). The Lisbon hotel is the main driver. No unusual or suspicious transactions detected."}]}}$jsonl$,
128, 'completed', now() - interval '25 hours'
FROM runs r
WHERE r.run_metadata->>'seed' = 'peek' AND r.automation_id = :w_spend AND r.status = 'completed'
ON CONFLICT (organization_id, agent_id, conversation_id, run_id) DO UPDATE SET snapshot_jsonl = EXCLUDED.snapshot_jsonl;

INSERT INTO agent_transcript_snapshot
  (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status, created_at)
SELECT :'ORG', 'owletto-default',
  'seed-watch-daily-spend-digest-run-' || r.id, r.id,
$jsonl${"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-18T09:00:01Z","message":{"role":"user","content":"Run this Automation now: Daily spend digest."}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-07-18T09:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"Fetching yesterday's transactions from Revolut..."}]}}
{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-07-18T09:00:40Z","message":{"role":"assistant","content":[{"type":"text","text":"⚠️ The Revolut connector returned 502 Bad Gateway after 3 retries. I cannot complete the digest without transaction data. The run will be marked as failed — it will retry on the next scheduled run."}]}}$jsonl$,
64, 'failed', now() - interval '49 hours'
FROM runs r
WHERE r.run_metadata->>'seed' = 'peek' AND r.automation_id = :w_spend AND r.status = 'failed'
ON CONFLICT (organization_id, agent_id, conversation_id, run_id) DO UPDATE SET snapshot_jsonl = EXCLUDED.snapshot_jsonl;

INSERT INTO agent_transcript_snapshot
  (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status, created_at)
SELECT :'ORG', 'owletto-default',
  'seed-watch-inbox-triage-run-' || r.id, r.id,
$jsonl${"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-20T22:00:01Z","message":{"role":"user","content":"Run this Automation now: Inbox triage. Flag emails needing a reply and draft suggested responses."}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-07-20T22:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"Scanning the inbox for emails received in the last 30 minutes..."}]}}
{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-07-20T22:00:06Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"list_emails","input":{"folder":"inbox","since_minutes":30}}]}}
{"type":"message","id":"m4","parentId":"m3","timestamp":"2026-07-20T22:00:10Z","message":{"role":"toolResult","content":[{"type":"tool_result","tool_use_id":"tu1","content":"8 emails returned, 3 unread"}]}}
{"type":"message","id":"m5","parentId":"m4","timestamp":"2026-07-20T22:00:14Z","message":{"role":"assistant","content":[{"type":"text","text":"## Inbox Triage — 5 emails needing attention\n\n### 🔴 Needs reply\n1. **Sara Chen** (re: Q3 roadmap feedback) — waiting on your sign-off\n2. **Stripe** (re: payout failed) — action required\n\n### 🟡 FYI\n3. **GitHub** — security alert resolved\n4. **Linear** — weekly digest\n\n### ✅ No action\n5. **Notion** — product update\n\nI've drafted suggested replies for items 1-2 and saved them as drafts."}]}}$jsonl$,
128, 'completed', now() - interval '2 hours'
FROM runs r
WHERE r.run_metadata->>'seed' = 'peek' AND r.automation_id = :w_inbox AND r.status = 'completed' AND r.items_collected = 5
ON CONFLICT (organization_id, agent_id, conversation_id, run_id) DO UPDATE SET snapshot_jsonl = EXCLUDED.snapshot_jsonl;

INSERT INTO agent_transcript_snapshot
  (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status, created_at)
SELECT :'ORG', 'lobu-builder',
  'seed-watch-stale-workspace-automation-run-' || r.id, r.id,
$jsonl${"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-20T19:00:01Z","message":{"role":"user","content":"Run this Automation now: Stale workspace automation. Alert when a workspace has no activity for 7 days."}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-07-20T19:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"Checking all workspaces for activity in the last 7 days..."}]}}
{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-07-20T19:00:07Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"list_workspaces","input":{"inactive_days":7}}]}}
{"type":"message","id":"m4","parentId":"m3","timestamp":"2026-07-20T19:00:11Z","message":{"role":"toolResult","content":[{"type":"tool_result","tool_use_id":"tu1","content":"1 stale workspace found: 'acme-demo' (last activity 11 days ago)"}]}}
{"type":"message","id":"m5","parentId":"m4","timestamp":"2026-07-20T19:00:14Z","message":{"role":"assistant","content":[{"type":"text","text":"## Stale Workspace Report\n\nFound **1 workspace** with no activity in 7+ days:\n\n- **acme-demo** — last active 11 days ago\n\nThis workspace has 3 idle automations and 2 disconnected connectors. Consider archiving it or pinging the owner."}]}}$jsonl$,
128, 'completed', now() - interval '5 hours'
FROM runs r
WHERE r.run_metadata->>'seed' = 'peek' AND r.automation_id = :w_stale AND r.status = 'completed'
ON CONFLICT (organization_id, agent_id, conversation_id, run_id) DO UPDATE SET snapshot_jsonl = EXCLUDED.snapshot_jsonl;

-- Second Inbox-triage run (items_collected = 8) — so its run isn't an empty transcript either.
INSERT INTO agent_transcript_snapshot
  (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status, created_at)
SELECT :'ORG', 'owletto-default',
  'seed-watch-inbox-triage-run-' || r.id, r.id,
$jsonl${"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-20T22:30:01Z","message":{"role":"user","content":"Run this Automation now: Inbox triage. Flag emails needing a reply and draft suggested responses."}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-07-20T22:30:03Z","message":{"role":"assistant","content":[{"type":"text","text":"Scanning the inbox for new mail..."}]}}
{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-07-20T22:30:06Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"list_emails","input":{"folder":"inbox","since_minutes":30}}]}}
{"type":"message","id":"m4","parentId":"m3","timestamp":"2026-07-20T22:30:10Z","message":{"role":"toolResult","content":[{"type":"tool_result","tool_use_id":"tu1","content":"11 emails returned, 8 unread"}]}}
{"type":"message","id":"m5","parentId":"m4","timestamp":"2026-07-20T22:30:15Z","message":{"role":"assistant","content":[{"type":"text","text":"## Inbox Triage — 8 emails needing attention\n\n### 🔴 Needs reply\n1. **Acme Legal** (re: contract redlines) — deadline Friday\n2. **Priya Patel** (re: design review) — waiting on you\n3. **AWS Support** (re: case #4821) — response needed\n\n### 🟡 FYI\n4-6. GitHub, Linear, Vercel digests\n\n### ✅ No action\n7-8. Newsletters\n\nDrafted replies for items 1-3."}]}}$jsonl$,
160, 'completed', now() - interval '90 minutes'
FROM runs r
WHERE r.run_metadata->>'seed' = 'peek' AND r.automation_id = :w_inbox AND r.status = 'completed' AND r.items_collected = 8
ON CONFLICT (organization_id, agent_id, conversation_id, run_id) DO UPDATE SET snapshot_jsonl = EXCLUDED.snapshot_jsonl;

COMMIT;

\echo '--- seed summary ---'
SELECT 'automations (seeded)' AS what, count(*) FROM automations WHERE tags @> ARRAY['seed-peek']::text[]
UNION ALL SELECT 'runs (seeded)', count(*) FROM runs WHERE run_metadata->>'seed' = 'peek'
UNION ALL SELECT 'events (seeded)', count(*) FROM events WHERE metadata->>'seed' = 'peek'
UNION ALL SELECT 'notif targets (seeded)', count(*) FROM notification_targets JOIN events ON events.id = notification_targets.event_id WHERE events.metadata->>'seed' = 'peek'
UNION ALL SELECT 'transcripts (seeded)', count(*) FROM agent_transcript_snapshot WHERE organization_id = :'ORG' AND conversation_id LIKE 'seed-watch-%';
