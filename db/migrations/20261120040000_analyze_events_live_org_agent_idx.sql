-- migrate:up
-- lobu:no-quiesce  (planner statistics only; no schema change)

-- idx_events_live_org_agent indexes the expression `metadata->>'agent_id'`.
-- PostgreSQL keeps no statistics for an index expression until the table is
-- analyzed, so until then it estimates an agent's live rows with the default
-- selectivity and keeps walking the org's recency index instead. On a large
-- table, auto-analyze may not run again for days. Collect the statistics now.
-- ANALYZE samples 30k pages (default_statistics_target 100). Reading such a
-- sample of prod events (21 GB) took 2.4s, far under the 60s statement_timeout.
-- It takes SHARE UPDATE EXCLUSIVE, so reads and writes keep flowing.
ANALYZE public.events;

-- migrate:down
