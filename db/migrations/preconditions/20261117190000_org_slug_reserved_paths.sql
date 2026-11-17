-- A workspace already holding a newly reserved slug must be renamed by its owner
-- (Workspace settings) before this deploy; the migration's VALIDATE would fail on it.
-- Fresh installs run preconditions before their baseline tables exist.
DO $reserved_slugs$
BEGIN
  IF to_regclass('public.organization') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.organization WHERE slug = ANY (ARRAY[
      'activity', 'agents', 'connectors', 'data', 'memory', 'members', 'settings', 'events', 'automations', 'connections', 'sources', 'environments', 'infrastructure', 'inference-providers', 'devices', 'auth', 'api', 'inbox', 'templates', 'help', 'account', 'me', 'admin', 'health', 'login', 'logout', 'signup', 'register', 'contents', 'entity-types', 'www', 'mcp', 'static', 'assets', 'cdn', 'docs', 'mail', 'connector', 'oauth', 'orgs', 'slack', 'dashboard', 'legal', 'connect', 'catalog', 'internal', 'mcp-apps'
    ]::text[])) THEN
      RAISE EXCEPTION 'A workspace uses a reserved slug; its owner must rename it in workspace settings before upgrading (docs/MIGRATIONS.md). List them with: SELECT id, slug, name FROM organization WHERE slug = ANY (ARRAY[''activity'', ''agents'', ''connectors'', ''data'', ''memory'', ''members'', ''settings'', ''events'', ''automations'', ''connections'', ''sources'', ''environments'', ''infrastructure'', ''inference-providers'', ''devices'', ''auth'', ''api'', ''inbox'', ''templates'', ''help'', ''account'', ''me'', ''admin'', ''health'', ''login'', ''logout'', ''signup'', ''register'', ''contents'', ''entity-types'', ''www'', ''mcp'', ''static'', ''assets'', ''cdn'', ''docs'', ''mail'', ''connector'', ''oauth'', ''orgs'', ''slack'', ''dashboard'', ''legal'', ''connect'', ''catalog'', ''internal'', ''mcp-apps'']::text[])';
    END IF;
  END IF;
END
$reserved_slugs$;
