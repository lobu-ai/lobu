-- migrate:up
-- lobu:no-quiesce  (planner statistics object only; no table or column change)

-- PostgreSQL ignores expression statistics gathered from a PARTIAL index, so
-- idx_events_live_org_agent's stats never reach the planner: it estimates
-- `metadata->>'agent_id' = $x` at the default 0.5% of the org's live rows and
-- walks the org's recency index instead (prod: 10.9s for a rare agent).
-- A whole-table statistics object on the same expression gives the planner
-- the real distribution (nearly all rows NULL), so it picks the agent index.
-- Measured on prod in a rolled-back transaction (PG 18.1): the ANALYZE below
-- took 1.8s; the rare-agent read went from 10.9s to 0.05ms and the busiest
-- agent's from 137ms to 22ms. CREATE STATISTICS and ANALYZE take only
-- SHARE UPDATE EXCLUSIVE, so reads and writes keep flowing.
CREATE STATISTICS IF NOT EXISTS public.events_agent_id_expr_stats
  ON ((metadata ->> 'agent_id')) FROM public.events;

ANALYZE public.events (metadata);

-- migrate:down

DROP STATISTICS IF EXISTS public.events_agent_id_expr_stats;
