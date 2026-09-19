-- migrate:up transaction:false

-- Keyed idempotence for agent-turn tool traces (#3662 follow-up).
--
-- Heartbeat tool receipts are `thread_response` rows carrying a
-- `customEvent.name = 'tool_use'` payload, keyed by the canonical
-- (organization, conversation, initiating input message, tool call id) tuple in
-- `idempotency_key` (`turn-tool:v1:...`, set by the agent-turn worker API).
--
-- The pre-existing `runs_idempotency_key_uniq` partial index only covers live
-- rows (`status IN ('pending','claimed','running')`): once a trace is claimed
-- and delivered it drops out of that index, so a heartbeat retry re-inserted
-- the same trace as a second row and the beat ACKed all events. This index is
-- scoped to exactly the tool-trace shape across ALL statuses — pending,
-- claimed, failed and delivered alike — so a retry collides no matter what
-- delivery state the first insert has reached. A conflicting same-key payload
-- (same key, different trace body) collides too; the worker API re-reads the
-- stored row and rejects it rather than ACKing, so the worker keeps the
-- evidence queued instead of retiring it unwritten.
--
-- Narrowly scoped on purpose: only `thread_response` rows whose payload is a
-- `tool_use` custom event and that carry a key participate. Every other row —
-- including keyless legacy traces — stays out of the index entirely.

-- Fail loudly before index construction if an earlier partial rollout already
-- wrote duplicate keyed rows. This migration never chooses a winner or deletes
-- evidence; an operator must inspect and reconcile the conflicting facts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.runs
    WHERE queue_name = 'thread_response'
      AND action_input->'customEvent'->>'name' = 'tool_use'
      AND idempotency_key IS NOT NULL
    GROUP BY idempotency_key
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate keyed agent-turn tool traces block idx_runs_turn_tool_event_uniq';
  END IF;
END $$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_turn_tool_event_uniq
  ON public.runs (idempotency_key)
  WHERE queue_name = 'thread_response'
    AND action_input->'customEvent'->>'name' = 'tool_use'
    AND idempotency_key IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_runs_turn_tool_event_uniq;
