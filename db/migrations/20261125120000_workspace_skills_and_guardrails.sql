-- migrate:up
-- lobu:no-quiesce  (additive: new empty tables and triggers; no code before or in this deploy reads or writes them)

-- Workspace skills and guardrails: workspace-owned items that apply to everyone,
-- to agents, or to apps. Dormant storage: nothing reads or writes these tables
-- yet. Cost: four empty tables and their indexes; the only lock on an existing
-- table is the brief SHARE ROW EXCLUSIVE the agent FKs take on `agents`.

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
-- every principal of that kind. The composite FKs bind a subject to a skill and
-- an agent of its own workspace; deleting the agent deletes its subjects, so a
-- later agent reusing the id inherits nothing.
CREATE TABLE IF NOT EXISTS workspace_skill_subjects (
  skill_id text NOT NULL,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  principal_kind text CHECK (principal_kind IN ('agent', 'app')),
  principal_id text,
  CONSTRAINT workspace_skill_subjects_principal_check
    CHECK (principal_kind IS NOT NULL OR principal_id IS NULL),
  -- The agent an exact agent subject names, so a native FK can bind it.
  agent_id text GENERATED ALWAYS AS (CASE WHEN principal_kind = 'agent' THEN principal_id END) STORED,
  CONSTRAINT workspace_skill_subjects_skill_fkey
    FOREIGN KEY (organization_id, skill_id)
    REFERENCES workspace_skills (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT workspace_skill_subjects_agent_fkey
    FOREIGN KEY (organization_id, agent_id)
    REFERENCES agents (organization_id, id) ON DELETE CASCADE
);
-- squawk-ignore require-concurrent-index-creation -- brand-new empty table
CREATE UNIQUE INDEX IF NOT EXISTS workspace_skill_subjects_uq
  ON workspace_skill_subjects (skill_id, COALESCE(principal_kind, ''), COALESCE(principal_id, ''));
-- squawk-ignore require-concurrent-index-creation -- brand-new empty table
CREATE INDEX IF NOT EXISTS workspace_skill_subjects_principal
  ON workspace_skill_subjects (organization_id, principal_kind, principal_id);
-- squawk-ignore require-concurrent-index-creation -- brand-new empty table
CREATE INDEX IF NOT EXISTS workspace_skill_subjects_agent
  ON workspace_skill_subjects (organization_id, agent_id) WHERE agent_id IS NOT NULL;

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
  -- The agent an exact agent subject names, so a native FK can bind it.
  agent_id text GENERATED ALWAYS AS (CASE WHEN principal_kind = 'agent' THEN principal_id END) STORED,
  CONSTRAINT workspace_guardrail_subjects_guardrail_fkey
    FOREIGN KEY (organization_id, guardrail_id)
    REFERENCES workspace_guardrails (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT workspace_guardrail_subjects_agent_fkey
    FOREIGN KEY (organization_id, agent_id)
    REFERENCES agents (organization_id, id) ON DELETE CASCADE
);
-- squawk-ignore require-concurrent-index-creation -- brand-new empty table
CREATE UNIQUE INDEX IF NOT EXISTS workspace_guardrail_subjects_uq
  ON workspace_guardrail_subjects (guardrail_id, COALESCE(principal_kind, ''), COALESCE(principal_id, ''));
-- squawk-ignore require-concurrent-index-creation -- brand-new empty table
CREATE INDEX IF NOT EXISTS workspace_guardrail_subjects_principal
  ON workspace_guardrail_subjects (organization_id, principal_kind, principal_id);
-- squawk-ignore require-concurrent-index-creation -- brand-new empty table
CREATE INDEX IF NOT EXISTS workspace_guardrail_subjects_agent
  ON workspace_guardrail_subjects (organization_id, agent_id) WHERE agent_id IS NOT NULL;

-- migrate:down

-- squawk-ignore ban-drop-table -- rollback of the dormant tables introduced above
DROP TABLE IF EXISTS workspace_guardrail_subjects;
-- squawk-ignore ban-drop-table -- rollback of the dormant tables introduced above
DROP TABLE IF EXISTS workspace_guardrails;
-- squawk-ignore ban-drop-table -- rollback of the dormant tables introduced above
DROP TABLE IF EXISTS workspace_skill_subjects;
-- squawk-ignore ban-drop-table -- rollback of the dormant tables introduced above
DROP TABLE IF EXISTS workspace_skills;
