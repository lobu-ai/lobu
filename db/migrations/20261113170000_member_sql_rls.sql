-- migrate:up
-- lobu:no-quiesce  (policies apply only to the new role, which no running release uses)
--
-- Member SQL (query_sql, client.query, metric_series, metrics, Automation
-- sources, entity segments) reads through scope CTEs that Postgres inlines,
-- so the planner may evaluate a caller predicate on another workspace's row
-- before the scope predicate removes it, and an error raised by that row's
-- value answers a yes/no question about it. Row-level security quals are
-- security barriers: Postgres applies them before any caller predicate that
-- is not leakproof.
--
-- The tables' owner bypasses row-level security, so member SQL switches into
-- the NOLOGIN role `lobu_member_sql` for its transaction (SET LOCAL ROLE) and
-- reads its workspace and principal from transaction-local settings, which
-- end with the transaction under any connection pooler.
--
-- Each table gets two policies:
--   * `member_sql_any_row`: permissive, every role, every row. Other roles
--     (read-only operator logins) keep exactly the rows they see today.
--   * `member_sql_scope`: restrictive, `lobu_member_sql` only. It narrows that
--     role to its workspace. A restrictive policy is ANDed with the planner's
--     quals, so the events scope stays an index condition.
-- The events scope is the write-time org bridge (`linked_org_ids`), the
-- indexable form. Every insert writes it. Rows from before it carry NULL; the
-- step below fills the bridge on each such row that reaches another
-- workspace, so the policy admits every event the CTE bridge does. NULL rows
-- with no other workspace stay NULL: `organization_id` already admits them.
--
-- Creating a role needs CREATEROLE. Where the migration role lacks it, a
-- database administrator runs this once before deploying:
--   CREATE ROLE lobu_member_sql NOLOGIN;
--   GRANT lobu_member_sql TO <app role> WITH INHERIT FALSE, SET TRUE;

SET LOCAL lock_timeout = '5s';

-- One sequential scan of the NULL rows; it takes row locks only, so traffic
-- continues. The expression is the insert path's (scripts/backfill-linked-org-ids.ts).
SET LOCAL statement_timeout = '15min';
UPDATE public.events e
SET linked_org_ids = (
  SELECT COALESCE(array_agg(DISTINCT x.o), '{}'::text[])
  FROM (
    SELECT ent.organization_id AS o FROM public.entities ent WHERE ent.id = ANY(e.entity_ids)
    UNION ALL
    SELECT c.organization_id AS o FROM public.connections c WHERE c.id = e.connection_id
  ) x
  WHERE x.o IS NOT NULL AND (x.o <> e.organization_id OR e.organization_id IS NULL)
)
WHERE e.linked_org_ids IS NULL
  AND (
    EXISTS (SELECT 1 FROM public.entities ent WHERE ent.id = ANY(e.entity_ids) AND ent.organization_id <> e.organization_id)
    OR EXISTS (SELECT 1 FROM public.connections c WHERE c.id = e.connection_id AND c.organization_id <> e.organization_id)
  );
SET LOCAL statement_timeout TO DEFAULT;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lobu_member_sql') THEN
    BEGIN
      CREATE ROLE lobu_member_sql NOLOGIN;
    EXCEPTION
      -- Roles are cluster-wide: another database on this server created it first.
      WHEN duplicate_object OR unique_violation THEN NULL;
      WHEN insufficient_privilege THEN
        RAISE EXCEPTION 'Role lobu_member_sql is missing and % cannot create it. As a database administrator run: CREATE ROLE lobu_member_sql NOLOGIN; GRANT lobu_member_sql TO % WITH INHERIT FALSE, SET TRUE;', current_user, current_user;
    END;
  END IF;
  IF NOT pg_has_role(current_user, 'lobu_member_sql', 'SET') THEN
    BEGIN
      EXECUTE format('GRANT lobu_member_sql TO %I WITH INHERIT FALSE, SET TRUE', current_user);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION '% cannot switch to role lobu_member_sql. As a database administrator run: GRANT lobu_member_sql TO % WITH INHERIT FALSE, SET TRUE;', current_user, current_user;
    END;
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA public TO lobu_member_sql;
GRANT SELECT ON
  public.events, public.current_event_records, public.event_classifications,
  public.channel_messages, public.entities, public.entity_types,
  public.entity_identities, public.entity_relationships,
  public.entity_relationship_types, public.connections, public.feeds,
  public.automations, public.automation_versions, public.oauth_clients,
  public.oauth_tokens, public."user", public.member, public.organization,
  public.connector_definitions, public.device_workers,
  public.authz_source_acl_state
TO lobu_member_sql;

-- The view reads `events` with the caller's rights, so the events policy
-- applies through it.
ALTER VIEW public.current_event_records SET (security_invoker = true);

DO $policies$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'events', 'event_classifications', 'channel_messages', 'entities',
    'entity_types', 'entity_identities', 'entity_relationships',
    'entity_relationship_types', 'connections', 'feeds', 'automations',
    'automation_versions', 'oauth_clients', 'oauth_tokens', 'user', 'member',
    'organization', 'connector_definitions', 'device_workers',
    'authz_source_acl_state'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY member_sql_any_row ON public.%I AS PERMISSIVE TO PUBLIC USING (true)', t);
  END LOOP;
END
$policies$;

-- Scopes. Each setting is a scalar subquery, so it is read once per statement
-- (an InitPlan) and can drive an index scan. An unset setting matches nothing.
-- A policy's subquery is itself subject to the referenced table's policy, so
-- `EXISTS (... connections ...)` sees only connections this principal may see.

CREATE POLICY member_sql_scope ON public.organization AS RESTRICTIVE TO lobu_member_sql USING (
  id = (SELECT current_setting('lobu.member_sql_org', true)) OR visibility = 'public'
);

-- Org-shared connections, and the principal's own private ones.
CREATE POLICY member_sql_scope ON public.connections AS RESTRICTIVE TO lobu_member_sql USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
  AND (visibility = 'org' OR created_by = (SELECT NULLIF(current_setting('lobu.member_sql_principal', true), '')))
);

CREATE POLICY member_sql_scope ON public.entities AS RESTRICTIVE TO lobu_member_sql USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

-- A workspace's records may use a public catalog's types.
CREATE POLICY member_sql_scope ON public.entity_types AS RESTRICTIVE TO lobu_member_sql USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
  OR EXISTS (SELECT 1 FROM public.organization o WHERE o.id = entity_types.organization_id AND o.visibility = 'public')
);

CREATE POLICY member_sql_scope ON public.entity_relationship_types AS RESTRICTIVE TO lobu_member_sql USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
  OR EXISTS (SELECT 1 FROM public.organization o WHERE o.id = entity_relationship_types.organization_id AND o.visibility = 'public')
);

CREATE POLICY member_sql_scope ON public.entity_identities AS RESTRICTIVE TO lobu_member_sql USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

CREATE POLICY member_sql_scope ON public.entity_relationships AS RESTRICTIVE TO lobu_member_sql USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

CREATE POLICY member_sql_scope ON public.authz_source_acl_state AS RESTRICTIVE TO lobu_member_sql USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

-- Stamped to the workspace or bridged to it, and, when connection-sourced,
-- from a live connection the principal may see.
CREATE POLICY member_sql_scope ON public.events AS RESTRICTIVE TO lobu_member_sql USING (
  (
    organization_id = (SELECT current_setting('lobu.member_sql_org', true))
    OR linked_org_ids @> ARRAY[(SELECT current_setting('lobu.member_sql_org', true))]::text[]
  )
  AND (
    connection_id IS NULL
    OR EXISTS (SELECT 1 FROM public.connections vc WHERE vc.id = events.connection_id AND vc.deleted_at IS NULL)
  )
);

-- Visible exactly when its event is.
CREATE POLICY member_sql_scope ON public.event_classifications AS RESTRICTIVE TO lobu_member_sql USING (
  EXISTS (SELECT 1 FROM public.events ev WHERE ev.id = event_classifications.event_id)
);

-- channel_messages.connection_id is the runtime slug, not connections.id.
CREATE POLICY member_sql_scope ON public.channel_messages AS RESTRICTIVE TO lobu_member_sql USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
  AND EXISTS (
    SELECT 1 FROM public.connections cc
    WHERE cc.deleted_at IS NULL
      AND cc.slug IN (channel_messages.connection_id, 'agentconn-' || channel_messages.connection_id)
  )
);

CREATE POLICY member_sql_scope ON public.feeds AS RESTRICTIVE TO lobu_member_sql USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
  AND EXISTS (SELECT 1 FROM public.connections fc WHERE fc.id = feeds.connection_id)
);

CREATE POLICY member_sql_scope ON public.automations AS RESTRICTIVE TO lobu_member_sql USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

CREATE POLICY member_sql_scope ON public.automation_versions AS RESTRICTIVE TO lobu_member_sql USING (
  EXISTS (SELECT 1 FROM public.automations w WHERE w.id = automation_versions.automation_id)
);

CREATE POLICY member_sql_scope ON public.oauth_clients AS RESTRICTIVE TO lobu_member_sql USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

CREATE POLICY member_sql_scope ON public.oauth_tokens AS RESTRICTIVE TO lobu_member_sql USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

CREATE POLICY member_sql_scope ON public.member AS RESTRICTIVE TO lobu_member_sql USING (
  "organizationId" = (SELECT current_setting('lobu.member_sql_org', true))
);

CREATE POLICY member_sql_scope ON public."user" AS RESTRICTIVE TO lobu_member_sql USING (
  EXISTS (SELECT 1 FROM public.member m WHERE m."userId" = "user".id)
);

CREATE POLICY member_sql_scope ON public.connector_definitions AS RESTRICTIVE TO lobu_member_sql USING (
  organization_id = (SELECT current_setting('lobu.member_sql_org', true))
);

-- A device belongs to its owner; the workspace only records where it is attached.
CREATE POLICY member_sql_scope ON public.device_workers AS RESTRICTIVE TO lobu_member_sql USING (
  user_id = (SELECT NULLIF(current_setting('lobu.member_sql_principal', true), ''))
  AND (organization_id = (SELECT current_setting('lobu.member_sql_org', true)) OR organization_id IS NULL)
);

-- migrate:down
-- lobu:no-quiesce

ALTER VIEW public.current_event_records RESET (security_invoker);

DO $policies$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'events', 'event_classifications', 'channel_messages', 'entities',
    'entity_types', 'entity_identities', 'entity_relationships',
    'entity_relationship_types', 'connections', 'feeds', 'automations',
    'automation_versions', 'oauth_clients', 'oauth_tokens', 'user', 'member',
    'organization', 'connector_definitions', 'device_workers',
    'authz_source_acl_state'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS member_sql_scope ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS member_sql_any_row ON public.%I', t);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$policies$;

-- The role is cluster-wide and may serve other databases, so it stays; it
-- holds no privileges here once these are revoked.
DO $revoke$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lobu_member_sql') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM lobu_member_sql;
    REVOKE USAGE ON SCHEMA public FROM lobu_member_sql;
  END IF;
END
$revoke$;
