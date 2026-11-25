-- migrate:up
-- lobu:no-quiesce  (additive: new empty tables and triggers; no code before or in this deploy reads or writes them)

-- Workspace skills and guardrails: workspace-owned items that apply to everyone,
-- to agents, or to apps. Dormant storage: nothing reads or writes these tables
-- yet. Cost: four empty tables, their indexes and two triggers; the only lock on
-- an existing table is CREATE TRIGGER's brief SHARE ROW EXCLUSIVE on `agents`.

-- Names follow the Agent Skills grammar: lowercase letters, digits and single
-- inner hyphens, at most 64 characters. A name is unique among a workspace's
-- unarchived items, and a rename is archive plus create.
CREATE TABLE IF NOT EXISTS workspace_skills (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 64),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 64000),
  -- bundled/<name> | custom/<slug> | file/<name>
  provenance text,
  enabled boolean NOT NULL DEFAULT true,
  -- squawk-ignore prefer-bigint-over-int -- a small per-workspace display order, not an id
  sort_order integer NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Target of the subjects' composite FK.
  CONSTRAINT workspace_skills_org_id_key UNIQUE (organization_id, id)
);
-- squawk-ignore require-concurrent-index-creation -- brand-new empty table
CREATE UNIQUE INDEX IF NOT EXISTS workspace_skills_org_name
  ON workspace_skills (organization_id, name) WHERE archived_at IS NULL;

-- Who a skill applies to. principal_kind NULL is everyone; principal_id NULL is
-- every principal of that kind. The composite FK binds a subject to a skill of
-- its own workspace.
CREATE TABLE IF NOT EXISTS workspace_skill_subjects (
  skill_id text NOT NULL,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  principal_kind text CHECK (principal_kind IN ('agent', 'app')),
  principal_id text,
  CONSTRAINT workspace_skill_subjects_principal_check
    CHECK (principal_kind IS NOT NULL OR principal_id IS NULL),
  CONSTRAINT workspace_skill_subjects_skill_fkey
    FOREIGN KEY (organization_id, skill_id)
    REFERENCES workspace_skills (organization_id, id) ON DELETE CASCADE
);
-- squawk-ignore require-concurrent-index-creation -- brand-new empty table
CREATE UNIQUE INDEX IF NOT EXISTS workspace_skill_subjects_uq
  ON workspace_skill_subjects (skill_id, COALESCE(principal_kind, ''), COALESCE(principal_id, ''));
-- squawk-ignore require-concurrent-index-creation -- brand-new empty table
CREATE INDEX IF NOT EXISTS workspace_skill_subjects_principal
  ON workspace_skill_subjects (organization_id, principal_kind, principal_id);

CREATE TABLE IF NOT EXISTS workspace_guardrails (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 64),
  config jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_guardrails_org_id_key UNIQUE (organization_id, id)
);
-- squawk-ignore require-concurrent-index-creation -- brand-new empty table
CREATE UNIQUE INDEX IF NOT EXISTS workspace_guardrails_org_name
  ON workspace_guardrails (organization_id, name) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS workspace_guardrail_subjects (
  guardrail_id text NOT NULL,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  principal_kind text CHECK (principal_kind IN ('agent', 'app')),
  principal_id text,
  CONSTRAINT workspace_guardrail_subjects_principal_check
    CHECK (principal_kind IS NOT NULL OR principal_id IS NULL),
  CONSTRAINT workspace_guardrail_subjects_guardrail_fkey
    FOREIGN KEY (organization_id, guardrail_id)
    REFERENCES workspace_guardrails (organization_id, id) ON DELETE CASCADE
);
-- squawk-ignore require-concurrent-index-creation -- brand-new empty table
CREATE UNIQUE INDEX IF NOT EXISTS workspace_guardrail_subjects_uq
  ON workspace_guardrail_subjects (guardrail_id, COALESCE(principal_kind, ''), COALESCE(principal_id, ''));
-- squawk-ignore require-concurrent-index-creation -- brand-new empty table
CREATE INDEX IF NOT EXISTS workspace_guardrail_subjects_principal
  ON workspace_guardrail_subjects (organization_id, principal_kind, principal_id);

-- Remove an agent's subject rows when the agent is deleted, the same way
-- 20260710140000 cascades its write policies. principal_id is polymorphic (an
-- agent id or an app key), so a plain FK can't express this. Agent ids are
-- reusable, so leftover rows would apply to a later agent created with the same id.
CREATE OR REPLACE FUNCTION cascade_delete_agent_workspace_subjects()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM workspace_skill_subjects
  WHERE organization_id = OLD.organization_id
    AND principal_kind = 'agent'
    AND principal_id = OLD.id;
  DELETE FROM workspace_guardrail_subjects
  WHERE organization_id = OLD.organization_id
    AND principal_kind = 'agent'
    AND principal_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_cascade_delete_agent_workspace_subjects ON agents;
CREATE TRIGGER trg_cascade_delete_agent_workspace_subjects
  AFTER DELETE ON agents
  FOR EACH ROW EXECUTE FUNCTION cascade_delete_agent_workspace_subjects();

-- Reject a subject naming an agent that is not in the subject's workspace, and
-- serialize the write against a concurrent agent delete. FOR KEY SHARE on the
-- agent row is the serialization point: if the delete holds the row, this write
-- blocks, then finds no row and raises; if this write holds the lock, the delete
-- waits for it to commit and its AFTER DELETE trigger removes the new row. Only
-- exact agent subjects are checked; everyone, any-agent and app subjects name no
-- single agent row.
CREATE OR REPLACE FUNCTION assert_workspace_subject_agent_exists()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.principal_kind = 'agent' AND NEW.principal_id IS NOT NULL THEN
    PERFORM 1 FROM agents
    WHERE id = NEW.principal_id
      AND organization_id = NEW.organization_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION '% principal agent % not found in org %',
        TG_TABLE_NAME, NEW.principal_id, NEW.organization_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Fire on INSERT and on an UPDATE that rebinds the principal, as the policy
-- trigger does, so the agent lock is always taken before the subject row's.
DROP TRIGGER IF EXISTS trg_assert_workspace_skill_subject_agent_exists ON workspace_skill_subjects;
CREATE TRIGGER trg_assert_workspace_skill_subject_agent_exists
  BEFORE INSERT OR UPDATE OF principal_kind, principal_id, organization_id
  ON workspace_skill_subjects
  FOR EACH ROW EXECUTE FUNCTION assert_workspace_subject_agent_exists();

DROP TRIGGER IF EXISTS trg_assert_workspace_guardrail_subject_agent_exists ON workspace_guardrail_subjects;
CREATE TRIGGER trg_assert_workspace_guardrail_subject_agent_exists
  BEFORE INSERT OR UPDATE OF principal_kind, principal_id, organization_id
  ON workspace_guardrail_subjects
  FOR EACH ROW EXECUTE FUNCTION assert_workspace_subject_agent_exists();

-- migrate:down

DROP TRIGGER IF EXISTS trg_cascade_delete_agent_workspace_subjects ON agents;
DROP FUNCTION IF EXISTS cascade_delete_agent_workspace_subjects();
-- squawk-ignore ban-drop-table -- rollback of the dormant tables introduced above
DROP TABLE IF EXISTS workspace_guardrail_subjects;
-- squawk-ignore ban-drop-table -- rollback of the dormant tables introduced above
DROP TABLE IF EXISTS workspace_guardrails;
-- squawk-ignore ban-drop-table -- rollback of the dormant tables introduced above
DROP TABLE IF EXISTS workspace_skill_subjects;
-- squawk-ignore ban-drop-table -- rollback of the dormant tables introduced above
DROP TABLE IF EXISTS workspace_skills;
DROP FUNCTION IF EXISTS assert_workspace_subject_agent_exists();
