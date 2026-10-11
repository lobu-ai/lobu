-- Read-only prerequisite; fresh databases have no runs table yet.
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
