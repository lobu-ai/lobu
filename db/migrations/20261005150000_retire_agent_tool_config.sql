-- migrate:up
-- Deliberately quiesced: old producers must stop before new workers ignore the
-- removed envelope field. Recheck the prerequisites after quiescence. No rows
-- are rewritten and the dormant column remains for the next release's drop.
-- Cost: one scan of bounded agents config and one active-agent-turn index scan;
-- the read-only precondition took 29ms on production with 53 agents and no
-- active legacy turns. No exclusive lock.
DO $cutover$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'tools_config'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.agents WHERE tools_config IS NOT NULL AND tools_config <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'Agent tool configuration retirement requires owner review: clear nonempty agents.tools_config through the existing settings API before upgrading';
    END IF;
  END IF;
  IF to_regclass('public.runs') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.runs
      WHERE run_type = 'agent_turn' AND status IN ('pending', 'claimed', 'running')
        AND action_input #> '{turn,tools,bash_policy}' IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Drain active agent turns carrying tools.bash_policy before upgrading; their approved inputs must not be widened';
    END IF;
  END IF;
END
$cutover$;

-- migrate:down
-- Assertion only; no state or schema changed.
