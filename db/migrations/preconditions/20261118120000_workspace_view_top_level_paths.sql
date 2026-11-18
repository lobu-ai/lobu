-- Workspace views move to /<org>/<key>, the path an entity type's list page
-- uses. A workspace view whose key equals a live entity type slug, or a name
-- reserved for app routes (RESERVED_ENTITY_TYPE_SLUGS in
-- packages/core/src/reserved.ts), would be unreachable there. Rename the view
-- (manage_views set with a new key, then delete the old one) before upgrading.
-- Fresh installs run preconditions before their baseline tables exist.
DO $workspace_view_paths$
BEGIN
  IF to_regclass('public.views') IS NOT NULL AND to_regclass('public.entity_types') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.views v
      WHERE v.attach @> '[{"workspace": true}]'::jsonb
        AND (v.key = ANY (ARRAY['activity', 'agents', 'connectors', 'data', 'memory', 'members', 'settings', 'events', 'automations', 'connections', 'sources', 'environments', 'infrastructure', 'inference-providers', 'devices', 'entity-types', 'recent', 'chat', 'views', 'organization', 'user', 'automation', 'content', 'source', 'connector']::text[])
          OR EXISTS (SELECT 1 FROM public.entity_types et
                     WHERE et.organization_id = v.organization_id AND et.slug = v.key AND et.deleted_at IS NULL))
    ) THEN
      RAISE EXCEPTION 'A workspace view key clashes with an entity type slug or a reserved app route; rename the view before upgrading (docs/MIGRATIONS.md). List them with: SELECT v.organization_id, v.key FROM views v WHERE v.attach @> ''[{"workspace": true}]''::jsonb AND (v.key = ANY (ARRAY[''activity'', ''agents'', ''connectors'', ''data'', ''memory'', ''members'', ''settings'', ''events'', ''automations'', ''connections'', ''sources'', ''environments'', ''infrastructure'', ''inference-providers'', ''devices'', ''entity-types'', ''recent'', ''chat'', ''views'', ''organization'', ''user'', ''automation'', ''content'', ''source'', ''connector'']::text[]) OR EXISTS (SELECT 1 FROM entity_types et WHERE et.organization_id = v.organization_id AND et.slug = v.key AND et.deleted_at IS NULL))';
    END IF;
  END IF;
END
$workspace_view_paths$;
