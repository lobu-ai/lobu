-- migrate:up
-- lobu:no-quiesce  (the policy applies only to lobu_member_sql; no lock beyond the catalog update)
--
-- An event is visible in the workspace that owns it, and nowhere else. The
-- write-time bridge (`linked_org_ids`) also admitted events that tagged
-- another workspace's record or came through its connection. In production it
-- matched only relationship audits of a private workspace, surfaced inside
-- the public workspace whose record they link to; the relationship itself is
-- hidden from that workspace.
--
-- The application stops writing and reading the column in this release. The
-- column, its two GIN indexes and its view projection are dropped in the next
-- release, once no running replica references them.

SET LOCAL lock_timeout = '5s';

ALTER POLICY member_sql_scope ON public.events USING (
  organization_id = current_setting('lobu.member_sql_org', true)
  AND (
    connection_id IS NULL
    OR connection_id IN (SELECT vc.id FROM public.connections vc WHERE vc.deleted_at IS NULL)
  )
);

-- migrate:down
-- lobu:no-quiesce

SET LOCAL lock_timeout = '5s';

ALTER POLICY member_sql_scope ON public.events USING (
  (
    organization_id = current_setting('lobu.member_sql_org', true)
    OR linked_org_ids @> ARRAY[current_setting('lobu.member_sql_org', true)]
  )
  AND (
    connection_id IS NULL
    OR connection_id IN (SELECT vc.id FROM public.connections vc WHERE vc.deleted_at IS NULL)
  )
);
