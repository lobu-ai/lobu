-- migrate:up
-- lobu:no-quiesce  (validation changes nothing the running code can observe)
--
-- Second step: validate the replacement constraint on its own, so the scan
-- does not run inside a transaction that also holds ACCESS EXCLUSIVE.
--
-- OPERATIONAL COST: one sequential scan of events under SHARE UPDATE
-- EXCLUSIVE, which blocks neither reads nor writes. Estimated at about 11s on
-- production (10 GB heap, 8.86M rows), extrapolated from a 3% sample scan that
-- took 339 ms; not timed end to end. The statement timeout there is 60s. If it
-- times out, run the statement by hand with `SET statement_timeout = 0` and
-- record the version.
ALTER TABLE public.events VALIDATE CONSTRAINT events_unbound_tool_audit_owned;

-- migrate:down
-- lobu:no-quiesce
-- Validation has nothing to undo; the previous migration's down drops the constraint.
SELECT 1;
