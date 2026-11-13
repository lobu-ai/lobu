-- migrate:up
-- lobu:no-quiesce  (same row sets as 20261113170000; only the plans change)
--
-- The member SQL policies read the workspace and principal through scalar
-- subqueries, which the planner cannot see when it estimates. On prod's
-- largest workspace (3.1M live events) it assumed an average workspace, chose
-- a serial bitmap scan, and sorted on disk: a full-workspace GROUP BY went
-- from 3.1s as the app to 6.0s fenced, past member SQL's 5s cap.
--
-- `current_setting` is a stable function, so the planner folds it when it
-- estimates and can still use it as an index condition. The events policy's
-- connection check becomes an uncorrelated `IN`, which runs as one hashed
-- subplan that parallel workers can share. On a 4M-event copy with the same
-- skew, the fenced plans are parallel again and within 20% of the app role's.
-- An unset setting still matches nothing.

SET LOCAL lock_timeout = '5s';

ALTER POLICY member_sql_scope ON public.organization USING (
  id = current_setting('lobu.member_sql_org', true) OR visibility = 'public'
);

ALTER POLICY member_sql_scope ON public.connections USING (
  organization_id = current_setting('lobu.member_sql_org', true)
  AND (visibility = 'org' OR created_by = NULLIF(current_setting('lobu.member_sql_principal', true), ''))
);

ALTER POLICY member_sql_scope ON public.entities USING (
  organization_id = current_setting('lobu.member_sql_org', true)
);

ALTER POLICY member_sql_scope ON public.entity_types USING (
  organization_id = current_setting('lobu.member_sql_org', true)
  OR EXISTS (SELECT 1 FROM public.organization o WHERE o.id = entity_types.organization_id AND o.visibility = 'public')
);

ALTER POLICY member_sql_scope ON public.entity_relationship_types USING (
  organization_id = current_setting('lobu.member_sql_org', true)
  OR EXISTS (SELECT 1 FROM public.organization o WHERE o.id = entity_relationship_types.organization_id AND o.visibility = 'public')
);

ALTER POLICY member_sql_scope ON public.entity_identities USING (
  organization_id = current_setting('lobu.member_sql_org', true)
);

ALTER POLICY member_sql_scope ON public.entity_relationships USING (
  organization_id = current_setting('lobu.member_sql_org', true)
);

ALTER POLICY member_sql_scope ON public.authz_source_acl_state USING (
  organization_id = current_setting('lobu.member_sql_org', true)
);

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

ALTER POLICY member_sql_scope ON public.channel_messages USING (
  organization_id = current_setting('lobu.member_sql_org', true)
  AND EXISTS (
    SELECT 1 FROM public.connections cc
    WHERE cc.deleted_at IS NULL
      AND cc.slug IN (channel_messages.connection_id, 'agentconn-' || channel_messages.connection_id)
  )
);

ALTER POLICY member_sql_scope ON public.feeds USING (
  organization_id = current_setting('lobu.member_sql_org', true)
  AND EXISTS (SELECT 1 FROM public.connections fc WHERE fc.id = feeds.connection_id)
);

ALTER POLICY member_sql_scope ON public.automations USING (
  organization_id = current_setting('lobu.member_sql_org', true)
);

ALTER POLICY member_sql_scope ON public.oauth_clients USING (
  organization_id = current_setting('lobu.member_sql_org', true)
);

ALTER POLICY member_sql_scope ON public.oauth_tokens USING (
  organization_id = current_setting('lobu.member_sql_org', true)
);

ALTER POLICY member_sql_scope ON public.member USING (
  "organizationId" = current_setting('lobu.member_sql_org', true)
);

ALTER POLICY member_sql_scope ON public.connector_definitions USING (
  organization_id = current_setting('lobu.member_sql_org', true)
);

ALTER POLICY member_sql_scope ON public.device_workers USING (
  user_id = NULLIF(current_setting('lobu.member_sql_principal', true), '')
  AND (organization_id = current_setting('lobu.member_sql_org', true) OR organization_id IS NULL)
);

-- migrate:down
-- lobu:no-quiesce

SET LOCAL lock_timeout = '5s';

ALTER POLICY member_sql_scope ON public.organization USING (
  id = (SELECT current_setting('lobu.member_sql_org', true)) OR visibility = 'public'
);

ALTER POLICY member_sql_scope ON public.connections USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
  AND (visibility = 'org' OR created_by = (SELECT NULLIF(current_setting('lobu.member_sql_principal', true), '')))
);

ALTER POLICY member_sql_scope ON public.entities USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

ALTER POLICY member_sql_scope ON public.entity_types USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
  OR EXISTS (SELECT 1 FROM public.organization o WHERE o.id = entity_types.organization_id AND o.visibility = 'public')
);

ALTER POLICY member_sql_scope ON public.entity_relationship_types USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
  OR EXISTS (SELECT 1 FROM public.organization o WHERE o.id = entity_relationship_types.organization_id AND o.visibility = 'public')
);

ALTER POLICY member_sql_scope ON public.entity_identities USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

ALTER POLICY member_sql_scope ON public.entity_relationships USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

ALTER POLICY member_sql_scope ON public.authz_source_acl_state USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

ALTER POLICY member_sql_scope ON public.events USING (
  (
    organization_id = (SELECT current_setting('lobu.member_sql_org', true))
    OR linked_org_ids @> ARRAY[(SELECT current_setting('lobu.member_sql_org', true))]::text[]
  )
  AND (
    connection_id IS NULL
    OR EXISTS (SELECT 1 FROM public.connections vc WHERE vc.id = events.connection_id AND vc.deleted_at IS NULL)
  )
);

ALTER POLICY member_sql_scope ON public.channel_messages USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
  AND EXISTS (
    SELECT 1 FROM public.connections cc
    WHERE cc.deleted_at IS NULL
      AND cc.slug IN (channel_messages.connection_id, 'agentconn-' || channel_messages.connection_id)
  )
);

ALTER POLICY member_sql_scope ON public.feeds USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
  AND EXISTS (SELECT 1 FROM public.connections fc WHERE fc.id = feeds.connection_id)
);

ALTER POLICY member_sql_scope ON public.automations USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

ALTER POLICY member_sql_scope ON public.oauth_clients USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

ALTER POLICY member_sql_scope ON public.oauth_tokens USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

ALTER POLICY member_sql_scope ON public.member USING (
  "organizationId" = (SELECT current_setting('lobu.member_sql_org', true))
);

ALTER POLICY member_sql_scope ON public.connector_definitions USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

ALTER POLICY member_sql_scope ON public.device_workers USING (
  user_id = (SELECT NULLIF(current_setting('lobu.member_sql_principal', true), ''))
  AND (organization_id = (SELECT current_setting('lobu.member_sql_org', true)) OR organization_id IS NULL)
);
