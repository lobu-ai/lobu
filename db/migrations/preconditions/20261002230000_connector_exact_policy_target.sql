-- External prerequisite of binding exact connector policies to their connector.
-- The migration cannot choose a connector for an unqualified key or decide
-- between two existing rules for the same canonical scope; an admin must
-- rewrite or delete those rules first. On a fresh install the scope columns do
-- not exist yet.
DO $precondition$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'write_approval_policies'
      AND column_name = 'connector_key'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.write_approval_policies
      WHERE resource_class = 'connector_action' AND operation_key IS NOT NULL
        AND connector_key IS NULL AND connection_id IS NULL
        AND (strpos(operation_key, '::') <= 1 OR length(operation_key) = strpos(operation_key, '::') + 1)
    ) THEN
      RAISE EXCEPTION 'write_approval_policies has exact connector_action rules without a connector::action key; rewrite or delete them before deploying';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.write_approval_policies legacy
      JOIN public.write_approval_policies canonical
        ON canonical.organization_id = legacy.organization_id
        AND canonical.resource_class = legacy.resource_class
        AND COALESCE(canonical.principal_kind, '') = COALESCE(legacy.principal_kind, '')
        AND COALESCE(canonical.principal_id, '') = COALESCE(legacy.principal_id, '')
        AND canonical.operation_key = legacy.operation_key
        AND canonical.connector_key = split_part(legacy.operation_key, '::', 1)
        AND canonical.connection_id IS NULL
      WHERE legacy.resource_class = 'connector_action' AND legacy.operation_key IS NOT NULL
        AND legacy.connector_key IS NULL AND legacy.connection_id IS NULL
    ) THEN
      RAISE EXCEPTION 'write_approval_policies has exact connector_action rules duplicated with and without connector_key; delete one of each pair before deploying';
    END IF;
  END IF;
END
$precondition$;
