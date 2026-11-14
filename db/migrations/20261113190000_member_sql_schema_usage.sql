-- migrate:up
-- lobu:no-quiesce  (privilege check only; changes no table)
--
-- 20261113170000 grants `lobu_member_sql` usage of schema public as the
-- migration role. A GRANT the grantor may not make is only a warning: where
-- the schema belongs to another role and PUBLIC has no usage (prod), the role
-- got nothing, and every fenced member SQL read failed with "permission
-- denied for schema public" until an administrator granted it. Stop here
-- with that administrator's command instead.

GRANT USAGE ON SCHEMA public TO lobu_member_sql;

DO $usage$
BEGIN
  IF NOT has_schema_privilege('lobu_member_sql', 'public', 'USAGE') THEN
    RAISE EXCEPTION '% cannot grant role lobu_member_sql usage of schema public (it does not own the schema). As a database administrator run: GRANT USAGE ON SCHEMA public TO lobu_member_sql;', current_user;
  END IF;
END
$usage$;

-- migrate:down
-- lobu:no-quiesce
-- 20261113170000's down migration revokes the usage.
SELECT 1;
