-- migrate:up transaction:false
-- lobu:no-quiesce  (additive: older pods neither claim nor list a run whose approval_status they do not know)

-- Add 'check' and 'withdrawn' to the runs.approval_status vocabulary.
--
-- 'check' is a connector action held by a Check guardrail until the agent that
-- requested it confirms it (manage_operations confirm). No human ever sees it
-- and no worker claims it; its expires_at is the confirmation deadline.
-- 'withdrawn' is a held run (Ask or Check) its requester cancelled before
-- anyone decided it. It is kept distinct from 'expired': a withdrawn check is
-- evidence that the agent caught its own mistake.
--
-- Same lock-safe, retry-safe sequence as 20260726120000_runs_approval_status_expired.sql:
-- add the widened CHECK under a temporary name NOT VALID, validate it on its
-- own, then drop the old one and rename the new one into place.
DO $add_new$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.runs'::regclass
      AND conname = 'runs_approval_status_check_new'
  ) THEN
    EXECUTE $ddl$
      ALTER TABLE public.runs
        ADD CONSTRAINT runs_approval_status_check_new
        CHECK (approval_status = ANY (ARRAY[
          'pending'::text,
          'approved'::text,
          'rejected'::text,
          'expired'::text,
          'auto'::text,
          'check'::text,
          'withdrawn'::text
        ]))
        NOT VALID
    $ddl$;
  END IF;
END
$add_new$;

-- Step 2: validate on its own so the scan runs under SHARE UPDATE EXCLUSIVE.
-- Guarded so the statement is a no-op once the constraint is already validated
-- (or already renamed away by a completed earlier attempt), which keeps the
-- whole section convergent on retry from any crash point.
DO $validate_new$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.runs'::regclass
      AND conname = 'runs_approval_status_check_new'
      AND NOT convalidated
  ) THEN
    ALTER TABLE public.runs
      VALIDATE CONSTRAINT runs_approval_status_check_new;
  END IF;
END
$validate_new$;

ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_approval_status_check;

-- Guarded for the same retry reason: after a completed run the temp name is
-- gone, so a bare RENAME would fail on re-execution.
DO $rename_new$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.runs'::regclass
      AND conname = 'runs_approval_status_check_new'
  ) THEN
    ALTER TABLE public.runs
      RENAME CONSTRAINT runs_approval_status_check_new TO runs_approval_status_check;
  END IF;
END
$rename_new$;

-- migrate:down transaction:false

-- Settle held and withdrawn checks first: the narrower constraint cannot
-- validate while they exist.
UPDATE public.runs
SET approval_status = 'expired',
    status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
    completed_at = COALESCE(completed_at, current_timestamp)
WHERE approval_status IN ('check', 'withdrawn');

DO $add_old$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.runs'::regclass
      AND conname = 'runs_approval_status_check_old'
  ) THEN
    EXECUTE $ddl$
      ALTER TABLE public.runs
        ADD CONSTRAINT runs_approval_status_check_old
        CHECK (approval_status = ANY (ARRAY[
          'pending'::text,
          'approved'::text,
          'rejected'::text,
          'expired'::text,
          'auto'::text
        ]))
        NOT VALID
    $ddl$;
  END IF;
END
$add_old$;

DO $validate_old$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.runs'::regclass
      AND conname = 'runs_approval_status_check_old'
      AND NOT convalidated
  ) THEN
    ALTER TABLE public.runs
      VALIDATE CONSTRAINT runs_approval_status_check_old;
  END IF;
END
$validate_old$;

ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_approval_status_check;

DO $rename_old$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.runs'::regclass
      AND conname = 'runs_approval_status_check_old'
  ) THEN
    ALTER TABLE public.runs
      RENAME CONSTRAINT runs_approval_status_check_old TO runs_approval_status_check;
  END IF;
END
$rename_old$;
