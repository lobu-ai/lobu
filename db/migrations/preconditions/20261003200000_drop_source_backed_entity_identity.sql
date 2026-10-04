-- External prerequisite of dropping source-backed identity rows: no live stored
-- row may remain on a type with backing SQL. Those rows mirror source records;
-- an admin must delete them (and their identities and edges) before deploying.
-- Fresh installs run this before the baseline and backing SQL column exist.
DO $precondition$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'entity_types'
      AND column_name = 'backing_sql'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.entities e
      JOIN public.entity_types et ON et.id = e.entity_type_id
      WHERE et.backing_sql IS NOT NULL AND e.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'stored entities exist on source-backed entity types; delete them before deploying';
    END IF;
  END IF;
END
$precondition$;
