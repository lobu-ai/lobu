-- migrate:up
-- lobu:quiesce old replicas read and write agents.skills_config as the source of agent skills; one serving after the backfill could change a skill the library never sees

-- Skills reader cutover (P3a). Agent skills move from agents.skills_config to
-- the workspace library (workspace_skills + workspace_skill_subjects), and
-- skill governance moves from the agent_config policy class to skill_config.
-- Runs in one transaction, in this order:
--   1. the deterministic, idempotent library backfill;
--   2. the fail-closed skill_config policy migration.
-- The deploy quiesces (see the declaration above), so no old replica writes
-- skills_config after the backfill reads it. The column itself stays until a
-- later cleanup drops it, so a code rollback still finds the data it reads.
-- automation_versions is never written: a version's frozen skill copies keep
-- their original names and bodies.

-- 1. Backfill. Only organizations with no library rows are processed, so a
-- re-run is a no-op. Agents are ordered by id (byte order) and skills by their
-- array index; every name, id and sort order is a function of that input.
DO $backfill$
DECLARE
  offenders text;
  pending record;
  taken text[];
  candidate text;
  n integer;
  current_org text := NULL;
  report record;
BEGIN
  CREATE TEMP TABLE skill_backfill_items  AS
  SELECT a.organization_id AS org,
         a.id AS agent_id,
         (e.ord - 1)::integer AS idx,
         e.item
  FROM agents a
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(a.skills_config -> 'skills') = 'array'
         THEN a.skills_config -> 'skills' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS e(item, ord)
  WHERE NOT EXISTS (
    SELECT 1 FROM workspace_skills ws WHERE ws.organization_id = a.organization_id
  );

  -- Preflight: abort with every offender rather than drop data silently.
  SELECT string_agg(format('org=%s agent=%s %s', org, agent_id, problem), E'\n' ORDER BY org, agent_id, problem)
  INTO offenders
  FROM (
    SELECT a.organization_id AS org, a.id AS agent_id,
           'skills_config.skills is not an array' AS problem
    FROM agents a
    WHERE a.skills_config IS NOT NULL
      AND jsonb_typeof(a.skills_config) = 'object'
      AND a.skills_config ? 'skills'
      AND jsonb_typeof(a.skills_config -> 'skills') NOT IN ('array', 'null')
      AND NOT EXISTS (SELECT 1 FROM workspace_skills ws WHERE ws.organization_id = a.organization_id)
    UNION ALL
    SELECT a.organization_id, a.id, 'skills_config is not an object'
    FROM agents a
    WHERE a.skills_config IS NOT NULL
      AND jsonb_typeof(a.skills_config) NOT IN ('object', 'null')
      AND NOT EXISTS (SELECT 1 FROM workspace_skills ws WHERE ws.organization_id = a.organization_id)
    UNION ALL
    SELECT org, agent_id, format('skills[%s] is not an object', idx)
    FROM skill_backfill_items WHERE jsonb_typeof(item) <> 'object'
    UNION ALL
    SELECT org, agent_id, format('skills[%s] has neither content nor instructions', idx)
    FROM skill_backfill_items
    WHERE jsonb_typeof(item) = 'object'
      AND NOT COALESCE(jsonb_typeof(item -> 'content') = 'string' AND item ->> 'content' ~ '[^[:space:]]', false)
      AND NOT COALESCE(jsonb_typeof(item -> 'instructions') = 'string' AND item ->> 'instructions' ~ '[^[:space:]]', false)
    UNION ALL
    SELECT org, agent_id, format('skills[%s] body is over 64000 characters', idx)
    FROM skill_backfill_items
    WHERE jsonb_typeof(item) = 'object'
      AND length(CASE
        WHEN jsonb_typeof(item -> 'content') = 'string' AND item ->> 'content' ~ '[^[:space:]]' THEN item ->> 'content'
        ELSE item ->> 'instructions' END) > 64000
  ) problems;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION E'workspace skill backfill aborted; fix these agent skills and re-run:\n%', offenders
      USING ERRCODE = 'check_violation';
  END IF;

  -- Normalize each item: name, body, description, enabled.
  CREATE TEMP TABLE skill_backfill_norm  AS
  SELECT org, agent_id, idx, raw_name, norm_name, body,
         COALESCE(
           item_description,
           (SELECT left(stripped, 1024)
            FROM regexp_split_to_table(body, E'\n') WITH ORDINALITY AS l(line, n)
            CROSS JOIN LATERAL (
              SELECT regexp_replace(l.line, '^[#[:space:]]+|[[:space:]]+$', '', 'g') AS stripped
            ) s
            WHERE s.stripped <> ''
            ORDER BY l.n
            LIMIT 1),
           norm_name
         ) AS description,
         enabled,
         provenance
  FROM (
    SELECT org, agent_id, idx,
           item ->> 'name' AS raw_name,
           rtrim(left(
             CASE WHEN slug = '' THEN 'skill' ELSE slug END, 64), '-') AS norm_name,
           CASE WHEN jsonb_typeof(item -> 'content') = 'string' AND item ->> 'content' ~ '[^[:space:]]'
                THEN item ->> 'content' ELSE item ->> 'instructions' END AS body,
           CASE WHEN jsonb_typeof(item -> 'description') = 'string' AND item ->> 'description' ~ '[^[:space:]]'
                THEN left(regexp_replace(item ->> 'description', '^[[:space:]]+|[[:space:]]+$', '', 'g'), 1024) END AS item_description,
           (item -> 'enabled') = 'true'::jsonb AS enabled,
           CASE WHEN jsonb_typeof(item -> 'repo') = 'string' AND item ->> 'repo' ~ '[^[:space:]]'
                THEN item ->> 'repo' END AS provenance
    FROM skill_backfill_items
    CROSS JOIN LATERAL (
      SELECT btrim(regexp_replace(lower(COALESCE(item ->> 'name', '')), '[^a-z0-9]+', '-', 'g'), '-') AS slug
    ) s
  ) normalized;

  -- One library row per distinct (name, body, description, enabled) tuple,
  -- ranked by its first occurrence in (agent id, array index) order.
  CREATE TEMP TABLE skill_backfill_tuples  AS
  SELECT org, norm_name, body, description, enabled,
         min(idx) AS sort_order,
         (array_agg(provenance ORDER BY agent_id COLLATE "C", idx))[1] AS provenance,
         (array_agg(agent_id ORDER BY agent_id COLLATE "C", idx))[1] AS first_agent,
         (array_agg(idx ORDER BY agent_id COLLATE "C", idx))[1] AS first_idx,
         NULL::text AS final_name
  FROM skill_backfill_norm
  GROUP BY org, norm_name, body, description, enabled;

  -- The first tuple for each normalized name keeps it.
  UPDATE skill_backfill_tuples t
  SET final_name = t.norm_name
  WHERE NOT EXISTS (
    SELECT 1 FROM skill_backfill_tuples o
    WHERE o.org = t.org AND o.norm_name = t.norm_name
      AND (o.first_agent COLLATE "C", o.first_idx) < (t.first_agent COLLATE "C", t.first_idx)
  );

  -- Every later tuple takes the first free <base>-<n>, checked against the
  -- org's whole set of taken names so a suffix never collides with a natural name.
  FOR pending IN
    SELECT ctid AS row_ref, org, norm_name
    FROM skill_backfill_tuples
    WHERE final_name IS NULL
    ORDER BY org COLLATE "C", first_agent COLLATE "C", first_idx
  LOOP
    IF current_org IS DISTINCT FROM pending.org THEN
      current_org := pending.org;
      SELECT COALESCE(array_agg(final_name), ARRAY[]::text[]) INTO taken
      FROM skill_backfill_tuples WHERE org = pending.org AND final_name IS NOT NULL;
    END IF;
    n := 2;
    LOOP
      candidate := rtrim(left(pending.norm_name, 64 - length('-' || n)), '-') || '-' || n;
      EXIT WHEN NOT (candidate = ANY (taken));
      n := n + 1;
    END LOOP;
    taken := taken || candidate;
    UPDATE skill_backfill_tuples SET final_name = candidate WHERE ctid = pending.row_ref;
  END LOOP;

  INSERT INTO workspace_skills
    (id, organization_id, name, description, content, provenance, enabled, sort_order)
  SELECT 'skill_' || md5(org || '/' || final_name), org, final_name, description, body,
         provenance, enabled, sort_order
  FROM skill_backfill_tuples
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO workspace_skill_subjects (skill_id, organization_id, principal_kind, principal_id)
  SELECT DISTINCT 'skill_' || md5(t.org || '/' || t.final_name), t.org, 'agent', n.agent_id
  FROM skill_backfill_norm n
  JOIN skill_backfill_tuples t
    ON t.org = n.org AND t.norm_name = n.norm_name AND t.body = n.body
   AND t.description = n.description AND t.enabled = n.enabled
  ON CONFLICT DO NOTHING;

  -- Report: renamed items, split names, and agents whose order changed.
  FOR report IN
    SELECT DISTINCT n.org, n.agent_id, n.idx, n.raw_name, t.final_name
    FROM skill_backfill_norm n
    JOIN skill_backfill_tuples t
      ON t.org = n.org AND t.norm_name = n.norm_name AND t.body = n.body
     AND t.description = n.description AND t.enabled = n.enabled
    WHERE n.raw_name IS DISTINCT FROM t.final_name
    ORDER BY n.org, n.agent_id, n.idx
  LOOP
    RAISE NOTICE 'workspace skill backfill: renamed org=% agent=% skills[%] % -> %',
      report.org, report.agent_id, report.idx, report.raw_name, report.final_name;
  END LOOP;

  FOR report IN
    SELECT org, norm_name, string_agg(final_name, ', ' ORDER BY first_agent COLLATE "C", first_idx) AS names
    FROM skill_backfill_tuples
    GROUP BY org, norm_name
    HAVING count(*) > 1
    ORDER BY org, norm_name
  LOOP
    RAISE NOTICE 'workspace skill backfill: split org=% name=% into %',
      report.org, report.norm_name, report.names;
  END LOOP;

  FOR report IN
    WITH delivered AS (
      SELECT DISTINCT n.org, n.agent_id, n.idx, t.final_name, t.sort_order
      FROM skill_backfill_norm n
      JOIN skill_backfill_tuples t
        ON t.org = n.org AND t.norm_name = n.norm_name AND t.body = n.body
       AND t.description = n.description AND t.enabled = n.enabled
      WHERE n.enabled
    ),
    ranked AS (
      SELECT org, agent_id,
             array_agg(final_name ORDER BY idx) AS before_order,
             array_agg(final_name ORDER BY sort_order, final_name COLLATE "C") AS after_order
      FROM (SELECT DISTINCT ON (org, agent_id, final_name) * FROM delivered
            ORDER BY org, agent_id, final_name, idx) d
      GROUP BY org, agent_id
    )
    SELECT * FROM ranked WHERE before_order <> after_order ORDER BY org, agent_id
  LOOP
    RAISE NOTICE 'workspace skill backfill: reordered org=% agent=% from % to %',
      report.org, report.agent_id, report.before_order, report.after_order;
  END LOOP;

  DROP TABLE skill_backfill_items, skill_backfill_norm, skill_backfill_tuples;
END
$backfill$;

-- 2. skill_config policies (fail closed: nothing gets weaker). Only
-- organizations with no skill_config rule yet are processed, so a re-run is a
-- no-op.
--   Step 1: every agent_config rule becomes a candidate for the same subject.
--     skill_config has no target scope, so a rule that targets one agent widens
--     to the whole workspace; each widened rule is reported.
--   Step 2: candidates sharing a policy identity merge; per action the most
--     restrictive effect wins (the entity-policy fold), and an action no rule
--     sets stays unset.
--   Step 3: read and update carry over; create is the stricter of create and
--     update; delete is the stricter of delete and update.
DO $policies$
DECLARE
  report record;
BEGIN
  FOR report IN
    SELECT p.organization_id, p.id, p.principal_kind, p.principal_id, p.target_agent_id
    FROM write_approval_policies p
    WHERE p.resource_class = 'agent_config'
      AND p.target_agent_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM write_approval_policies s
        WHERE s.organization_id = p.organization_id AND s.resource_class = 'skill_config'
      )
    ORDER BY p.organization_id, p.id
  LOOP
    RAISE NOTICE 'skill_config policy migration: agent_config rule % (org=% principal=%/%) targeted agent %; its skill_config rule applies workspace-wide',
      report.id, report.organization_id, COALESCE(report.principal_kind, '*'),
      COALESCE(report.principal_id, '*'), report.target_agent_id;
  END LOOP;

  CREATE TEMP TABLE skill_policy_groups  AS
  SELECT p.organization_id, p.principal_kind, p.principal_id, p.kind,
         min(p.id) AS source_id
  FROM write_approval_policies p
  WHERE p.resource_class = 'agent_config'
    AND NOT EXISTS (
      SELECT 1 FROM write_approval_policies s
      WHERE s.organization_id = p.organization_id AND s.resource_class = 'skill_config'
    )
  GROUP BY p.organization_id, p.principal_kind, p.principal_id, p.kind;

  -- Most restrictive stored effect per (group, old action).
  CREATE TEMP TABLE skill_policy_old_effects  AS
  SELECT g.source_id, e.action,
         (ARRAY['auto', 'log', 'check', 'approval', 'deny'])[
           max(array_position(ARRAY['auto', 'log', 'check', 'approval', 'deny'], e.effect))
         ] AS effect
  FROM skill_policy_groups g
  JOIN write_approval_policies p
    ON p.resource_class = 'agent_config'
   AND p.organization_id = g.organization_id
   AND p.principal_kind IS NOT DISTINCT FROM g.principal_kind
   AND p.principal_id IS NOT DISTINCT FROM g.principal_id
   AND p.kind = g.kind
  JOIN write_policy_action_effects e ON e.policy_id = p.id
  GROUP BY g.source_id, e.action;

  CREATE TEMP TABLE skill_policy_new_effects  AS
  SELECT source_id, action,
         (ARRAY['auto', 'log', 'check', 'approval', 'deny'])[
           max(array_position(ARRAY['auto', 'log', 'check', 'approval', 'deny'], effect))
         ] AS effect
  FROM (
    SELECT source_id, 'read' AS action, effect FROM skill_policy_old_effects WHERE action = 'read'
    UNION ALL
    SELECT source_id, 'update', effect FROM skill_policy_old_effects WHERE action = 'update'
    UNION ALL
    SELECT source_id, 'create', effect FROM skill_policy_old_effects WHERE action IN ('create', 'update')
    UNION ALL
    SELECT source_id, 'delete', effect FROM skill_policy_old_effects WHERE action IN ('delete', 'update')
  ) mapped
  GROUP BY source_id, action;

  CREATE TEMP TABLE skill_policy_inserted (source_id bigint, policy_id bigint);

  WITH inserted AS (
    INSERT INTO write_approval_policies
      (organization_id, resource_class, principal_kind, principal_id, kind, note,
       approval_connection_id, approval_channel_id, approval_team_id, approval_channel_name)
    SELECT src.organization_id, 'skill_config', src.principal_kind, src.principal_id, src.kind, src.note,
           src.approval_connection_id, src.approval_channel_id, src.approval_team_id, src.approval_channel_name
    FROM skill_policy_groups g
    JOIN write_approval_policies src ON src.id = g.source_id
    ORDER BY g.source_id
    ON CONFLICT DO NOTHING
    RETURNING id, organization_id, principal_kind, principal_id, kind
  )
  INSERT INTO skill_policy_inserted (source_id, policy_id)
  SELECT g.source_id, i.id
  FROM inserted i
  JOIN skill_policy_groups g
    ON g.organization_id = i.organization_id
   AND g.principal_kind IS NOT DISTINCT FROM i.principal_kind
   AND g.principal_id IS NOT DISTINCT FROM i.principal_id
   AND g.kind = i.kind;

  INSERT INTO write_policy_action_effects (policy_id, action, effect)
  SELECT i.policy_id, e.action, e.effect
  FROM skill_policy_inserted i
  JOIN skill_policy_new_effects e ON e.source_id = i.source_id
  ON CONFLICT DO NOTHING;

  DROP TABLE skill_policy_groups, skill_policy_old_effects, skill_policy_new_effects, skill_policy_inserted;
END
$policies$;

-- migrate:down

DELETE FROM write_approval_policies WHERE resource_class = 'skill_config';
-- The backfill's rows carry its deterministic ids; P3a adds no library writers.
DELETE FROM workspace_skills WHERE id ~ '^skill_[0-9a-f]{32}$';
