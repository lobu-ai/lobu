-- migrate:up
-- lobu:no-quiesce
-- One receipt per agent-turn write whose own storage carries no idempotency
-- key: a chat post, a presented event, an upload, generated media, an ask, an
-- entity create. The key is the turn-derived one (organization, agent,
-- conversation, initiating input message, write surface, canonical args), so a
-- re-run, a redelivered message or a model repeating itself runs the write
-- once per input message within the receipt retention window.
--
-- The receipt is claimed BEFORE the effect ('claimed', no result) and
-- completed after it ('done', result). A later repeat replays a done result;
-- a claim without one means an earlier attempt stopped mid-way and may have
-- been delivered, so the repeat answers "already attempted" instead of
-- delivering twice. Only an explicit refusal before the effect deletes its
-- claim; thrown errors retain it because delivery may already have happened.
--
-- New table only: code running before this deploy never reads it.
-- Pruned with the runs retention window (sweepCompletedRuns), hence the
-- created_at index.
CREATE TABLE IF NOT EXISTS public.turn_write_receipts (
  organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  surface text NOT NULL,
  state text NOT NULL CHECK (state IN ('claimed', 'done')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, idempotency_key)
);

-- squawk-ignore require-concurrent-index-creation -- table created immediately above
CREATE INDEX IF NOT EXISTS idx_turn_write_receipts_created_at
  ON public.turn_write_receipts (created_at);

-- migrate:down
-- squawk-ignore ban-drop-table -- rollback of the receipt table introduced above
DROP TABLE IF EXISTS public.turn_write_receipts;
