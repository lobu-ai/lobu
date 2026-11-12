-- Sanctioned, owner-requested removal of a retired feed's copied rows only.
-- psql -v workspace_slug=... -v connection_slug=... -v feed_id=... -f <this file>
-- Default is inventory only. After migration/retirement, repeat with
-- -v apply=true -v expected_rows=<the reviewed inventory count>.
-- Source tables, Automation runs/outputs and delivered notification events stay.
\set ON_ERROR_STOP on
\if :{?workspace_slug}
\else
  \echo 'workspace_slug is required'
  \quit 3
\endif
\if :{?connection_slug}
\else
  \echo 'connection_slug is required'
  \quit 3
\endif
\if :{?feed_id}
\else
  \echo 'feed_id is required'
  \quit 3
\endif
\if :{?apply}
\else
  \set apply false
\endif
\if :{?expected_rows}
\else
  \set expected_rows -1
\endif

SET statement_timeout = '30s';
SET lock_timeout = '3s';
CREATE TEMP TABLE cleanup_activity_scope AS
SELECT f.id AS feed_id, c.id AS connection_id, o.id AS organization_id,
       f.deleted_at IS NOT NULL AS retired
FROM feeds f JOIN connections c ON c.id = f.connection_id
JOIN organization o ON o.id = c.organization_id AND o.id = f.organization_id
WHERE o.slug = :'workspace_slug' AND c.slug = :'connection_slug'
  AND f.id = :'feed_id'::bigint AND c.connector_key = 'postgres' AND f.feed_key = 'query';
DO $$ BEGIN
  IF (SELECT count(*) FROM cleanup_activity_scope) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one explicitly selected Postgres query feed';
  END IF;
END $$;

CREATE TEMP TABLE cleanup_activity_ids AS
SELECT e.id FROM events e JOIN cleanup_activity_scope s
  ON e.organization_id = s.organization_id AND e.connection_id = s.connection_id AND e.feed_id = s.feed_id;
CREATE UNIQUE INDEX ON cleanup_activity_ids(id);
ANALYZE cleanup_activity_ids;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM events e JOIN cleanup_activity_ids t ON t.id = e.id
    WHERE e.origin_type IS DISTINCT FROM 'row' OR e.semantic_type IS DISTINCT FROM 'row'
      OR e.automation_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Scope contains something other than copied query rows';
  END IF;
END $$;
SELECT 'copied_events' AS kind, count(*) AS rows, coalesce(sum(pg_column_size(e)), 0) AS row_bytes
FROM events e JOIN cleanup_activity_ids t ON t.id = e.id;
SELECT 'dependent_vectors' AS kind, count(*) AS rows, coalesce(sum(pg_column_size(v)), 0) AS row_bytes
FROM event_embeddings v JOIN cleanup_activity_ids t ON t.id = v.event_id;

\if :apply
  CREATE TEMP TABLE cleanup_activity_expected AS SELECT :'expected_rows'::bigint AS n;
  DO $$ BEGIN
    IF NOT (SELECT retired FROM cleanup_activity_scope) THEN
      RAISE EXCEPTION 'Retire the feed after migrating both consumers before removal';
    END IF;
    IF (SELECT count(*) FROM cleanup_activity_ids) <> (SELECT n FROM cleanup_activity_expected) THEN
      RAISE EXCEPTION 'Count changed; repeat inventory and review the scope';
    END IF;
    IF EXISTS (SELECT 1 FROM events e JOIN cleanup_activity_ids t ON t.id = e.supersedes_event_id
      WHERE NOT EXISTS (SELECT 1 FROM cleanup_activity_ids own WHERE own.id = e.id)) THEN
      RAISE EXCEPTION 'Another source versions these rows; review the dependency';
    END IF;
    IF EXISTS (SELECT 1 FROM notification_targets n JOIN cleanup_activity_ids t ON t.id = n.event_id)
      OR EXISTS (SELECT 1 FROM scheduled_jobs j JOIN cleanup_activity_ids t ON t.id = j.source_event_id) THEN
      RAISE EXCEPTION 'Copied rows have notification or scheduled-job dependents; review first';
    END IF;
  END $$;
  -- Each batch has its own transaction. The existing guard's override cannot
  -- leak to a pooled connection. FK cascades remove only these rows' vectors,
  -- classifications and run-to-source references; no runs or reports are erased.
  SELECT format('BEGIN; SET LOCAL lobu.allow_event_delete = ''on'';
    DELETE FROM events WHERE id IN
      (SELECT id FROM cleanup_activity_ids ORDER BY id OFFSET %s LIMIT 1000);
    COMMIT;', batch * 1000)
  FROM generate_series(0, ((SELECT count(*) FROM cleanup_activity_ids) - 1) / 1000) batch
  WHERE (SELECT count(*) FROM cleanup_activity_ids) > 0
  \gexec
  SELECT 'remaining_copies' AS kind, count(*) AS rows FROM events e JOIN cleanup_activity_ids t ON t.id = e.id;
  SELECT 'remaining_vectors' AS kind, count(*) AS rows FROM event_embeddings v JOIN cleanup_activity_ids t ON t.id = v.event_id;
\else
  \echo 'Inventory only: no source or stored event data was removed.'
\endif
