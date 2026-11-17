-- migrate:up
-- lobu:no-quiesce  (tightens a CHECK only: the precondition proves no stored slug violates it, and old code that tries to claim a newly reserved slug is refused, which is the intent)

-- Workspace slugs must avoid every name in RESERVED_PATHS (packages/core/src/reserved.ts).
-- The CHECK had drifted to a 19-name subset, so workspaces could take owner-route and
-- server-route names, and a workspace slugged after a top-level server route has its pages
-- shadowed by the server's response. integration/workspace/reserved-workspace-slugs.test.ts keeps the two in sync.
ALTER TABLE "organization"
  DROP CONSTRAINT IF EXISTS org_slug_not_reserved;
ALTER TABLE "organization"
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT org_slug_not_reserved CHECK (slug <> ALL (ARRAY[
    'activity', 'agents', 'connectors', 'data', 'memory', 'members', 'settings', 'events', 'automations', 'connections', 'sources', 'environments', 'infrastructure', 'inference-providers', 'devices', 'auth', 'api', 'inbox', 'templates', 'help', 'account', 'me', 'admin', 'health', 'login', 'logout', 'signup', 'register', 'contents', 'entity-types', 'www', 'mcp', 'static', 'assets', 'cdn', 'docs', 'mail', 'connector', 'oauth', 'orgs', 'slack', 'dashboard', 'connect', 'catalog', 'internal', 'mcp-apps'
  ]::text[])) NOT VALID;
ALTER TABLE "organization"
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  VALIDATE CONSTRAINT org_slug_not_reserved;

-- migrate:down
ALTER TABLE "organization"
  DROP CONSTRAINT IF EXISTS org_slug_not_reserved;
ALTER TABLE "organization"
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT org_slug_not_reserved CHECK (slug <> ALL (ARRAY[
    'settings', 'auth', 'api', 'templates', 'help', 'account', 'admin', 'health', 'login', 'logout', 'signup', 'register', 'www', 'mcp', 'static', 'assets', 'cdn', 'docs', 'mail'
  ]::text[]));
