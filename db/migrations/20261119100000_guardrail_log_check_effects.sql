-- migrate:up
-- lobu:no-quiesce  (additive: an older pod reads an unknown stored effect as deny, so a new Log only or Check guardrail fails closed until it rolls)

-- Guardrails gain two modes below Ask: `log` runs the action and records why,
-- `check` holds it until the requesting agent confirms it. Only guardrails may
-- store them; the policy write path enforces that because the kind lives on the
-- parent row.
ALTER TABLE write_policy_action_effects DROP CONSTRAINT IF EXISTS write_policy_action_effects_effect_check;
ALTER TABLE write_policy_action_effects
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT write_policy_action_effects_effect_check
  CHECK (effect IN ('auto', 'log', 'check', 'approval', 'deny')) NOT VALID;
ALTER TABLE write_policy_action_effects
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  VALIDATE CONSTRAINT write_policy_action_effects_effect_check;

-- migrate:down
-- Rollback must not silently turn a Log only or Check guardrail into something else.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM write_policy_action_effects WHERE effect IN ('log', 'check'))
  THEN RAISE EXCEPTION 'Remove Log only and Check guardrails explicitly before rolling back';
  END IF;
END $$;
ALTER TABLE write_policy_action_effects DROP CONSTRAINT IF EXISTS write_policy_action_effects_effect_check;
ALTER TABLE write_policy_action_effects
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT write_policy_action_effects_effect_check
  CHECK (effect IN ('auto', 'approval', 'deny')) NOT VALID;
ALTER TABLE write_policy_action_effects
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  VALIDATE CONSTRAINT write_policy_action_effects_effect_check;
