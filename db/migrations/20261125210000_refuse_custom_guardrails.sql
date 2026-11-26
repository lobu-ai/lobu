-- migrate:up
-- lobu:no-quiesce  (assertion only: no schema or data change, so code before this deploy keeps working)

-- Custom guardrail checks (`kind: "judge"` and `kind: "require-tool"`) are
-- retired; a guardrail is now only a built-in, whose config is exactly
-- {"builtin": <name>}. The backfill and the custom-key normalization
-- (20261125140000, 20261125160000) gave every custom check a `kind` key and
-- never a built-in one, so `config ? 'kind'` finds them all.
--
-- This refuses the upgrade while any such row exists, archived rows included,
-- and deletes nothing: an operator decides what replaces each check and
-- removes the rows explicitly, then reruns the deploy. A row an old replica
-- writes after this check passes names no built-in, so the new runtime skips
-- it rather than failing.
--
-- Cost: one scan of workspace_guardrails, a bounded per-workspace config table.
DO $$
DECLARE
  custom_count bigint;
  sample text;
BEGIN
  SELECT count(*), string_agg(organization_id::text || '/' || name, ', ' ORDER BY organization_id, name)
    INTO custom_count, sample
  FROM workspace_guardrails
  WHERE jsonb_typeof(config) = 'object' AND config ? 'kind';

  IF custom_count > 0 THEN
    RAISE EXCEPTION 'workspace_guardrails has % custom check row(s) (config has "kind"), archived included: %. Custom guardrail checks are retired; delete these rows explicitly before upgrading.', custom_count, sample;
  END IF;
END $$;

-- migrate:down
-- Nothing to undo: the up section only asserts.
