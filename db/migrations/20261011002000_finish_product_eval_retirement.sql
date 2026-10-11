-- migrate:up
-- lobu:no-quiesce -- #3972 removed the latest_eval_* readers and writers.
-- Release N+1: deploy #3972 to every replica and drain scorer tasks first.
-- Remove the obsolete quality cache, preserving Automations, runs, and events.
-- Cost: active-task check, then a metadata-only drop with an ACCESS EXCLUSIVE
-- lock on automations and no row rewrite. The integration fixture covers 259
-- Automations and four cached scores; production duration is not measured here.
-- Bound lock waiting to 2s.
SET LOCAL lock_timeout = '2s';

DO $guard$
BEGIN
  IF to_regclass('public.runs') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.runs
      WHERE run_type = 'task' AND status IN ('pending', 'claimed', 'running')
        AND (action_key = 'score-eval-runs' OR action_input->>'name' = 'score-eval-runs')
    ) THEN
      RAISE EXCEPTION 'Drain active score-eval-runs tasks with the previous release before retiring the compatibility handler';
    END IF;
  END IF;
END
$guard$;

-- squawk-ignore ban-drop-column -- readers/writers retired in the prior release
ALTER TABLE public.automations
  DROP COLUMN IF EXISTS latest_eval_score RESTRICT,
  DROP COLUMN IF EXISTS latest_eval_at RESTRICT,
  DROP COLUMN IF EXISTS latest_eval_run_id RESTRICT;

-- migrate:down
-- Schema rollback only: cached scores are not restored. Historical runs/events
-- were never modified. Roll back only to the previous eval-free release.
ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS latest_eval_score numeric(4, 3),
  ADD COLUMN IF NOT EXISTS latest_eval_at timestamptz,
  ADD COLUMN IF NOT EXISTS latest_eval_run_id bigint;
