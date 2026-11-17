-- migrate:up
-- lobu:no-quiesce  (widens a CHECK only: old code never writes 'app', and an app rule stored mid-rollout reads as an org rule on an old pod, which can only tighten)

-- A connected app (an OAuth client or a PAT acting with no agent and no
-- Automation) is its own policy principal. Its key comes only from
-- deriveAppPrincipalId at the token boundary. Existing runs keep 'user'; no backfill.
ALTER TABLE runs
  DROP CONSTRAINT IF EXISTS runs_policy_principal_kind_check;
ALTER TABLE runs
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT runs_policy_principal_kind_check CHECK (
    policy_principal_kind IS NULL
    OR policy_principal_kind IN ('agent', 'automation', 'user', 'app')
  ) NOT VALID;
ALTER TABLE runs
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  VALIDATE CONSTRAINT runs_policy_principal_kind_check;

-- write_approval_policies.principal_kind has no CHECK; its accepted values are
-- enforced by the policy writers.
COMMENT ON COLUMN write_approval_policies.principal_kind IS
  'NULL is the organization default; agent, automation or app selects a principal kind.';
COMMENT ON COLUMN write_approval_policies.principal_id IS
  'NULL with kind set means any principal of that kind; otherwise the specific agent id, Automation id, or app key (web:<domain>, client:<id>, local:<name>, pat:<id>).';

-- migrate:down
-- Rollback must not reinterpret app rules as organization rules or drop app runs.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM write_approval_policies WHERE principal_kind = 'app')
    OR EXISTS (SELECT 1 FROM runs WHERE policy_principal_kind = 'app')
  THEN RAISE EXCEPTION 'Remove app policies and app-requested runs explicitly before rolling back';
  END IF;
END $$;
ALTER TABLE runs
  DROP CONSTRAINT IF EXISTS runs_policy_principal_kind_check;
ALTER TABLE runs
  -- squawk-ignore prefer-robust-stmts -- quiesced rollback
  ADD CONSTRAINT runs_policy_principal_kind_check CHECK (
    policy_principal_kind IS NULL
    OR policy_principal_kind IN ('agent', 'automation', 'user')
  ) NOT VALID;
ALTER TABLE runs
  -- squawk-ignore prefer-robust-stmts -- quiesced rollback
  VALIDATE CONSTRAINT runs_policy_principal_kind_check;
COMMENT ON COLUMN write_approval_policies.principal_kind IS
  'NULL is the organization default; agent or automation selects a principal kind.';
COMMENT ON COLUMN write_approval_policies.principal_id IS
  'NULL with kind set means any principal of that kind; otherwise the specific agent or Automation id.';
