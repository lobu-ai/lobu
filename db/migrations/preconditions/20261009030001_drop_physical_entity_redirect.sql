-- Existing installations must deploy the first retirement release before this
-- contract release. Fresh installs and pre-column schemas have no old readers
-- of this column; historical migrations will establish the fence in order.
DO $retirement$
DECLARE entities_oid oid := to_regclass('public.entities');
BEGIN
  IF entities_oid IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = entities_oid AND attname = 'merged_into' AND NOT attisdropped
  ) THEN
    IF EXISTS (SELECT 1 FROM public.entities WHERE merged_into IS NOT NULL) THEN
      RAISE EXCEPTION 'Physical merge redirects remain; complete audited maintenance with the first physical-merge retirement release before upgrading';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = entities_oid AND conname = 'entities_physical_merge_retired'
        AND contype = 'c' AND convalidated
        AND pg_get_expr(conbin, conrelid) = '(merged_into IS NULL)'
    ) THEN
      RAISE EXCEPTION 'Deploy the first physical-merge retirement release with its validated redirect fence before upgrading';
    END IF;
  END IF;
END
$retirement$;
