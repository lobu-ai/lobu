-- migrate:up
-- lobu:no-quiesce  (data-only: serving code reads both the old and the normalized config, and the normalized one is the custom check the row already declares)

-- Normalize custom guardrail configs to the custom config contract.
--
-- 20261125140000_workspace_guardrails_reader_cutover built each custom check's
-- config as the agents.guardrails_inline entry minus name/enabled, so it kept
-- every other key the entry carried. The retired inline validator never
-- rejected unknown keys, and before the cutover nothing read them. A copied
-- `builtin` key now makes isBuiltinGuardrailConfig classify the custom check
-- as a built-in: the judge or require-tool stops running (an unregistered or
-- non-string value is skipped; a registered one runs that built-in instead),
-- and an egress judge stops governing its domains.
--
-- A config that declares `kind` is a custom check: the backfill always set
-- `kind` on custom checks and never on built-ins, whose config is exactly
-- {"builtin": <name>}. Every key outside the custom contract (kind, stage,
-- policy, model, tools, domains) is dropped, which restores the check that
-- ran before the cutover. Built-in configs are not touched. Runs after the
-- backfill wherever both are pending, and fixes forward where the backfill
-- already applied. Rows that only differed by a dropped key stay separate rows
-- with equal configs; guardrails accumulate, so behaviour matches.
--
-- Cost: one UPDATE over workspace_guardrails, a bounded per-workspace config
-- table (no row-count test at prod size; every org's custom checks fit in one
-- page of Settings → Policies). The revision bump keeps compare-and-swap
-- writers from replacing a normalized row with a stale copy.
UPDATE workspace_guardrails
SET config = (
      SELECT jsonb_object_agg(key, value)
      FROM jsonb_each(config)
      WHERE key IN ('kind', 'stage', 'policy', 'model', 'tools', 'domains')
    ),
    revision = revision + 1,
    updated_at = now()
WHERE jsonb_typeof(config) = 'object'
  AND config ? 'kind'
  AND EXISTS (
    SELECT 1 FROM jsonb_object_keys(config) AS k(key)
    WHERE k.key NOT IN ('kind', 'stage', 'policy', 'model', 'tools', 'domains')
  );

-- migrate:down

-- Irreversible: the dropped keys had no meaning before the cutover, and
-- restoring `builtin` would disable the custom checks again.
