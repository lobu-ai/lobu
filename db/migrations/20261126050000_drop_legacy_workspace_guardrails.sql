-- migrate:up
-- lobu:no-quiesce -- deployed readers and writers use write_approval_policies

DO $$ BEGIN
  IF to_regclass('public.write_approval_policies_loop_lookup') IS NULL THEN
    RAISE EXCEPTION 'Complete the loop policy backfill before retiring the legacy guardrail tables.';
  END IF;
END $$;

-- squawk-ignore ban-drop-table -- the prior release migrated and switched enforcement
DROP TABLE IF EXISTS workspace_guardrail_subjects;
-- squawk-ignore ban-drop-table -- the prior release migrated and switched enforcement
DROP TABLE IF EXISTS workspace_guardrails;

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'The legacy guardrail tables cannot be restored after retirement. Roll back to a release that reads the loop policy collection.';
END $$;
