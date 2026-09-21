-- Lobu views replace view templates (phase 1).
--
-- New table `views`: one row per view with its current source, compiled
-- browser bundle, content hash, extracted attach/params/actions metadata and
-- `last_writer` (apply_id | tool call | user). The same source and metadata
-- mean the same hash and no write. Git is the only history of definitions, so
-- there is no versions table. Deleted: `view_template_versions`,
-- `view_template_active_tabs`, plus the default-template pointer columns on
-- `entity_types` and `entities`. Nothing else in the schema changes.
--
-- Stored demo template rows are converted, never cleared: every
-- `view_template_versions` row becomes one `views` row. The active version of
-- each (resource, tab) group keeps the plain derived key; superseded versions
-- keep `-v<version>` suffixed keys so no authored content is lost. The
-- original JSON template is preserved verbatim inside the converted module as
-- `TEMPLATE`, with the attach/params/actions the row carried. Converted rows
-- store an empty `compiled_code` and are inert until re-saved through
-- `manage_views` with a real TSX module, which compiles and fills the bundle.
--
-- The conversion is one INSERT ... SELECT. A replay after the source tables
-- have already been dropped skips the conversion, and existing destination
-- keys are left alone via ON CONFLICT DO NOTHING. The attach GIN index ships
-- in the follow-up 20260917000001 migration (CONCURRENTLY cannot run inside
-- this transactional file).
-- migrate:up
CREATE TABLE IF NOT EXISTS public.views (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id text NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    source_code text NOT NULL,
    compiled_code text NOT NULL DEFAULT '',
    content_hash text NOT NULL,
    attach jsonb NOT NULL DEFAULT '[]'::jsonb,
    params jsonb NOT NULL DEFAULT '{}'::jsonb,
    actions jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_writer text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT views_key_check CHECK ((key ~ '^[a-z0-9][a-z0-9-]{0,63}$'::text)),
    CONSTRAINT views_organization_key_unique UNIQUE (organization_id, key)
);

-- Convert every stored template version into a view. Grouped by
-- (organization, resource, tab); the active version of each group keeps the
-- plain key and superseded versions keep `-v<version>` keys. Active means the
-- parent pointer column for default tabs, `view_template_active_tabs` for
-- named tabs, and the latest version when no pointer names one.
DO $$
BEGIN
IF to_regclass('public.view_template_versions') IS NOT NULL THEN
WITH ranked AS (
  SELECT v.*,
    ROW_NUMBER() OVER (
      PARTITION BY v.organization_id, v.resource_type, v.resource_id, COALESCE(v.tab_name, '')
      ORDER BY v.version DESC
    ) AS rn
  FROM public.view_template_versions v
),
active_default AS (
  SELECT et.organization_id, 'entity_type'::text AS resource_type, et.slug AS resource_id,
    et.current_view_template_version_id AS version_id
  FROM public.entity_types et
  WHERE et.current_view_template_version_id IS NOT NULL
  UNION ALL
  SELECT e.organization_id, 'entity'::text AS resource_type, e.id::text AS resource_id,
    e.current_view_template_version_id AS version_id
  FROM public.entities e
  WHERE e.current_view_template_version_id IS NOT NULL
),
active_tabs AS (
  SELECT organization_id, resource_type, resource_id, tab_name,
    current_version_id AS version_id
  FROM public.view_template_active_tabs
),
flagged AS (
  SELECT r.organization_id, r.resource_type, r.resource_id, r.tab_name,
    r.id, r.version, r.json_template, r.created_by, r.rn,
    CASE
      WHEN r.tab_name IS NULL AND d.version_id = r.id THEN true
      WHEN r.tab_name IS NOT NULL AND t.version_id = r.id THEN true
      WHEN r.rn = 1
        AND NOT EXISTS (
          SELECT 1 FROM active_default d2
          WHERE d2.organization_id = r.organization_id
            AND d2.resource_type = r.resource_type
            AND d2.resource_id = r.resource_id
            AND r.tab_name IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM active_tabs t2
          WHERE t2.organization_id = r.organization_id
            AND t2.resource_type = r.resource_type
            AND t2.resource_id = r.resource_id
            AND t2.tab_name IS NOT DISTINCT FROM r.tab_name
            AND r.tab_name IS NOT NULL
        )
        THEN true
      ELSE false
    END AS is_active
  FROM ranked r
  LEFT JOIN active_default d
    ON d.organization_id = r.organization_id
    AND d.resource_type = r.resource_type
    AND d.resource_id = r.resource_id
    AND r.tab_name IS NULL
  LEFT JOIN active_tabs t
    ON t.organization_id = r.organization_id
    AND t.resource_type = r.resource_type
    AND t.resource_id = r.resource_id
    AND t.tab_name = r.tab_name
    AND r.tab_name IS NOT NULL
),
shaped AS (
  SELECT f.organization_id, f.resource_type, f.resource_id, f.tab_name,
    f.id, f.version, f.json_template, f.created_by, f.rn, f.is_active,
    -- Slug the key from tab + resource; trim to the key grammar the views
    -- table enforces. Values are data, never identifiers, so anything outside
    -- [a-z0-9] folds to a dash.
    NULLIF(
      TRIM(
        BOTH '-' FROM REGEXP_REPLACE(
          LOWER(COALESCE(f.tab_name, 'default') || '-' || f.resource_type || '-' || f.resource_id),
          '[^a-z0-9]+', '-', 'g'
        )
      ),
      ''
    ) AS base_key,
    CASE WHEN f.tab_name IS NULL THEN 'overview' ELSE 'tab' END AS placement,
    CASE WHEN JSONB_TYPEOF(f.json_template->'interactions') = 'object'
      THEN COALESCE((
        SELECT JSONB_OBJECT_AGG(e.key, JSONB_BUILD_OBJECT('emits', e.value->>'emits'))
        FROM JSONB_EACH(f.json_template->'interactions') AS e(key, value)
        WHERE JSONB_TYPEOF(e.value) = 'object'
          AND e.value->>'emits' IS NOT NULL
          AND e.value->>'emits' <> ''
      ), '{}'::jsonb)
      ELSE '{}'::jsonb
    END AS actions
  FROM flagged f
),
keyed AS (
  SELECT s.*,
    COALESCE(s.base_key, 'view') AS slug,
    CASE WHEN s.resource_type = 'entity_type'
      THEN JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT('type', s.resource_id, 'placement', s.placement))
      ELSE JSONB_BUILD_ARRAY(
        CASE WHEN s.resource_id ~ '^[0-9]+$'
          THEN JSONB_BUILD_OBJECT('entity', s.resource_id::bigint, 'placement', s.placement)
          ELSE JSONB_BUILD_OBJECT('entity', s.resource_id, 'placement', s.placement)
        END
      )
    END AS attach
  FROM shaped s
),
sourced AS (
  SELECT k.organization_id, k.resource_id, k.resource_type, k.tab_name,
    k.id, k.version, k.created_by, k.is_active, k.slug, k.attach, k.actions,
    -- Newlines in resource ids would break out of the `//` header comment,
    -- so they fold to spaces. Everything else below is value concatenation,
    -- never a string literal, so quotes need no escaping.
    '// Converted from view template ('
      || k.resource_type || ':'
      || REPLACE(REPLACE(k.resource_id, CHR(10), ' '), CHR(13), ' ')
      || COALESCE('/' || REPLACE(REPLACE(k.tab_name, CHR(10), ' '), CHR(13), ' '), '')
      || ', v' || k.version::text
      || ') by migration 20260917000000_views.' || CHR(10)
      || '// The original JSON template is preserved below as TEMPLATE.'
      || CHR(10)
      || '// Re-save through manage_views with a real TSX module to recompile this view.'
      || CHR(10)
      || 'export const view = { attach: ' || k.attach::text
      || ', params: {}, actions: ' || k.actions::text || ' };' || CHR(10)
      || 'const TEMPLATE = ' || k.json_template::text || ';' || CHR(10)
      || 'export default function ConvertedView() { return null; }' || CHR(10)
      AS source_code
  FROM keyed k
),
final AS (
  SELECT s.organization_id,
    LEFT(s.slug, 64) AS plain_key,
    LEFT(s.slug, 44) || '-v' || s.version::text AS versioned_key,
    s.is_active, s.version, s.id,
    LEFT(
      s.resource_id
        || COALESCE(' / ' || NULLIF(s.tab_name, ''), ''),
      120
    ) AS view_name,
    'Converted from a view template by migration 20260917000000_views; re-save to recompile.'
      AS view_description,
    s.source_code,
    SUBSTRING(MD5(s.source_code) FROM 1 FOR 16) AS source_hash,
    s.attach, s.actions, s.created_by
  FROM sourced s
),
deduped AS (
  SELECT f.*,
    ROW_NUMBER() OVER (
      PARTITION BY f.organization_id,
        CASE WHEN f.is_active THEN f.plain_key ELSE f.versioned_key END
      ORDER BY f.version DESC, f.id DESC
    ) AS key_rn
  FROM final f
)
INSERT INTO public.views (
  organization_id, key, name, description, source_code, compiled_code,
  content_hash, attach, params, actions, last_writer
)
SELECT d.organization_id,
  LEFT(
    CASE WHEN d.is_active THEN d.plain_key ELSE d.versioned_key END,
    64 - LENGTH(CASE WHEN d.key_rn > 1 THEN '-dup' || d.key_rn::text ELSE '' END)
  ) || CASE WHEN d.key_rn > 1 THEN '-dup' || d.key_rn::text ELSE '' END,
  d.view_name, d.view_description, d.source_code, '',
  d.source_hash, d.attach, '{}'::jsonb, d.actions,
  'migration:view-templates'
FROM deduped d
ON CONFLICT (organization_id, key) DO NOTHING;
END IF;
END $$;

-- Retire the template tables and their default-template pointers. The foreign
-- keys go first so the table drops do not depend on drop order.
ALTER TABLE ONLY public.entities DROP CONSTRAINT IF EXISTS entities_view_template_version_fk;
ALTER TABLE ONLY public.entity_types DROP CONSTRAINT IF EXISTS entity_types_view_template_version_fk;
-- The template feature is retired; every stored row converts into a `views`
-- row above, so no authored content is lost.
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.view_template_active_tabs;
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.view_template_versions;
ALTER TABLE ONLY public.entities DROP COLUMN IF EXISTS current_view_template_version_id;
ALTER TABLE ONLY public.entity_types DROP COLUMN IF EXISTS current_view_template_version_id;

-- migrate:down
-- Irreversible for data: converted template rows are not restored (recover
-- them from a backup). The retired schema comes back empty so a down/up
-- round-trip keeps working. Foreign keys are deliberately not recreated: the
-- down path exists for local rollback, where old code runs its joins without
-- needing the constraints enforced.
CREATE TABLE IF NOT EXISTS public.view_template_versions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    organization_id text NOT NULL,
    version bigint NOT NULL,
    tab_name text,
    tab_order bigint DEFAULT 0,
    json_template jsonb NOT NULL,
    change_notes text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT view_template_versions_resource_type_check CHECK ((resource_type = ANY (ARRAY['entity_type'::text, 'entity'::text])))
);

CREATE TABLE IF NOT EXISTS public.view_template_active_tabs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    organization_id text NOT NULL,
    tab_name text NOT NULL,
    tab_order bigint DEFAULT 0,
    current_version_id bigint NOT NULL,
    CONSTRAINT view_template_active_tabs_resource_type_check CHECK ((resource_type = ANY (ARRAY['entity_type'::text, 'entity'::text]))),
    CONSTRAINT view_template_active_tabs_unique UNIQUE (resource_type, resource_id, organization_id, tab_name)
);

ALTER TABLE ONLY public.entities ADD COLUMN IF NOT EXISTS current_view_template_version_id bigint;
ALTER TABLE ONLY public.entity_types ADD COLUMN IF NOT EXISTS current_view_template_version_id bigint;

-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.views;
