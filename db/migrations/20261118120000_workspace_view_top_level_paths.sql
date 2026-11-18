-- migrate:up
-- lobu:no-quiesce  (adds row triggers only: the precondition proves no stored row breaks the invariant, and old code that tries to create a clash is refused, which is the intent)

-- A workspace view (one whose attach list holds {"workspace": true}) is served at
-- /<org>/<key>, the same path as an entity type's list page. So within one
-- organization a workspace view key must never equal a live entity type slug.
-- Both sides are guarded here rather than in app code because entity types have
-- several writers (schema tool, restores, system types, migrations).
--
-- Each guard takes one per-organization advisory lock before it checks the other
-- table, so a view write and an entity type write racing on the same name
-- serialize and the second one sees the first. The guard raises unique_violation
-- with a named constraint so callers map it by structure (isUniqueViolation).
CREATE OR REPLACE FUNCTION lobu_workspace_path_lock(org text) RETURNS void
LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock(hashtextextended('workspace_path:' || org, 0)) $$;

CREATE OR REPLACE FUNCTION lobu_guard_workspace_view_path() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (NEW.attach @> '[{"workspace": true}]'::jsonb) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.attach @> '[{"workspace": true}]'::jsonb
     AND OLD.key = NEW.key AND OLD.organization_id = NEW.organization_id THEN
    RETURN NEW;
  END IF;
  PERFORM lobu_workspace_path_lock(NEW.organization_id);
  IF EXISTS (SELECT 1 FROM entity_types
             WHERE organization_id = NEW.organization_id AND slug = NEW.key AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Workspace view "%" would share /%, the path of the entity type with that slug; rename the view or the type', NEW.key, NEW.key
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'workspace_path_unique';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION lobu_guard_entity_type_workspace_path() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS NULL OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL
     AND OLD.slug = NEW.slug AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id THEN
    RETURN NEW;
  END IF;
  PERFORM lobu_workspace_path_lock(NEW.organization_id);
  IF EXISTS (SELECT 1 FROM views
             WHERE organization_id = NEW.organization_id AND key = NEW.slug
               AND attach @> '[{"workspace": true}]'::jsonb) THEN
    RAISE EXCEPTION 'Entity type "%" would share /%, the path of the workspace view with that key; rename the view or the type', NEW.slug, NEW.slug
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'workspace_path_unique';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS views_workspace_path_guard ON views;
CREATE TRIGGER views_workspace_path_guard
  BEFORE INSERT OR UPDATE OF key, attach, organization_id ON views
  FOR EACH ROW EXECUTE FUNCTION lobu_guard_workspace_view_path();

DROP TRIGGER IF EXISTS entity_types_workspace_path_guard ON entity_types;
CREATE TRIGGER entity_types_workspace_path_guard
  BEFORE INSERT OR UPDATE OF slug, deleted_at, organization_id ON entity_types
  FOR EACH ROW EXECUTE FUNCTION lobu_guard_entity_type_workspace_path();

-- migrate:down
DROP TRIGGER IF EXISTS views_workspace_path_guard ON views;
DROP TRIGGER IF EXISTS entity_types_workspace_path_guard ON entity_types;
DROP FUNCTION IF EXISTS lobu_guard_workspace_view_path();
DROP FUNCTION IF EXISTS lobu_guard_entity_type_workspace_path();
DROP FUNCTION IF EXISTS lobu_workspace_path_lock(text);
