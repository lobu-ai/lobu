-- migrate:up

-- Remote-native records: a connection-backed type's records, activity and
-- relationships are read live from the source by exact key. Postgres keeps
-- configuration only (the SQL below) plus `events.entity_refs` pointers on
-- Lobu-authored events. Nothing here grows with the source.

-- (1) Activity SQL for a connection-backed entity type. It projects `key`,
-- `origin_id`, `occurred_at`, `title` and `sort_key`, and is read with an exact
-- match on `key`, so it requires the record backing it belongs to.
ALTER TABLE public.entity_types ADD COLUMN IF NOT EXISTS backing_activity_sql text;

ALTER TABLE public.entity_types
  DROP CONSTRAINT IF EXISTS entity_types_backing_activity_requires_source;
-- squawk-ignore prefer-robust-stmts,constraint-missing-not-valid -- config-scale table and a column added NULL above; the runner owns the transaction
ALTER TABLE public.entity_types ADD CONSTRAINT entity_types_backing_activity_requires_source CHECK (
    backing_activity_sql IS NULL
    OR (backing_source IS NOT NULL AND backing_sql IS NOT NULL AND btrim(backing_activity_sql) <> '')
  );

-- (2) A relationship type may be backed by SQL on a connection. Its edges are
-- read live (projecting `from_key`, `to_key`), never stored.
ALTER TABLE public.entity_relationship_types ADD COLUMN IF NOT EXISTS backing_sql text;
ALTER TABLE public.entity_relationship_types ADD COLUMN IF NOT EXISTS backing_source text;

ALTER TABLE public.entity_relationship_types
  DROP CONSTRAINT IF EXISTS entity_relationship_types_backing_pair;
-- squawk-ignore prefer-robust-stmts,constraint-missing-not-valid -- config-scale table and columns added NULL above; the runner owns the transaction
ALTER TABLE public.entity_relationship_types ADD CONSTRAINT entity_relationship_types_backing_pair CHECK (
    (backing_sql IS NULL AND backing_source IS NULL)
    OR (
      backing_sql IS NOT NULL AND backing_source IS NOT NULL
      AND btrim(backing_sql) <> '' AND btrim(backing_source) <> ''
    )
  );

-- A backed relationship type never has stored edges: on INSERT, and on an
-- UPDATE that re-points an edge's type. Mirrors
-- reject_rows_on_derived_entity_type for entities.
CREATE OR REPLACE FUNCTION public.reject_rows_on_backed_relationship_type()
  RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.entity_relationship_types rt
    WHERE rt.id = NEW.relationship_type_id AND rt.backing_sql IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'relationship type % is backed by a connection and cannot have stored relationships',
      NEW.relationship_type_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reject_rows_on_backed_relationship_type ON public.entity_relationships;
CREATE TRIGGER trg_reject_rows_on_backed_relationship_type
  BEFORE INSERT OR UPDATE OF relationship_type_id ON public.entity_relationships
  FOR EACH ROW EXECUTE FUNCTION public.reject_rows_on_backed_relationship_type();

-- A relationship type may not become backed while it still has stored edges:
-- the live read would silently hide them.
CREATE OR REPLACE FUNCTION public.reject_backed_relationship_conversion_with_rows()
  RETURNS trigger AS $$
BEGIN
  IF NEW.backing_sql IS NOT NULL AND OLD.backing_sql IS NULL AND EXISTS (
    SELECT 1 FROM public.entity_relationships r
    WHERE r.relationship_type_id = NEW.id AND r.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'relationship type % cannot become backed while stored relationships exist; delete them first',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reject_backed_relationship_conversion_with_rows ON public.entity_relationship_types;
CREATE TRIGGER trg_reject_backed_relationship_conversion_with_rows
  BEFORE UPDATE OF backing_sql ON public.entity_relationship_types
  FOR EACH ROW EXECUTE FUNCTION public.reject_backed_relationship_conversion_with_rows();

-- (3) Pointers from Lobu-authored events (briefs, notes) to remote records, as
-- `<type>:<key>` refs. Written only by Lobu saves; connector events never carry
-- them. Indexed concurrently in the next migration.
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS entity_refs text[];

-- migrate:down

ALTER TABLE public.events DROP COLUMN IF EXISTS entity_refs;

DROP TRIGGER IF EXISTS trg_reject_backed_relationship_conversion_with_rows ON public.entity_relationship_types;
DROP FUNCTION IF EXISTS public.reject_backed_relationship_conversion_with_rows();
DROP TRIGGER IF EXISTS trg_reject_rows_on_backed_relationship_type ON public.entity_relationships;
DROP FUNCTION IF EXISTS public.reject_rows_on_backed_relationship_type();

ALTER TABLE public.entity_relationship_types
  DROP CONSTRAINT IF EXISTS entity_relationship_types_backing_pair;
ALTER TABLE public.entity_relationship_types DROP COLUMN IF EXISTS backing_source;
ALTER TABLE public.entity_relationship_types DROP COLUMN IF EXISTS backing_sql;

ALTER TABLE public.entity_types
  DROP CONSTRAINT IF EXISTS entity_types_backing_activity_requires_source;
ALTER TABLE public.entity_types DROP COLUMN IF EXISTS backing_activity_sql;
