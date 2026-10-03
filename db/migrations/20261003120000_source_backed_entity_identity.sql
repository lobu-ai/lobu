-- migrate:up

-- A connection-backed entity type may declare `backing_identity`: the identity
-- namespace whose identifier IS the source canonical key (the backing SQL's
-- slug/id column). Such a type keeps stored identity rows in `entities`
-- (slug = source key, name) so events, relationships, views and ACL can key on
-- a numeric id; its attributes are still read live from the source. Internal
-- views (no connection) and connection-backed types without an identity remain
-- pure views with no stored rows.
ALTER TABLE public.entity_types ADD COLUMN IF NOT EXISTS backing_identity text;

ALTER TABLE public.entity_types
  DROP CONSTRAINT IF EXISTS entity_types_backing_identity_requires_source;
ALTER TABLE public.entity_types
  -- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
  ADD CONSTRAINT entity_types_backing_identity_requires_source CHECK (
    backing_identity IS NULL
    OR (backing_source IS NOT NULL AND backing_sql IS NOT NULL AND btrim(backing_identity) <> '')
  );

-- (1) Stored rows are allowed only on stored types and identity-backed types.
CREATE OR REPLACE FUNCTION public.reject_rows_on_derived_entity_type()
  RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.entity_types et
    WHERE et.id = NEW.entity_type_id
      AND et.backing_sql IS NOT NULL
      AND et.backing_identity IS NULL
  ) THEN
    RAISE EXCEPTION
      'entity type % is derived (a SQL view) and cannot have stored rows',
      NEW.entity_type_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- (2) A populated type may not become a pure view, and a stored type may not
-- become identity-backed while it has rows: their slugs are not source keys.
-- An identity-backed type may change its SQL while it keeps its identity.
CREATE OR REPLACE FUNCTION public.reject_derived_conversion_with_rows()
  RETURNS trigger AS $$
BEGIN
  IF NEW.backing_sql IS NOT NULL
    AND (
      NEW.backing_identity IS NULL
      OR OLD.backing_sql IS NULL
      OR OLD.backing_identity IS DISTINCT FROM NEW.backing_identity
    )
    AND EXISTS (
      SELECT 1 FROM public.entities e
      WHERE e.entity_type_id = NEW.id AND e.deleted_at IS NULL
    ) THEN
    RAISE EXCEPTION
      'entity type % cannot change its backing identity while stored rows exist; delete them first',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reject_derived_conversion_with_rows ON public.entity_types;
CREATE TRIGGER trg_reject_derived_conversion_with_rows
  BEFORE UPDATE OF backing_sql, backing_source, backing_identity ON public.entity_types
  FOR EACH ROW EXECUTE FUNCTION public.reject_derived_conversion_with_rows();

-- migrate:down

DROP TRIGGER IF EXISTS trg_reject_derived_conversion_with_rows ON public.entity_types;
CREATE OR REPLACE FUNCTION public.reject_derived_conversion_with_rows()
  RETURNS trigger AS $$
BEGIN
  IF NEW.backing_sql IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.entities e
    WHERE e.entity_type_id = NEW.id AND e.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'entity type % cannot become a derived view while stored rows exist; delete them first',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_reject_derived_conversion_with_rows
  BEFORE UPDATE OF backing_sql ON public.entity_types
  FOR EACH ROW EXECUTE FUNCTION public.reject_derived_conversion_with_rows();

CREATE OR REPLACE FUNCTION public.reject_rows_on_derived_entity_type()
  RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.entity_types et
    WHERE et.id = NEW.entity_type_id AND et.backing_sql IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'entity type % is derived (a SQL view) and cannot have stored rows',
      NEW.entity_type_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE public.entity_types
  DROP CONSTRAINT IF EXISTS entity_types_backing_identity_requires_source;
ALTER TABLE public.entity_types DROP COLUMN IF EXISTS backing_identity;
