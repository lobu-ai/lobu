-- migrate:up
-- lobu:no-quiesce -- requires 20261114120000's release to be fully deployed first: code before it inserts and reads the column.
--
-- Third step: drop events.linked_org_ids. Event visibility is owner-only
-- (events.organization_id), so the column, its two GIN indexes
-- (idx_events_linked_org_ids, idx_events_live_linked_org_ids) and its
-- projection in current_event_records have no reader or writer left. The
-- indexes and the old events_unbound_tool_audit constraint go with the column;
-- the validated replacement takes over the constraint's name.
--
-- The view is rebuilt because CREATE OR REPLACE VIEW cannot remove a column.
-- Table and surviving column grants, including grant options, are read before
-- the drop and reapplied, so roles granted outside the migrations keep access.
--
-- OPERATIONAL COST: catalog-only, no row rewrite. ACCESS EXCLUSIVE on events
-- and the view until the transaction commits, bounded by the 5s lock wait. Not
-- timed at production size.
SET LOCAL lock_timeout = '5s';

DO $rebuild$
DECLARE
  regrants text[];
  stmt text;
BEGIN
  SELECT COALESCE(array_agg(format(
           'GRANT %s ON public.current_event_records TO %s%s',
           acl.privilege_type,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE quote_ident(pg_get_userbyid(acl.grantee)) END,
           CASE WHEN acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)), '{}')
    INTO regrants
    FROM pg_class c
   CROSS JOIN LATERAL aclexplode(c.relacl) acl
   WHERE c.oid = to_regclass('public.current_event_records')
     AND acl.grantee <> c.relowner;

  SELECT regrants || COALESCE(array_agg(format(
           'GRANT %s (%I) ON public.current_event_records TO %s%s',
           acl.privilege_type,
           a.attname,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE quote_ident(pg_get_userbyid(acl.grantee)) END,
           CASE WHEN acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)), '{}')
    INTO regrants
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid
   CROSS JOIN LATERAL aclexplode(a.attacl) acl
   WHERE c.oid = to_regclass('public.current_event_records')
     AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname <> 'linked_org_ids'
     AND acl.grantee <> c.relowner;

  DROP VIEW IF EXISTS public.current_event_records;

  -- squawk-ignore ban-drop-column -- contract phase; nothing reads or writes the column since 20261114120000
  ALTER TABLE public.events DROP COLUMN IF EXISTS linked_org_ids;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.events'::regclass
      AND conname = 'events_unbound_tool_audit_owned'
  ) THEN
    ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_unbound_tool_audit;
    ALTER TABLE public.events
      RENAME CONSTRAINT events_unbound_tool_audit_owned TO events_unbound_tool_audit;
  END IF;

  CREATE VIEW public.current_event_records WITH (security_invoker = true) AS
   SELECT e.id,
      e.organization_id,
      e.entity_ids,
      e.origin_id,
      e.title,
      e.payload_type,
      e.payload_text,
      e.payload_data,
      e.payload_template,
      e.attachments,
      e.metadata,
      e.score,
      e.author_name,
      e.source_url,
      e.occurred_at,
      e.created_at,
      e.origin_parent_id,
      e.content_length,
      e.search_tsv,
      e.origin_type,
      e.connector_key,
      e.connection_id,
      e.feed_key,
      e.feed_id,
      e.run_id,
      e.semantic_type,
      e.client_id,
      e.created_by,
      e.interaction_type,
      e.interaction_status,
      e.interaction_input_schema,
      e.interaction_input,
      e.interaction_output,
      e.interaction_error,
      e.supersedes_event_id,
      e.identity_ns,
      e.identity_key,
      e.automation_id,
      e.automation_version_id
     FROM public.events e
    WHERE e.superseded_by IS NULL;

  FOREACH stmt IN ARRAY regrants LOOP
    EXECUTE stmt;
  END LOOP;
END $rebuild$;

-- migrate:down
-- Forward-only: the column was write-once, computed from other rows at insert,
-- and nothing read it by the time it was dropped. Restoring an empty column
-- would serve no code.
